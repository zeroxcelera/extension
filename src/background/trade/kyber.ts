import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { act as label } from './actions';
import type { Side, TxDraft, Venue, VenueCtx } from './types';
import { isOwn, type ExtraContractRule } from './validator';

/**
 * KyberSwap aggregator, used only as a fallback when Celera's own routing finds no pool
 * (tokens paired with other tokens, tokenised stocks, DEXes Celera does not list).
 * Its calldata comes from KyberSwap's API, so the validator decodes the swap description
 * and checks every field that decides where funds go; simulation runs as usual and
 * sell approvals are exact (never unlimited) for this router.
 */

const API = 'https://aggregator-api.kyberswap.com';
/** MetaAggregationRouterV2: the same address on every supported chain. */
export const KYBER_ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SLUG: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  56: 'bsc',
  42161: 'arbitrum',
  4663: 'robinhood',
};
/** A route is reused for this long (the API rate-limits; the panel refreshes every 3 s). */
const ROUTE_TTL_MS = 8_000;
const DEADLINE_MAX_S = 30 * 60;

const routerAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
  'function swapGeneric(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
  'function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)',
]);

interface RouteSummary {
  amountOut: string;
  /** Kyber's gas estimate for the whole route, and the gas price it assumed (wei). */
  gas?: string;
  gasPrice?: string;
  [k: string]: unknown;
}

/** Gas of a direct swap on one of Celera's own pools (a Universal Router v3 swap: ~140k). */
const OWN_SWAP_GAS = 150_000n;

const routes = new Map<string, { at: number; summary: RouteSummary }>();

function assets(token: Address, side: Side): [Address, Address] {
  return side === 'buy' ? [NATIVE, token] : [token, NATIVE];
}

function routeKey(ctx: VenueCtx, token: Address, side: Side, amount: bigint): string {
  const [tokenIn, tokenOut] = assets(token, side);
  return `${ctx.chain.id}:${tokenIn}:${tokenOut}:${amount}`.toLowerCase();
}

async function route(
  ctx: VenueCtx,
  token: Address,
  side: Side,
  amount: bigint,
  fresh = false,
): Promise<RouteSummary | null> {
  const slug = SLUG[ctx.chain.id];
  if (!slug || !ctx.aggregator || amount <= 0n) return null;
  const [tokenIn, tokenOut] = assets(token, side);
  const key = routeKey(ctx, token, side, amount);
  const hit = routes.get(key);
  if (!fresh && hit && ctx.now() - hit.at < ROUTE_TTL_MS) return hit.summary;
  const json = (await ctx.aggregator
    .get(`${API}/${slug}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amount}`)
    .catch(() => null)) as { code?: number; data?: { routeSummary?: RouteSummary } } | null;
  const summary = json?.code === 0 ? json.data?.routeSummary : undefined;
  if (!summary || !/^\d+$/.test(summary.amountOut)) return null;
  routes.set(key, { at: ctx.now(), summary });
  return summary;
}

