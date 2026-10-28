import {
  encodeFunctionData,
  maxUint160,
  maxUint256,
  maxUint48,
  parseAbi,
  parseEther,
  type Address,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { Routing } from '../../src/background/trade/routing';
import type { TxDraft, Venue, VenueCtx } from '../../src/background/trade/types';
import { PERMIT2, UNISWAP } from '../../src/background/trade/uniswap/addresses';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues } from '../../src/background/trade/venues';
import { validateTx, type ValidationContext } from '../../src/background/trade/validator';
import { getChain } from '../../src/shared/chains';

const chain = getChain(8453)!;
const ctx: VenueCtx = {
  chain,
  client: new ClientPool().get(chain),
  now: Date.now,
  fetchJson: (u) => fetch(u).then((r) => r.json()),
};
const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues]);
const ME = '0x00000000000000000000000000000000000c0ffe' as Address;
const router = UNISWAP[8453]!.universalRouter;
const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const bondingAbi = parseAbi(['function tokenInfos(uint256) view returns (address)']);
const BONDING = '0x1a540088125d00dd3990f9da45ca0859af4d3b01' as Address;

function vctx(token: Address, venue: Venue, extra: Partial<ValidationContext> = {}) {
  return {
    chain,
    from: ME,
    ownWallets: [ME],
    token,
    router,
    maxValue: parseEther('1'),
    nowS: Math.floor(Date.now() / 1000),
    extraContracts: new Map(
      (venue.poolRules?.(ctx, {} as never) ?? []).map(([a, r]) => [a.toLowerCase(), r]),
    ),
    ...extra,
  } satisfies ValidationContext;
}

function expectValid(tx: TxDraft, c: ValidationContext) {
  const v = validateTx(tx, c);
  expect(v.ok, JSON.stringify(v.actions.filter((a) => !a.ok))).toBe(true);
}

/** The newest token on the curve that is still trading there. */
async function liveCurveToken(): Promise<Address | null> {
  let lo = 0n;
  let hi = 1n << 20n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const ok = await ctx.client
      .readContract({ address: BONDING, abi: bondingAbi, functionName: 'tokenInfos', args: [mid] })
      .then(() => true)
      .catch(() => false);
    if (ok) lo = mid;
    else hi = mid;
  }
  for (let i = lo; i > lo - 10n; i--) {
    const t = await ctx.client.readContract({
      address: BONDING,
      abi: bondingAbi,
      functionName: 'tokenInfos',
      args: [i],
    });
    if ((await routing.discover(ctx, t, true)).some((p) => p.venueId === 'virtuals')) return t;
  }
  return null;
}

