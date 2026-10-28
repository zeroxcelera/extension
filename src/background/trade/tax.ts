import {
  decodeFunctionResult,
  encodeFunctionData,
  maxUint160,
  maxUint256,
  maxUint48,
  parseAbi,
  parseEther,
  type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, multicall3Abi } from '../chain/abis';
import { MULTICALL3 } from '../chain/client';
import type { Routed } from './routing';
import { buildTx, type PoolRef, type Venue, type VenueCtx } from './types';
import { PERMIT2 } from './uniswap/addresses';

/** Taxes in basis points. `null`: could not be measured. */
export interface TaxInfo {
  /** Taken by the token contract on transfer. Not in pool quotes, so minimum outputs allow for it. */
  transfer: { buyBps: number; sellBps: number | null };
  /** Charged by the venue itself (e.g. a launchpad fee and creator tax). Already in quotes. */
  venue: { buyBps: number; sellBps: number };
  /**
   * Rates the token contract declares (e.g. Flap tax tokens). Some are taken inside the
   * launchpad's swap, where a simulation cannot tell them from the price, so they count
   * when higher than what was measured.
   */
  declared?: { buyBps: number; sellBps: number } | undefined;
  /** The simulated sell reverted: selling may be blocked (honeypot, cooldown, anti-bot). */
  sellFails: boolean;
}

export const totalBuyBps = (t: TaxInfo) =>
  Math.max(t.transfer.buyBps, t.declared?.buyBps ?? 0) + t.venue.buyBps;
export const totalSellBps = (t: TaxInfo) => {
  const token =
    t.transfer.sellBps === null
      ? (t.declared?.sellBps ?? null)
      : Math.max(t.transfer.sellBps, t.declared?.sellBps ?? 0);
  return token === null ? null : token + t.venue.sellBps;
};

/** Why a buy is refused under `maxBps` (10 000 = no limit), or null. */
export function taxRefusal(t: TaxInfo | null, maxBps: number): string | null {
  if (!t || maxBps >= 10_000) return null;
  if (t.sellFails) return 'Selling this token failed in simulation.';
  const buy = totalBuyBps(t);
  const sell = totalSellBps(t) ?? 0;
  if (Math.max(buy, sell) <= maxBps) return null;
  return `Tax ${fmt(buy)} buy / ${fmt(sell)} sell, max ${fmt(maxBps)}.`;
}

const fmt = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export const UNKNOWN_TAX =
  'Token tax could not be measured (the RPC may not simulate). Set Max tax to Off to buy anyway.';

/**
 * taxRefusal, failing closed: with Max tax on, a token whose tax could not be measured is
 * refused too, unless it cannot be measured by design (`measurable` false: a funded curve).
 */
export function taxGate(t: TaxInfo | null, maxBps: number, measurable: boolean): string | null {
  if (maxBps >= 10_000) return null;
  if (t === null) return measurable ? UNKNOWN_TAX : null;
  return taxRefusal(t, maxBps);
}

/** Flap tax tokens (V3): current rates, in basis points. */
const declaredTaxAbi = parseAbi([
  'function getPoolStateData() view returns (uint8 state, uint16 buyTaxRate, uint16 sellTaxRate, uint256 liquidationThreshold, uint256 taxExpirationTime, uint256 antiFarmerExpirationTime)',
]);

/** The token's own declared rates, when it exposes a known getter. */
async function declaredTax(
  ctx: VenueCtx,
  token: Address,
): Promise<{ buyBps: number; sellBps: number } | undefined> {
  const r = await ctx.client
    .readContract({ address: token, abi: declaredTaxAbi, functionName: 'getPoolStateData' })
    .catch(() => null);
  if (!r) return undefined;
  const [, buy, sell] = r;
  if (buy > 10_000 || sell > 10_000) return undefined;
  return { buyBps: buy, sellBps: sell };
}

const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

/** 1 - got / expected, in basis points, clamped to 0..10 000. */
function lossBps(got: bigint, expected: bigint): number {
  if (expected <= 0n) return 0;
  const kept = Number((got * 10_000n) / expected);
  return Math.min(10_000, Math.max(0, 10_000 - kept));
}