/** The swap description must pay the caller's wallet, with a minimum and no extra fees. */
export const kyberRule: ExtraContractRule = {
  label: 'KyberSwap',
  approvalSpender: true,
  validate(tx, ctx) {
    let call;
    try {
      call = decodeFunctionData({ abi: routerAbi, data: tx.data });
    } catch {
      return [label('KyberSwap call', 'Unknown function')];
    }
    const desc = call.functionName === 'swapSimpleMode' ? call.args[1] : call.args[0].desc;
    const l = 'KyberSwap swap';
    const isTok = (a: Address) => !!ctx.token && isAddressEqual(a, ctx.token);
    const isNative = (a: Address) => isAddressEqual(a, NATIVE);
    const buy = isNative(desc.srcToken) && isTok(desc.dstToken);
    const sell = isTok(desc.srcToken) && isNative(desc.dstToken);
    if (!buy && !sell) return [label(l, 'Unexpected assets')];
    if (!isOwn(ctx, desc.dstReceiver)) return [label(l, 'Output does not go to your wallet')];
    if (desc.minReturnAmount === 0n)
      return [label(l, 'No minimum output (no slippage protection)')];
    if (desc.feeReceivers.length > 0 || desc.feeAmounts.some((f) => f > 0n))
      return [label(l, 'Carries an extra fee')];
    if (desc.permit !== '0x') return [label(l, 'Embedded permits are not allowed')];
    if (buy && tx.value !== desc.amount) return [label(l, 'Value does not match input')];
    if (sell && tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
    if (call.functionName === 'swapSimpleMode' && buy)
      return [label(l, 'Simple mode cannot take native input')];
    return [label(l)];
  },
};

export const kyberVenue: Venue = {
  id: 'kyber',
  supports: (chainId) => chainId in SLUG,
  async discover(ctx, token) {
    if (!ctx.aggregator || !(ctx.chain.id in SLUG)) return [];
    return [{ venueId: 'kyber', id: 'kyber', label: 'KyberSwap', token, data: null }];
  },
  async quote(ctx, ref, side, amounts) {
    const res = await Promise.all(amounts.map((a) => route(ctx, ref.token, side, a)));
    return res.map((r) => (r ? BigInt(r.amountOut) : null));
  },
  extraGasWei(ctx, ref, side, amount) {
    const s = routes.get(routeKey(ctx, ref.token, side, amount))?.summary;
    if (!s?.gas || !s.gasPrice || !/^\d+$/.test(s.gas) || !/^\d+$/.test(s.gasPrice)) return 0n;
    const extra = BigInt(s.gas) - OWN_SWAP_GAS;
    return extra > 0n ? extra * BigInt(s.gasPrice) : 0n;
  },
  buildBuy() {
    throw new Error('KyberSwap transactions are built through prepare()');
  },
  buildSell() {
    throw new Error('KyberSwap transactions are built through prepare()');
  },
  async prepare(ctx, ref, side, p): Promise<TxDraft> {
    const slug = SLUG[ctx.chain.id];
    if (!slug || !ctx.aggregator) throw new Error('KyberSwap is not available');
    const summary = await route(ctx, ref.token, side, p.amountIn);
    if (!summary) throw new Error('KyberSwap found no route');
    const out = BigInt(summary.amountOut);
    // Kyber takes a tolerance, not a minimum: express Celera's minimum as one.
    const slippage = out > p.minOut ? Number(((out - p.minOut) * 10_000n + out - 1n) / out) : 1;
    const nowS = Math.floor(ctx.now() / 1000);
    const deadline = Math.min(Number(p.deadline), nowS + DEADLINE_MAX_S);
    const json = (await ctx.aggregator
      .post(`${API}/${slug}/api/v1/route/build`, {
        routeSummary: summary,
        sender: p.wallet,
        recipient: p.wallet,
        slippageTolerance: Math.min(Math.max(slippage, 1), 5_000),
        deadline,
        source: 'celera',
      })
      .catch(() => null)) as {
      code?: number;
      data?: { data?: string; routerAddress?: string; transactionValue?: string };
    } | null;
    const built = json?.code === 0 ? json.data : undefined;
    if (!built?.data || !built.routerAddress || !/^0x[0-9a-fA-F]+$/.test(built.data))
      throw new Error('KyberSwap could not build the swap');
    if (!isAddressEqual(getAddress(built.routerAddress), KYBER_ROUTER))
      throw new Error('KyberSwap returned an unknown router');
    return {
      to: KYBER_ROUTER,
      data: built.data as Hex,
      value: BigInt(built.transactionValue ?? '0'),
    };
  },
  sellApproval: () => ({ spender: KYBER_ROUTER, viaPermit2: false, router: KYBER_ROUTER }),
  exactApproval: true,
  poolRules: () => [[KYBER_ROUTER, kyberRule]],
};
