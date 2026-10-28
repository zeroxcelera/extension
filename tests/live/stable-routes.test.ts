import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import { PERMIT_TYPES, buildPermit, permitDomain } from '../../src/background/trade/permit2';
import type { PoolRef, Venue, VenueCtx } from '../../src/background/trade/types';
import { UNISWAP } from '../../src/background/trade/uniswap/addresses';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { validateTx, type ValidationContext } from '../../src/background/trade/validator';
import { extraVenues, venueRules } from '../../src/background/trade/venues';
import { getChain } from '../../src/shared/chains';

/**
 * Tokens that only trade against a stablecoin: native → stable → token and back in one
 * transaction each. The validator must accept what the venue builds, then
 * eth_simulateV1 runs buy → approve → sell on mainnet state with a throwaway key.
 */
const pool = new ClientPool();
const VENUES: Venue[] = [uniswapVenue, ...extraVenues];

async function roundTrip(venueId: string, chainId: number, token: Address, amountIn: bigint) {
  const venue = VENUES.find((v) => v.id === venueId) as Venue;
  const chain = getChain(chainId)!;
  const ctx: VenueCtx = {
    chain,
    client: pool.get(chain),
    fetchJson: async (url) => (await fetch(url)).json(),
    now: Date.now,
  };
  const pools = (await venue.discover(ctx, token)).filter((p) => p.label.includes(' via '));
  expect(pools.length, `no stable-quoted ${venueId} pools`).toBeGreaterThan(0);
  const quotes = await Promise.all(pools.map((p) => venue.quote(ctx, p, 'buy', [amountIn])));
  const best = quotes.reduce((b, q, i) => ((q[0] ?? 0n) > (quotes[b]?.[0] ?? 0n) ? i : b), 0);
  const ref = pools[best] as PoolRef;
  const out = quotes[best]?.[0] ?? 0n;
  expect(out, `no quote on ${ref.label}`).toBeGreaterThan(0n);

  // Sell quote must exist too (token → stable → native).
  const [sellQuote] = await venue.quote(ctx, ref, 'sell', [out / 2n]);
  expect(sellQuote ?? 0n, 'no sell quote').toBeGreaterThan(0n);

  const account = privateKeyToAccount(generatePrivateKey());
  const nowS = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowS + 600);
  const minOut = (out * 90n) / 100n;
  const buy = venue.buildBuy(ctx, ref, { wallet: account.address, amountIn, minOut, deadline });
  const sellAmount = minOut / 2n;
  const { spender, router, viaPermit2 } = venue.sellApproval(ctx, ref);
  let permit;
  if (viaPermit2) {
    const p = buildPermit(token, router, sellAmount, 0, nowS);
    const signature: Hex = await account.signTypedData({
      domain: permitDomain(chainId),
      types: PERMIT_TYPES,
      primaryType: 'PermitSingle',
      message: p,
    });
    permit = { permit: p, signature };
  }
  const sell = venue.buildSell(ctx, ref, {
    wallet: account.address,
    amountIn: sellAmount,
    minOut: 1n,
    deadline,
    permit,
  });

  const vctx: ValidationContext = {
    chain,
    from: account.address,
    ownWallets: [account.address],
    token,
    router: UNISWAP[chainId]?.universalRouter,
    extraContracts: venueRules(chainId),
    maxValue: amountIn,
    maxApproval: sellAmount,
    maxPermit: sellAmount,
    nowS,
  };
  for (const tx of [buy, sell]) {
    const v = validateTx(tx, vctx);
    expect(v.ok, `${ref.label}: ${JSON.stringify(v.actions)}`).toBe(true);
  }

  const sim = await ctx.client.simulateCalls({
    account: account.address,
    stateOverrides: [{ address: account.address, balance: parseEther('10') }],
    calls: [
      { to: buy.to, data: buy.data, value: buy.value },
      {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, sellAmount],
        }),
      },
      { to: sell.to, data: sell.data, value: 0n },
    ],
  });
  return {
    label: ref.label,
    statuses: sim.results.map((r) => r.status),
    errors: sim.results.map((r) => (r.status === 'failure' ? r.error?.message?.slice(0, 300) : '')),
  };
}

const OK = ['success', 'success', 'success'];

describe('stable-quoted routes (mainnet simulation, no funds)', () => {
  it('Base: cbXRP / USDC on Uniswap v3', async () => {
    const r = await roundTrip(
      'uniswap',
      8453,
      '0xcb585250f852C6c6bf90434AB21A00f02833a4af',
      parseEther('0.002'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('Base: BSTONK / USDC on Uniswap v4', async () => {
    const r = await roundTrip(
      'uniswap',
      8453,
      '0x0F61Edbfe6Cd86024C0f210c0695B08df55fdfc9',
      parseEther('0.002'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('Base: Baseforever / USDC on Uniswap v2', async () => {
    const r = await roundTrip(
      'uniswap',
      8453,
      '0x2bdfFbD8bBaF20E511A73B8689312BFeC5098aE9',
      parseEther('0.002'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('Robinhood: CRCL / USDG on Uniswap', async () => {
    const r = await roundTrip(
      'uniswap',
      4663,
      '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5',
      parseEther('0.002'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('Arbitrum: ARB / USDC on Uniswap', async () => {
    const r = await roundTrip(
      'uniswap',
      42161,
      '0x912CE59144191C1204E64559FE8253a0e49E6548',
      parseEther('0.002'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('BSC: AGX / USD1 on PancakeSwap v2', async () => {
    const r = await roundTrip(
      'pancake-v2-bsc',
      56,
      '0xe766023f5a0fa6ce91b9f98D327771437DfcA077',
      parseEther('0.01'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('BSC: B / USD1 on PancakeSwap v3', async () => {
    const r = await roundTrip(
      'pancake-v3-bsc',
      56,
      '0x6bdcCe4A559076e37755a78Ce0c06214E59e4444',
      parseEther('0.01'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });

  it('Base: AERO via USDC on Aerodrome', async () => {
    const r = await roundTrip(
      'aerodrome-base',
      8453,
      '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      parseEther('0.002'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(OK);
  });
});
