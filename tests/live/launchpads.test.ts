import { encodeFunctionData, maxUint256, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { Routing } from '../../src/background/trade/routing';
import type { TxDraft, Venue, VenueCtx } from '../../src/background/trade/types';
import { UNISWAP } from '../../src/background/trade/uniswap/addresses';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues, venueRules } from '../../src/background/trade/venues';
import { validateTx, type ValidationContext } from '../../src/background/trade/validator';
import { getChain } from '../../src/shared/chains';

/**
 * Curve tokens graduate quickly, so these tests pick live candidates at run time and
 * skip (not fail) when none is still on its curve.
 */
const pool = new ClientPool();

async function roundTrip(
  venueId: string,
  chainId: number,
  candidates: Address[],
  amountIn: bigint,
) {
  const venue = launchpadVenues.find((v) => v.id === venueId) as Venue;
  const chain = getChain(chainId)!;
  const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
  for (const token of candidates) {
    const [ref] = await venue.discover(ctx, token);
    if (!ref) continue;
    const [out] = await venue.quote(ctx, ref, 'buy', [amountIn]);
    if (!out) continue;

    const account = privateKeyToAccount(generatePrivateKey());
    const nowS = Math.floor(Date.now() / 1000);
    const deadline = BigInt(nowS + 600);
    const minOut = (out * 80n) / 100n;
    const buy = venue.buildBuy(ctx, ref, { wallet: account.address, amountIn, minOut, deadline });
    const sellAmount = minOut / 2n;
    const sell = venue.buildSell(ctx, ref, {
      wallet: account.address,
      amountIn: sellAmount,
      minOut: 1n,
      deadline,
    });
    const { spender } = venue.sellApproval(ctx, ref);
    const rules = new Map(
      (venue.poolRules?.(ctx, ref) ?? []).map(([a, r]) => [a.toLowerCase(), r]),
    );
    const vctx = {
      chain,
      from: account.address,
      ownWallets: [account.address],
      token,
      extraContracts: rules,
      maxValue: amountIn,
      maxApproval: sellAmount,
      nowS,
    };
    const approve = {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, sellAmount],
      }),
      value: 0n,
    };
    for (const tx of [buy, approve, sell]) {
      const v = validateTx(tx, vctx);
      expect(v.ok, JSON.stringify(v.actions)).toBe(true);
    }
    const sim = await ctx.client.simulateCalls({
      account: account.address,
      stateOverrides: [{ address: account.address, balance: parseEther('10') }],
      calls: [buy, approve, sell],
    });
    return {
      token,
      out: out.toString(),
      statuses: sim.results.map((r) => r.status),
      errors: sim.results.map((r) =>
        r.status === 'failure' ? r.error?.message?.slice(0, 200) : '',
      ),
    };
  }
  return null;
}

