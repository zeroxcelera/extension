import type { Address, Hex, PublicClient } from 'viem';
import type { ChainConfig } from '../../shared/chains';
import type { PermitSingle } from './uniswap/codec';
import type { ExtraContractRule } from './validator';

export interface VenueCtx {
  chain: ChainConfig;
  client: PublicClient;
  /** Optional pool index lookup (DEX Screener); results must be verified on-chain. */
  fetchJson?: ((url: string) => Promise<unknown>) | undefined;
  now: () => number;
  /** DEX aggregator API access (KyberSwap), when the user allows it. */
  aggregator?:
    | {
        get(url: string): Promise<unknown>;
        post(url: string, body: unknown): Promise<unknown>;
      }
    | undefined;
}

/** A tradable pool for `token` against the chain's native asset. Opaque per venue. */
export interface PoolRef<T = unknown> {
  venueId: string;
  /** Stable id, e.g. pool address or v4 pool id. */
  id: string;
  /** Short human label, e.g. "Uniswap v3 · 1%". */
  label: string;
  token: Address;
  data: T;
}

export type Side = 'buy' | 'sell';

export interface TxDraft {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface BuyParams {
  wallet: Address;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
}

export interface SellParams extends BuyParams {
  /** Permit2 signature for the router, when the existing Permit2 allowance is too low. */
  permit?: { signature: Hex; permit: PermitSingle } | undefined;
}

export interface Funding {
  asset: Address;
  symbol: string;
  /** Pool (of the venue `leg.venueId`) that converts native ↔ `asset`. */
  leg: PoolRef;
  /** In asset terms: buy = asset in → token out; sell = token in → asset out. */
  quoteAsset(ctx: VenueCtx, side: Side, amounts: readonly bigint[]): Promise<(bigint | null)[]>;
}

export interface Venue {
  id: string;
  supports(chainId: number): boolean;
  discover(ctx: VenueCtx, token: Address): Promise<PoolRef[]>;
  /** amounts[i] → output, or null when the quote failed. One RPC round trip per pool. */
  quote(
    ctx: VenueCtx,
    pool: PoolRef,
    side: Side,
    amounts: readonly bigint[],
  ): Promise<(bigint | null)[]>;
  /**
   * Gas (in native wei) a quote from `quote()` costs beyond a direct swap on one of
   * Celera's own pools, when the venue knows it: an aggregator's multi-hop route can pay
   * more tokens and still cost more once its gas is counted.
   */
  extraGasWei?(ctx: VenueCtx, pool: PoolRef, side: Side, amount: bigint): bigint;
  buildBuy(ctx: VenueCtx, pool: PoolRef, p: BuyParams): TxDraft;
  buildSell(ctx: VenueCtx, pool: PoolRef, p: SellParams): TxDraft;
  /**
   * Sell for a contract caller that cannot sign Permit2 (the Celera Router): the tokens
   * are transferred to the returned `to` first, which swaps its whole balance. Null when
   * the pool cannot do that.
   */
  buildSellPrefunded?(ctx: VenueCtx, pool: PoolRef, p: Omit<BuyParams, 'amountIn'>): TxDraft | null;
  /**
   * Async build, for venues whose calldata comes from an API (aggregators). When set it
   * is used instead of buildBuy / buildSell; see buildTx().
   */
  prepare?(ctx: VenueCtx, pool: PoolRef, side: Side, p: SellParams): Promise<TxDraft>;
  /** Approve exactly the amount sold, whatever the unlimited-approval setting says. */
  exactApproval?: boolean;
  /** Contract that must hold an ERC-20 allowance for sells, and whether it is Permit2. */
  sellApproval(
    ctx: VenueCtx,
    pool: PoolRef,
  ): { spender: Address; viaPermit2: boolean; router: Address };
  /**
   * Taxes the venue itself charges on this pool (e.g. a launchpad creator tax), in basis
   * points. They are already in quotes; reported so the panel can show the full tax.
   */
  venueTax?(ctx: VenueCtx, pool: PoolRef): Promise<{ buyBps: number; sellBps: number }>;
  /**
   * Set when the pool trades against an ERC-20 asset instead of native (e.g. a Virtuals
   * curve quoted in VIRTUAL). Quotes stay in native terms; the engine converts native
   * into the asset around the curve trade: in one transaction through the Celera Router
   * when the chain has one, else as separate transactions.
   */
  funding?(ctx: VenueCtx, pool: PoolRef): Funding | undefined;
  /** Validator rules for contracts specific to this pool (e.g. a per-token curve). */
  poolRules?(ctx: VenueCtx, pool: PoolRef): [Address, ExtraContractRule][];
}

/** The transaction for a trade: the venue's async `prepare` when it has one, else its builder. */
export function buildTx(
  venue: Venue,
  ctx: VenueCtx,
  pool: PoolRef,
  side: Side,
  p: SellParams,
): Promise<TxDraft> {
  if (venue.prepare) return venue.prepare(ctx, pool, side, p);
  return Promise.resolve(
    side === 'buy' ? venue.buildBuy(ctx, pool, p) : venue.buildSell(ctx, pool, p),
  );
}
