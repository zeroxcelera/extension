import { encodeFunctionData, parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import { kyberVenue } from '../../src/background/trade/kyber';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { Routing } from '../../src/background/trade/routing';
import { buildTx, type VenueCtx } from '../../src/background/trade/types';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { validateTx } from '../../src/background/trade/validator';
import { extraVenues } from '../../src/background/trade/venues';
import { getChain } from '../../src/shared/chains';

const json = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  return r.ok ? r.json() : null;
};
const aggregator = {
  get: (url: string) => json(url, { headers: { 'x-client-id': 'celera' } }),
  post: (url: string, body: unknown) =>
    json(url, {
      method: 'POST',
      headers: { 'x-client-id': 'celera', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
};
const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues], [kyberVenue]);
const ME = '0x00000000000000000000000000000000000c0ffe' as Address;

describe('KyberSwap fallback (mainnet simulation, no funds)', () => {
  it('routes a token no listed pool can trade, and the swap validates and simulates', async (t) => {
    const chain = getChain(8453)!;
    const ctx: VenueCtx = { chain, client: new ClientPool().get(chain), now: Date.now, aggregator };
    // wtSPYM: its only pool is on Hydrex, which Celera does not list.
    const token = '0x31c2c14134e6e3b7ef9478297f199331133fc2d8' as Address;
    const eth = parseEther('0.002');
    const [route] = await routing.best(ctx, token, 'buy', [eth]);
    if (!route) return t.skip();
    expect(route.venue.id).toBe('kyber');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const buy = await buildTx(route.venue, ctx, route.pool, 'buy', {
      wallet: ME,
      amountIn: eth,
      minOut: (route.out * 95n) / 100n,
      deadline,
    });
    const vctx = {
      chain,
      from: ME,
      ownWallets: [ME],
      token,
      maxValue: parseEther('1'),
      nowS: Math.floor(Date.now() / 1000),
      extraContracts: new Map(
        kyberVenue.poolRules!(ctx, route.pool).map(([a, r]) => [a.toLowerCase(), r]),
      ),
    };
    const v = validateTx(buy, vctx);
    expect(v.ok, JSON.stringify(v.actions)).toBe(true);
    const sim = await ctx.client.simulateCalls({
      account: ME,
      stateOverrides: [{ address: ME, balance: parseEther('1') }],
      calls: [
        buy,
        {
          to: token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ME] }),
        },
      ],
    });
    expect(sim.results[0]?.status, sim.results[0]?.error?.message?.slice(0, 200)).toBe('success');

    // Sell half of what arrived: exact approval to the router, then the router's swap.
    const got = sim.results[1]?.status === 'success' ? BigInt(sim.results[1].data) : 0n;
    expect(got).toBeGreaterThan(0n);
    const half = got / 2n;
    const [ethOut] = await kyberVenue.quote(ctx, route.pool, 'sell', [half]);
    const sell = await buildTx(route.venue, ctx, route.pool, 'sell', {
      wallet: ME,
      amountIn: half,
      minOut: ((ethOut ?? 0n) * 90n) / 100n,
      deadline,
    });
    const sellCheck = validateTx(sell, { ...vctx, maxValue: 0n });
    expect(sellCheck.ok, JSON.stringify(sellCheck.actions)).toBe(true);
    const approve = {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [kyberVenue.sellApproval(ctx, route.pool).spender, half],
      }),
      value: 0n,
    };
    const approveCheck = validateTx(approve, { ...vctx, maxValue: 0n, maxApproval: half });
    expect(approveCheck.ok, JSON.stringify(approveCheck.actions)).toBe(true);
    const round = await ctx.client.simulateCalls({
      account: ME,
      stateOverrides: [{ address: ME, balance: parseEther('1') }],
      calls: [buy, approve, sell],
    });
    expect(
      round.results.map((r) => r.status),
      JSON.stringify(round.results.map((r) => r.error?.message?.slice(0, 200))),
    ).toEqual(['success', 'success', 'success']);
  }, 60_000);
});