describe('launchpad curves round trip (mainnet simulation, no funds)', () => {
  it('four.meme (BSC)', async (t) => {
    const r = await roundTrip(
      'fourmeme',
      56,
      [
        '0x08cc053e6c0c7bdb2f32cbc25d34542fc38c4444',
        '0xc372c38e378006023d1f99763a4c3da3a904ffff',
        '0x46f5dC6809Fa0d9647739C22FbFF5f61CD9AFfff',
      ],
      parseEther('0.01'),
    );
    if (!r) return t.skip();
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('four.meme quoted in a BEP-20: one call through its helper (BSC)', async (t) => {
    const r = await roundTrip(
      'fourmeme',
      56,
      [
        '0xAa7291fB6d5db0b0018c8974590EC65DcdbD4444', // USDT
        '0xE951E321da31a7A067EB3c6f63d6F7c2CAe44444', // USD1
        '0x30D597f1335bFF2eE010A04b0C0159fc6780FfFf', // QQQB (tokenised stock)
      ],
      parseEther('0.01'),
    );
    if (!r) return t.skip();
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Flap (BSC)', async (t) => {
    const r = await roundTrip(
      'flap',
      56,
      ['0xc6106ce509d7bfae9fa754fe0ab390e02db67777', '0xda793b2c75366ed52415a517d8d3193f2f007777'],
      parseEther('0.001'),
    );
    if (!r) return t.skip();
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Pons (Robinhood)', async (t) => {
    const r = await roundTrip(
      'pons',
      4663,
      [
        // Recent native-quoted launches (TokenLaunched with pairToken = 0).
        '0x06ae6770ae7b71a991e9e293db62f499e89fb169',
        '0xc693d6b6d23f9dec281e8116f96da93f4f9c4a28',
        '0x07b020d25c9e4deceb87b759b2d5a5fb93be7a65',
        '0xc62abbf8b585ea9c78d250412d28ede32cb77685',
        '0xea0071a8778fa02c12378e88868255e0e0952be6',
        '0xd0ff6d6fa0228f03d09f74ebce557726d2d4ee77',
        '0x385f4f8ae47651ce5f58f5265395a669f8281e18',
        '0xbf6bd9aa3e6a5ddac553527dec7e671ac0f41e18',
      ],
      parseEther('0.0005'),
    );
    if (!r) return t.skip();
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });
});

/**
 * Without a Celera Router on the chain, a curve quoted in an ERC-20 the launchpad cannot
 * buy with native runs as separate transactions: native → asset, approve, curve buy, and
 * back. Each is validated as the engine does, then all are simulated in order.
 */
async function fundedRoundTrip(chainId: number, token: Address, venueId: string, eth: bigint) {
  const chain = getChain(chainId)!;
  const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
  const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues]);
  const [route] = await routing.best(ctx, token, 'buy', [eth]);
  if (!route || route.venue.id !== venueId) return null;
  const funding = route.venue.funding?.(ctx, route.pool);
  expect(funding).toBeTruthy();
  const legVenue = routing.venue(funding!.leg.venueId)!;
  const user = privateKeyToAccount(generatePrivateKey());
  const nowS = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowS + 600);
  const rules = (venue: Venue, ref: typeof route.pool) => {
    const m = new Map(venueRules(chainId));
    for (const [a, r] of venue.poolRules?.(ctx, ref) ?? []) m.set(a.toLowerCase(), r);
    return m;
  };
  const check = (tx: TxDraft, c: Partial<ValidationContext>) => {
    const v = validateTx(tx, {
      chain,
      from: user.address,
      ownWallets: [user.address],
      router: UNISWAP[chainId]?.universalRouter,
      maxValue: eth,
      maxApproval: maxUint256,
      nowS,
      ...c,
    });
    expect(v.ok, JSON.stringify(v.actions.filter((a) => !a.ok))).toBe(true);
  };
  const approve = (asset: Address, spender: Address): TxDraft => ({
    to: asset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, maxUint256],
    }),
    value: 0n,
  });

  const [assetOut] = await legVenue.quote(ctx, funding!.leg, 'buy', [eth]);
  const fund = legVenue.buildBuy(ctx, funding!.leg, {
    wallet: user.address,
    amountIn: eth,
    minOut: (assetOut! * 95n) / 100n,
    deadline,
  });
  check(fund, { token: funding!.asset, extraContracts: rules(legVenue, funding!.leg) });
  const { spender } = route.venue.sellApproval(ctx, route.pool);
  const curveRules = rules(route.venue, route.pool);
  const approveAsset = approve(funding!.asset, spender);
  check(approveAsset, { token: funding!.asset, extraContracts: curveRules, maxValue: 0n });
  // Slightly less than the leg delivers, as the exact amount is only known after it lands.
  const spend = (assetOut! * 95n) / 100n;
  const [tokens] = await funding!.quoteAsset(ctx, 'buy', [spend]);
  const buy = route.venue.buildBuy(ctx, route.pool, {
    wallet: user.address,
    amountIn: spend,
    minOut: (tokens! * 90n) / 100n,
    deadline,
  });
  check(buy, { token, extraContracts: curveRules, maxValue: 0n });
  const approveToken = approve(token, spender);
  check(approveToken, { token, extraContracts: curveRules, maxValue: 0n });
  const sell = route.venue.buildSell(ctx, route.pool, {
    wallet: user.address,
    amountIn: (tokens! * 80n) / 100n,
    minOut: 1n,
    deadline,
  });
  check(sell, { token, extraContracts: curveRules, maxValue: 0n });

  const sim = await ctx.client.simulateCalls({
    account: user.address,
    stateOverrides: [{ address: user.address, balance: parseEther('1') }],
    calls: [fund, approveAsset, buy, approveToken, sell],
  });
  return sim.results.map((r) =>
    r.status === 'success' ? 'success' : r.error?.message?.slice(0, 160),
  );
}

describe('curves quoted in an ERC-20, without the router (mainnet simulation, no funds)', () => {
  it('Flap quoted in PEPE (BSC), through PancakeSwap', async (t) => {
    const r = await fundedRoundTrip(
      56,
      '0x2CC05d18F221eaD699866791B66B23937a697777',
      'flap',
      parseEther('0.01'),
    );
    if (!r) return t.skip();
    expect(r).toEqual(Array(5).fill('success'));
  });

  it('Pons quoted in USDG (Robinhood), through Uniswap', async (t) => {
    const r = await fundedRoundTrip(
      4663,
      '0x227642e8A9dFb94873EeE4e316af9cE06659FCEd',
      'pons',
      parseEther('0.002'),
    );
    if (!r) return t.skip();
    expect(r).toEqual(Array(5).fill('success'));
  });
});
