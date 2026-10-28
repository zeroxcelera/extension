import { parseUnits, type Address } from 'viem';
import type { PoolRef, Side, Venue, VenueCtx } from './types';
import { uniswapVenue, type UniPool } from './uniswap/venue';
import { extraVenues } from './venues';

/**
 * Native ↔ asset pools for curves quoted in an ERC-20 (PEPE, USDG, USDT...): the AMM pool
 * that gives the most of the asset for a typical buy. Found once per asset and cached;
 * prices still come from fresh quotes on that pool.
 */

const AMMS: Venue[] = [uniswapVenue, ...extraVenues];
const LEG_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; leg: PoolRef | null }>();

function ammVenue(id: string): Venue | undefined {
  return AMMS.find((v) => v.id === id);
}

/**
 * Pools the Celera Router can also sell into: allowance-based routers, or Uniswap pools
 * the Universal Router can swap from its own balance (see buildSellPrefunded).
 */
function routerFriendly(ref: PoolRef): boolean {
  if (ref.venueId !== uniswapVenue.id) return true;
  const p = ref.data as UniPool;
  if (p.kind === 'v4' || p.via?.v4Key) return false;
  return !(p.kind === 'v2' && p.via);
}

export async function findLeg(ctx: VenueCtx, asset: Address): Promise<PoolRef | null> {
  const key = `${ctx.chain.id}:${asset.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && ctx.now() - hit.at < LEG_TTL_MS) return hit.leg;
  const probe = parseUnits(ctx.chain.quickBuyAmounts[1] ?? '0.01', 18);
  const found = await Promise.all(
    AMMS.filter((v) => v.supports(ctx.chain.id)).map(async (v) => {
      const pools = (await v.discover(ctx, asset).catch(() => [])).filter(routerFriendly);
      const outs = await Promise.all(
        pools.map((p) =>
          v.quote(ctx, p, 'buy', [probe]).then(
            (r) => r[0] ?? null,
            () => null,
          ),
        ),
      );
      return pools.map((pool, i) => ({ pool, out: outs[i] ?? null }));
    }),
  );
  let best: { pool: PoolRef; out: bigint } | null = null;
  for (const c of found.flat()) {
    if (c.out && (!best || c.out > best.out)) best = { pool: c.pool, out: c.out };
  }
  const leg = best?.pool ?? null;
  cache.set(key, { at: ctx.now(), leg });
  return leg;
}

/** Native → asset (buy) or asset → native (sell) quotes on a leg found by findLeg. */
export function quoteLeg(
  ctx: VenueCtx,
  leg: PoolRef,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const venue = ammVenue(leg.venueId);
  if (!venue) return Promise.resolve(amounts.map(() => null));
  return venue.quote(ctx, leg, side, amounts);
}
