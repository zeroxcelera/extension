import { formatUnits, parseEther } from 'viem';
import type { Routing } from './routing';
import type { VenueCtx } from './types';

const TTL_MS = 60_000;

/**
 * USD price of the native asset, read from on-chain liquidity (native → stablecoin
 * through the same venues used for trading). No price API involved.
 */
export class PriceService {
  private readonly cache = new Map<number, { at: number; usd: number | null }>();
  private readonly inflight = new Map<number, Promise<number | null>>();

  constructor(private readonly routing: Routing) {}

  /** Cached value without waiting; starts a refresh when stale. For display only. */
  peek(ctx: VenueCtx): number | null {
    const hit = this.cache.get(ctx.chain.id);
    if (!hit || ctx.now() - hit.at >= TTL_MS) void this.nativeUsd(ctx).catch(() => null);
    return hit?.usd ?? null;
  }

  /** Fresh-enough value; waits if needed. Used where limits depend on it. */
  async nativeUsd(ctx: VenueCtx): Promise<number | null> {
    const hit = this.cache.get(ctx.chain.id);
    if (hit && ctx.now() - hit.at < TTL_MS && hit.usd !== null) return hit.usd;
    const running = this.inflight.get(ctx.chain.id);
    if (running) return running;
    const job = this.fetch(ctx).finally(() => this.inflight.delete(ctx.chain.id));
    this.inflight.set(ctx.chain.id, job);
    return job;
  }

  private async fetch(ctx: VenueCtx): Promise<number | null> {
    // Native/stable pools are standard pools; no need for the pool index.
    const plain: VenueCtx = { ...ctx, fetchJson: undefined, aggregator: undefined };
    const results = await Promise.all(
      ctx.chain.stablecoins.map((stable) =>
        // Quote a small size and scale up, so thin pools do not skew the price much.
        this.routing
          .best(plain, stable.address, 'buy', [parseEther('0.01')])
          .then(([r]) => (r ? Number(formatUnits(r.out, stable.decimals)) * 100 : null))
          .catch(() => null),
      ),
    );
    // Deepest-looking quote wins (highest output for the same input).
    const usd = results.reduce<number | null>(
      (m, v) => (v !== null && (m === null || v > m) ? v : m),
      null,
    );
    this.cache.set(ctx.chain.id, { at: ctx.now(), usd });
    return usd;
  }
}