/**
 * Buys then sells `amountIn` from a throwaway address in one eth_simulateV1 call (nothing
 * is signed or sent) and compares what arrives with the pool's own quotes. Half of the
 * quoted tokens are sold, so a buy tax below 50% still leaves enough to sell.
 */
export async function probeTax(
  ctx: VenueCtx,
  venue: Venue,
  pool: PoolRef,
  amountIn: bigint,
  quotedOut: bigint,
): Promise<TaxInfo | null> {
  const probe = privateKeyToAccount(generatePrivateKey()).address;
  const half = quotedOut / 2n;
  if (half === 0n) return null;
  const deadline = BigInt(Math.floor(ctx.now() / 1000) + 600);
  const approval = venue.sellApproval(ctx, pool);
  const token = pool.token;
  const ethBalance = {
    to: MULTICALL3,
    data: encodeFunctionData({ abi: multicall3Abi, functionName: 'getEthBalance', args: [probe] }),
  };
  const [buyTx, sellTx] = await Promise.all([
    buildTx(venue, ctx, pool, 'buy', { wallet: probe, amountIn, minOut: 1n, deadline }),
    buildTx(venue, ctx, pool, 'sell', { wallet: probe, amountIn: half, minOut: 1n, deadline }),
  ]);
  const calls = [
    buyTx,
    {
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [probe] }),
    },
    {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [approval.spender, maxUint256],
      }),
    },
    ...(approval.viaPermit2
      ? [
          {
            to: PERMIT2,
            data: encodeFunctionData({
              abi: permit2Abi,
              functionName: 'approve',
              args: [token, approval.router, maxUint160, Number(maxUint48)],
            }),
          },
        ]
      : []),
    ethBalance,
    sellTx,
    ethBalance,
  ];
  const [sim, sellQuote, venueTax, declared] = await Promise.all([
    ctx.client.simulateCalls({
      account: probe,
      stateOverrides: [{ address: probe, balance: amountIn + parseEther('1') }],
      calls,
    }),
    venue.quote(ctx, pool, 'sell', [half]).then(([q]) => q ?? null),
    venue.venueTax?.(ctx, pool) ?? Promise.resolve({ buyBps: 0, sellBps: 0 }),
    declaredTax(ctx, token),
  ]);
  const r = sim.results;
  const n = r.length;
  if (r[0]?.status !== 'success' || r[1]?.status !== 'success') return null;
  const received = decodeFunctionResult({
    abi: erc20Abi,
    functionName: 'balanceOf',
    data: r[1].data,
  });
  const buyBps = lossBps(received, quotedOut);
  const sell = r[n - 2];
  const before = r[n - 3];
  const after = r[n - 1];
  // Too few tokens arrived to sell half: the buy tax alone already says enough.
  if (received < half)
    return { transfer: { buyBps, sellBps: null }, venue: venueTax, declared, sellFails: false };
  if (sell?.status !== 'success')
    return { transfer: { buyBps, sellBps: null }, venue: venueTax, declared, sellFails: true };
  let sellBps: number | null = null;
  if (sellQuote && before?.status === 'success' && after?.status === 'success') {
    const decode = (data: `0x${string}`) =>
      decodeFunctionResult({ abi: multicall3Abi, functionName: 'getEthBalance', data });
    sellBps = lossBps(decode(after.data) - decode(before.data), sellQuote);
  }
  return { transfer: { buyBps, sellBps }, venue: venueTax, declared, sellFails: false };
}

const TTL_MS = 5 * 60_000;
/** Below this, rounding in the pool math reads as tax. */
const NOISE_BPS = 10;

/** What TaxService needs from routing to measure an aggregator-routed token on its own pools. */
export interface TaxRouting {
  isFallback(venue: Venue): boolean;
  best(
    ctx: VenueCtx,
    token: Address,
    side: 'buy',
    amounts: readonly bigint[],
    opts: { own: true },
  ): Promise<(Routed | null)[]>;
}

