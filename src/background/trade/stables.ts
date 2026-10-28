import { isAddressEqual, type Address } from 'viem';
import type { VenueCtx } from './types';

/** Stablecoins and hop tokens (e.g. VIRTUAL): the assets a route may pass through. */
function routeAssets(ctx: Pick<VenueCtx, 'chain'>): { address: Address; symbol: string }[] {
  return [...ctx.chain.stablecoins, ...(ctx.chain.hopTokens ?? [])];
}

/**
 * Assets that may sit between native and `token` (native → stable → token in one swap).
 * None when `token` is itself native-wrapped or one of them.
 */
export function hopStables(ctx: VenueCtx, token: Address): Address[] {
  const stables = routeAssets(ctx).map((s) => s.address);
  if (isAddressEqual(token, ctx.chain.wrappedNative)) return [];
  if (stables.some((s) => isAddressEqual(s, token))) return [];
  return stables;
}

export function stableSymbol(ctx: VenueCtx, a: Address): string {
  return routeAssets(ctx).find((s) => isAddressEqual(s.address, a))?.symbol ?? 'stable';
}
