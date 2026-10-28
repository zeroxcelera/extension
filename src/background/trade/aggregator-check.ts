import { decodeFunctionResult, encodeFunctionData, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { erc20Abi } from '../chain/abis';
import type { Routed, Routing } from './routing';
import type { TaxService } from './tax';
import { buildTx, type VenueCtx } from './types';

/** How long a token's aggregator routes stay unused after one fell short. */
const DISTRUST_MS = 10 * 60_000;
/** How long a passed check holds before the route is simulated again. */
const PASSED_MS = 5 * 60_000;

/**
 * Tokens a buy through `route` delivers, simulated from a throwaway address (nothing is
 * signed or sent). 0 when the buy reverts even without a minimum; null when the node
 * cannot simulate.
 */
export async function simulatedBuyOut(
  ctx: VenueCtx,
  route: Routed,
  amountIn: bigint,
): Promise<bigint | null> {
  const probe = privateKeyToAccount(generatePrivateKey()).address;
  const deadline = BigInt(Math.floor(ctx.now() / 1000) + 600);
  const tx = await buildTx(route.venue, ctx, route.pool, 'buy', {
    wallet: probe,
    amountIn,
    minOut: 1n,
    deadline,
  });
  const sim = await ctx.client
    .simulateCalls({
      account: probe,
      stateOverrides: [{ address: probe, balance: amountIn + parseEther('1') }],
      calls: [
        tx,
        {
          to: route.pool.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [probe] }),
        },
      ],
    })
    .catch(() => null);
  if (!sim) return null;
  const [buy, balance] = sim.results;
  if (buy?.status !== 'success' || balance?.status !== 'success') return 0n;
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: balance.data });
}

/**
 * Aggregator quotes come from an outside API that can misjudge a pool on its route (a
 * hook, a fee it does not model) and then deliver far less than it quoted. Before Celera
 * prefers such a route over its own pools, the buy is simulated once per token and
 * compared with what the best own pool would really deliver (its quote minus the
 * measured transfer tax). When the aggregator comes out worse, its routes are dropped
 * for that token for a while (they stay available when no own pool can trade it).
 */
export class AggregatorCheck {
  private readonly passed = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly routing: Routing,
    private readonly tax: TaxService,
    private readonly simulate: typeof simulatedBuyOut = simulatedBuyOut,
  ) {}

  /** True when `route` may be used: not an aggregator, checked recently, or as good as quoted. */
  trusted(ctx: VenueCtx, route: Routed, amountIn: bigint): Promise<boolean> {
    if (!this.routing.isFallback(route.venue)) return Promise.resolve(true);
    const key = `${ctx.chain.id}:${route.pool.token.toLowerCase()}`;
    if (ctx.now() < (this.passed.get(key) ?? 0)) return Promise.resolve(true);
    let job = this.inflight.get(key);
    if (!job) {
      job = this.check(ctx, route, amountIn, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return job;
  }

  private async check(
    ctx: VenueCtx,
    route: Routed,
    amountIn: bigint,
    key: string,
  ): Promise<boolean> {
    const [own] = await this.routing
      .best(ctx, route.pool.token, 'buy', [amountIn], { own: true })
      .catch(() => [null]);
    // Only the aggregator trades it: nothing to compare with; the minimum output still guards.
    if (!own) return true;
    const [got, tax] = await Promise.all([
      this.simulate(ctx, route, amountIn).catch(() => null),
      this.tax.get(ctx, own, amountIn).catch(() => null),
    ]);
    // The node cannot simulate: inconclusive, the pre-sign checks still apply.
    if (got === null) return true;
    const taxBps = BigInt(tax?.transfer.buyBps ?? 0);
    const ownReal = (own.out * (10_000n - taxBps)) / 10_000n;
    if (got < ownReal) {
      this.routing.distrust(ctx, route.pool.token, DISTRUST_MS);
      return false;
    }
    this.passed.set(key, ctx.now() + PASSED_MS);
    return true;
  }
}