type Probe = typeof probeTax;

/**
 * Cached probes per (chain, token, pool). Owners can change taxes, so entries expire.
 *
 * Aggregator routes are never probed themselves: a fill that falls short of the
 * aggregator's quote is the route's fault (a pool it misjudged), not a token tax, and
 * reading it as tax would loosen the minimum output by the shortfall. Their tax is the
 * one measured on Celera's own best pool for the token; with no such pool it is unknown.
 */
export class TaxService {
  private readonly cache = new Map<string, { at: number; info: TaxInfo | null }>();
  private readonly inflight = new Map<string, Promise<TaxInfo | null>>();
  /** Aggregator-routed token → the cache key of the own pool it was measured on. */
  private readonly measuredOn = new Map<string, string>();

  constructor(
    private readonly routing?: TaxRouting,
    private readonly probe: Probe = probeTax,
  ) {}

  private key(chainId: number, token: Address, poolId: string) {
    return `${chainId}:${token.toLowerCase()}:${poolId}`;
  }

  private isAggregator(route: Routed): boolean {
    return !!this.routing?.isFallback(route.venue);
  }

  /** The last result: undefined when never probed (or expired), null when it failed. */
  peek(ctx: VenueCtx, route: Routed): TaxInfo | null | undefined {
    const key = this.isAggregator(route)
      ? this.measuredOn.get(`${ctx.chain.id}:${route.pool.token.toLowerCase()}`)
      : this.key(ctx.chain.id, route.pool.token, route.pool.id);
    const hit = key === undefined ? undefined : this.cache.get(key);
    if (!hit || ctx.now() - hit.at >= TTL_MS) return undefined;
    return this.isAggregator(route) ? viaAggregator(hit.info) : hit.info;
  }

  /** Cached, or probed now with `route.out` as the quote for `amountIn`. */
  async get(ctx: VenueCtx, route: Routed, amountIn: bigint): Promise<TaxInfo | null> {
    // A funded pool (e.g. Virtuals) cannot be bought with native in one call: no probe.
    if (route.venue.funding?.(ctx, route.pool)) return null;
    const known = this.peek(ctx, route);
    if (known !== undefined) return known;
    if (this.isAggregator(route)) {
      const tokenKey = `${ctx.chain.id}:${route.pool.token.toLowerCase()}`;
      const [own] = await (this.routing as TaxRouting)
        .best(ctx, route.pool.token, 'buy', [amountIn], { own: true })
        .catch(() => [null]);
      if (!own) {
        // Only the aggregator trades it: unknown, remembered like a failed probe.
        this.cache.set(`none:${tokenKey}`, { at: ctx.now(), info: null });
        this.measuredOn.set(tokenKey, `none:${tokenKey}`);
        return null;
      }
      const info = await this.get(ctx, own, amountIn);
      this.measuredOn.set(tokenKey, this.key(ctx.chain.id, own.pool.token, own.pool.id));
      return viaAggregator(info);
    }
    const key = this.key(ctx.chain.id, route.pool.token, route.pool.id);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.probe(ctx, route.venue, route.pool, amountIn, route.out)
        .then(denoise)
        .catch(() => null)
        .then((info) => {
          this.cache.set(key, { at: ctx.now(), info });
          this.inflight.delete(key);
          return info;
        });
      this.inflight.set(key, p);
    }
    return p;
  }
}

/** A token's tax as seen through an aggregator: its own pools' launchpad fees do not apply. */
function viaAggregator(info: TaxInfo | null): TaxInfo | null {
  return info && { ...info, venue: { buyBps: 0, sellBps: 0 } };
}

function denoise(t: TaxInfo | null): TaxInfo | null {
  if (!t) return t;
  const clean = (bps: number) => (bps < NOISE_BPS ? 0 : bps);
  return {
    ...t,
    transfer: {
      buyBps: clean(t.transfer.buyBps),
      sellBps: t.transfer.sellBps === null ? null : clean(t.transfer.sellBps),
    },
  };
}