describe('Virtuals curve and Flaunch (Base mainnet simulation, no funds)', () => {
  it('Virtuals: ETH → VIRTUAL → curve buy, then curve sell → VIRTUAL → ETH', async (t) => {
    const token = await liveCurveToken();
    if (!token) return t.skip();
    const eth = parseEther('0.002');
    const [route] = await routing.best(ctx, token, 'buy', [eth]);
    expect(route?.venue.id).toBe('virtuals');
    const venue = route!.venue;
    const funding = venue.funding!(ctx, route!.pool)!;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // The transactions the engine sends, each checked by the validator.
    const [assetOut] = await uniswapVenue.quote(ctx, funding.leg, 'buy', [eth]);
    const fund = uniswapVenue.buildBuy(ctx, funding.leg, {
      wallet: ME,
      amountIn: eth,
      minOut: (assetOut! * 99n) / 100n,
      deadline,
    });
    expectValid(fund, vctx(funding.asset, uniswapVenue));
    const { spender } = venue.sellApproval(ctx, route!.pool);
    const approveAsset = {
      to: funding.asset,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
      }),
      value: 0n,
    };
    expectValid(approveAsset, vctx(funding.asset, venue, { maxApproval: maxUint256 }));

    // Fund first to learn the exact VIRTUAL amount, as the engine waits for the receipt.
    const first = await ctx.client.simulateCalls({
      account: ME,
      stateOverrides: [{ address: ME, balance: parseEther('1') }],
      calls: [fund],
    });
    expect(first.results[0]?.status).toBe('success');
    const got = (assetOut! * 99n) / 100n;
    const [tokOut] = await funding.quoteAsset(ctx, 'buy', [got]);
    const buy = venue.buildBuy(ctx, route!.pool, {
      wallet: ME,
      amountIn: got,
      minOut: (tokOut! * 90n) / 100n,
      deadline,
    });
    expectValid(buy, vctx(token, venue, { maxValue: 0n }));
    const approveToken = {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
      }),
      value: 0n,
    };
    expectValid(approveToken, vctx(token, venue, { maxApproval: maxUint256 }));
    const sellAmount = tokOut! / 2n;
    const [assetBack] = await funding.quoteAsset(ctx, 'sell', [sellAmount]);
    const sell = venue.buildSell(ctx, route!.pool, {
      wallet: ME,
      amountIn: sellAmount,
      minOut: (assetBack! * 90n) / 100n,
      deadline,
    });
    expectValid(sell, vctx(token, venue, { maxValue: 0n }));
    const back = uniswapVenue.buildSell(ctx, funding.leg, {
      wallet: ME,
      amountIn: (assetBack! * 90n) / 100n,
      minOut: 1n,
      deadline,
    });
    expectValid(back, vctx(funding.asset, uniswapVenue, { maxValue: 0n }));

    const sim = await ctx.client.simulateCalls({
      account: ME,
      stateOverrides: [{ address: ME, balance: parseEther('1') }],
      calls: [
        fund,
        approveAsset,
        buy,
        approveToken,
        sell,
        {
          to: funding.asset,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [PERMIT2, maxUint256],
          }),
        },
        {
          to: PERMIT2,
          data: encodeFunctionData({
            abi: permit2Abi,
            functionName: 'approve',
            args: [funding.asset, router, maxUint160, Number(maxUint48)],
          }),
        },
        back,
      ],
    });
    expect(
      sim.results.map((r) => r.status),
      JSON.stringify(sim.results.map((r) => r.error?.message?.slice(0, 160))),
    ).toEqual(Array(8).fill('success'));
  }, 120_000);

  it('Flaunch: native → flETH → coin in one transaction, and back', async () => {
    const token = '0xe2f9db0186b13668aec9fe0e15dbd13004ed8d6f' as Address;
    const eth = parseEther('0.0005');
    const [route] = await routing.best(ctx, token, 'buy', [eth]);
    expect(route?.pool.label).toMatch(/via flETH/);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const buy = route!.venue.buildBuy(ctx, route!.pool, {
      wallet: ME,
      amountIn: eth,
      minOut: (route!.out * 90n) / 100n,
      deadline,
    });
    expectValid(buy, vctx(token, uniswapVenue));
    const sell = route!.venue.buildSell(ctx, route!.pool, {
      wallet: ME,
      amountIn: route!.out / 2n,
      minOut: 1n,
      deadline,
    });
    expectValid(sell, vctx(token, uniswapVenue, { maxValue: 0n }));
    const sim = await ctx.client.simulateCalls({
      account: ME,
      stateOverrides: [{ address: ME, balance: parseEther('1') }],
      calls: [
        buy,
        {
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [PERMIT2, maxUint256],
          }),
        },
        {
          to: PERMIT2,
          data: encodeFunctionData({
            abi: permit2Abi,
            functionName: 'approve',
            args: [token, router, maxUint160, Number(maxUint48)],
          }),
        },
        sell,
      ],
    });
    expect(
      sim.results.map((r) => r.status),
      JSON.stringify(sim.results.map((r) => r.error?.message?.slice(0, 160))),
    ).toEqual(Array(4).fill('success'));
  }, 120_000);
});
