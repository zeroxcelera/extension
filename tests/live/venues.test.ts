import { encodeFunctionData, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import type { Venue, VenueCtx } from '../../src/background/trade/types';
import { validateTx } from '../../src/background/trade/validator';
import { extraVenues, venueRules } from '../../src/background/trade/venues';
import { getChain } from '../../src/shared/chains';

/** Router-approval venues: buy → approve(router) → sell, simulated on mainnet state. */
const pool = new ClientPool();

async function roundTrip(venueId: string, chainId: number, token: Address, amountIn: bigint) {
  const venue = extraVenues.find((v) => v.id === venueId) as Venue;
  const chain = getChain(chainId)!;
  const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
  const pools = await venue.discover(ctx, token);
  expect(pools.length, `no ${venueId} pools`).toBeGreaterThan(0);
  const quotes = await Promise.all(pools.map((p) => venue.quote(ctx, p, 'buy', [amountIn])));
  const best = quotes.reduce((b, q, i) => ((q[0] ?? 0n) > (quotes[b]?.[0] ?? 0n) ? i : b), 0);
  const ref = pools[best]!;
  const out = quotes[best]?.[0] ?? 0n;
  expect(out).toBeGreaterThan(0n);

  const account = privateKeyToAccount(generatePrivateKey());
  const nowS = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowS + 600);
  const minOut = (out * 85n) / 100n; // generous: tax tokens
  const buy = venue.buildBuy(ctx, ref, { wallet: account.address, amountIn, minOut, deadline });
  const sellAmount = minOut / 2n;
  const sell = venue.buildSell(ctx, ref, {
    wallet: account.address,
    amountIn: sellAmount,
    minOut: 1n,
    deadline,
  });
  const { spender } = venue.sellApproval(ctx, ref);

  // The validator must accept exactly what the venue builds.
  const vctx = {
    chain,
    from: account.address,
    ownWallets: [account.address],
    token,
    extraContracts: venueRules(chainId),
    maxValue: amountIn,
    maxApproval: sellAmount,
    nowS,
  };
  expect(validateTx(buy, vctx).ok, JSON.stringify(validateTx(buy, vctx).actions)).toBe(true);
  expect(validateTx(sell, vctx).ok, JSON.stringify(validateTx(sell, vctx).actions)).toBe(true);

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
    errors: sim.results.map((r) => (r.status === 'failure' ? r.error?.message?.slice(0, 200) : '')),
  };
}

describe('router venues round trip (mainnet simulation, no funds)', () => {
  it('BSC: CAKE via PancakeSwap v2', async () => {
    const r = await roundTrip(
      'pancake-v2-bsc',
      56,
      '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      parseEther('0.01'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('BSC: CAKE via PancakeSwap v3', async () => {
    const r = await roundTrip(
      'pancake-v3-bsc',
      56,
      '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      parseEther('0.01'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Base: AERO via Aerodrome', async () => {
    const r = await roundTrip(
      'aerodrome-base',
      8453,
      '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      parseEther('0.001'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });
});
