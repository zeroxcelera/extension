import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import type { BlockedAction } from '../../../shared/panel';
import { hopStables, stableSymbol } from '../stables';
import type { BuyParams, PoolRef, SellParams, Side, TxDraft, Venue, VenueCtx } from '../types';
import {
  isOwn,
  isStable,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from '../validator';

/**
 * Constant-product routers with fee-on-transfer support (tax tokens are common on
 * BSC/Base). Two flavours: Uniswap-v2 style (address[] path) and Aerodrome style
 * (Route[] with stable flag + factory). Approvals go directly to the router, bounded.
 * Tokens quoted in a stablecoin route native → stable → token in the same swap.
 */
export interface V2RouterConfig {
  id: string;
  label: string;
  chainId: number;
  router: Address;
  factory: Address;
  flavour: 'uniswap' | 'aerodrome';
}

type Route = { from: Address; to: Address; stable: boolean; factory: Address };
interface V2Pool {
  pair: Address;
  stable: boolean;
  /** Stablecoin quote: the route goes native → stable (volatile pool) → token. */
  via?: Address;
}

const uniAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
const aeroAbi = parseAbi([
  'struct Route { address from; address to; bool stable; address factory; }',
  'function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, Route[] routes, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline)',
]);
const uniFactoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
const aeroFactoryAbi = parseAbi([
  'function getPool(address, address, bool) view returns (address)',
]);

const MAX_DEADLINE_S = 30 * 60;

export function v2RouterVenue(cfg: V2RouterConfig): { venue: Venue; rule: ExtraContractRule } {
  /** Assets in trade order: [native, (stable,) token] for a buy, reversed for a sell. */
  const assets = (ctx: VenueCtx, ref: PoolRef, side: Side): Address[] => {
    const pool = ref.data as V2Pool;
    const path = [ctx.chain.wrappedNative, ...(pool.via ? [pool.via] : []), ref.token];
    return side === 'buy' ? path : path.reverse();
  };
  /** Aerodrome routes: the token pool keeps its own stable flag; native/stable is volatile. */
  const routes = (pool: V2Pool, path: Address[], token: Address): Route[] =>
    path.slice(1).map((to, i) => {
      const from = path[i] as Address;
      const tokenHop = isAddressEqual(from, token) || isAddressEqual(to, token);
      return { from, to, stable: tokenHop ? pool.stable : false, factory: cfg.factory };
    });

  const discover = async (ctx: VenueCtx, token: Address): Promise<PoolRef<V2Pool>[]> => {
    const weth = ctx.chain.wrappedNative;
    const stables = hopStables(ctx, token);
    const flags = cfg.flavour === 'uniswap' ? [false] : [false, true];
    // Token pools (vs native and vs each stable), then the native/stable pools for the hop.
    const lookups = [
      ...[weth, ...stables].flatMap((q) => flags.map((stable) => ({ a: token, b: q, stable }))),
      ...stables.map((s) => ({ a: weth, b: s, stable: false })),
    ];
    const res = await ctx.client.multicall({
      allowFailure: true,
      contracts: lookups.map((l) =>
        cfg.flavour === 'uniswap'
          ? ({
              address: cfg.factory,
              abi: uniFactoryAbi,
              functionName: 'getPair',
              args: [l.a, l.b],
            } as const)
          : ({
              address: cfg.factory,
              abi: aeroFactoryAbi,
              functionName: 'getPool',
              args: [l.a, l.b, l.stable],
            } as const),
      ),
    });
    const found = lookups
      .map((l, i) => {
        const r = res[i];
        return { ...l, pair: r?.status === 'success' ? (r.result as Address) : zeroAddress };
      })
      .filter((l) => l.pair !== zeroAddress);
    const bridged = new Set(
      found.filter((l) => isAddressEqual(l.a, weth)).map((l) => l.b.toLowerCase()),
    );
    return found
      .filter((l) => isAddressEqual(l.a, token))
      .filter((l) => isAddressEqual(l.b, weth) || bridged.has(l.b.toLowerCase()))
      .map((l) => {
        const via = isAddressEqual(l.b, weth) ? undefined : l.b;
        const kind = cfg.flavour === 'aerodrome' ? ` · ${l.stable ? 'stable' : 'volatile'}` : '';
        return {
          venueId: cfg.id,
          id: l.pair.toLowerCase(),
          label: `${cfg.label}${kind}${via ? ` via ${stableSymbol(ctx, via)}` : ''}`,
          token,
          data: { pair: l.pair, stable: l.stable, ...(via ? { via } : {}) },
        };
      });
  };

  const quote = async (ctx: VenueCtx, ref: PoolRef, side: Side, amounts: readonly bigint[]) => {
    const pool = ref.data as V2Pool;
    const path = assets(ctx, ref, side);
    const res = await ctx.client.multicall({
      allowFailure: true,
      contracts: amounts.map((a) =>
        cfg.flavour === 'uniswap'
          ? ({
              address: cfg.router,
              abi: uniAbi,
              functionName: 'getAmountsOut',
              args: [a, path],
            } as const)
          : ({
              address: cfg.router,
              abi: aeroAbi,
              functionName: 'getAmountsOut',
              args: [a, routes(pool, path, ref.token)],
            } as const),
      ),
    });
    return res.map((r) => {
      if (r.status !== 'success') return null;
      const outs = r.result as readonly bigint[];
      return outs[outs.length - 1] ?? null;
    });
  };

  const buildBuy = (ctx: VenueCtx, ref: PoolRef, p: BuyParams): TxDraft => {
    const pool = ref.data as V2Pool;
    const path = assets(ctx, ref, 'buy');
    const data =
      cfg.flavour === 'uniswap'
        ? encodeFunctionData({
            abi: uniAbi,
            functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
            args: [p.minOut, path, p.wallet, p.deadline],
          })
        : encodeFunctionData({
            abi: aeroAbi,
            functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
            args: [p.minOut, routes(pool, path, ref.token), p.wallet, p.deadline],
          });
    return { to: cfg.router, data, value: p.amountIn };
  };

  const buildSell = (ctx: VenueCtx, ref: PoolRef, p: SellParams): TxDraft => {
    const pool = ref.data as V2Pool;
    const path = assets(ctx, ref, 'sell');
    const data =
      cfg.flavour === 'uniswap'
        ? encodeFunctionData({
            abi: uniAbi,
            functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
            args: [p.amountIn, p.minOut, path, p.wallet, p.deadline],
          })
        : encodeFunctionData({
            abi: aeroAbi,
            functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
            args: [p.amountIn, p.minOut, routes(pool, path, ref.token), p.wallet, p.deadline],
          });
    return { to: cfg.router, data, value: 0n };
  };

  const venue: Venue = {
    id: cfg.id,
    supports: (chainId) => chainId === cfg.chainId,
    discover,
    quote,
    buildBuy,
    buildSell,
    sellApproval: () => ({ spender: cfg.router, viaPermit2: false, router: cfg.router }),
  };

  const rule: ExtraContractRule = {
    label: cfg.label,
    approvalSpender: true,
    validate(tx: TxToValidate, ctx: ValidationContext): BlockedAction[] {
      let call;
      try {
        call = decodeFunctionData({
          abi: cfg.flavour === 'uniswap' ? uniAbi : aeroAbi,
          data: tx.data,
        });
      } catch {
        return [{ label: `${cfg.label} call`, ok: false, reason: 'Unknown function' }];
      }
      if (call.functionName === 'getAmountsOut')
        return [{ label: 'getAmountsOut', ok: false, reason: 'Not a swap' }];
      const buy = call.functionName === 'swapExactETHForTokensSupportingFeeOnTransferTokens';
      const args = call.args as readonly unknown[];
      const [minOut, path, to, deadline] = buy
        ? (args as [bigint, unknown, Address, bigint])
        : ([args[1], args[2], args[3], args[4]] as [bigint, unknown, Address, bigint]);
      const hops: [Address, Address][] =
        cfg.flavour === 'uniswap'
          ? (path as Address[]).slice(1).map((t, i) => [(path as Address[])[i] as Address, t])
          : (path as readonly Route[]).map((r) => [r.from, r.to]);
      const label = `${cfg.label} ${buy ? 'buy' : 'sell'} → ${to.slice(0, 6)}…`;
      const weth = ctx.chain.wrappedNative;
      const fail = (reason: string): BlockedAction[] => [{ label, ok: false, reason }];
      if (hops.length < 1 || hops.length > 2)
        return fail('Only direct swaps or one stablecoin hop are allowed');
      for (let i = 1; i < hops.length; i++) {
        const prev = hops[i - 1] as [Address, Address];
        const next = hops[i] as [Address, Address];
        if (!isAddressEqual(prev[1], next[0])) return fail('Route hops are not connected');
      }
      const from = (hops[0] as [Address, Address])[0];
      const dest = (hops[hops.length - 1] as [Address, Address])[1];
      const middle = hops.slice(1).map((h) => h[0]);
      // Native on one end, the traded token on the other, at most one stablecoin between.
      const [nativeEnd, tokenEnd] = buy ? [from, dest] : [dest, from];
      if (!isAddressEqual(nativeEnd, weth)) return fail('Unexpected direction');
      if (!ctx.token || !isAddressEqual(tokenEnd, ctx.token))
        return fail('Path does not trade the selected token');
      if (middle.some((m) => !isStable(ctx, m)))
        return fail('Only a stablecoin may sit between native and the token');
      if (
        cfg.flavour === 'aerodrome' &&
        (path as readonly Route[]).some((r) => !isAddressEqual(r.factory, cfg.factory))
      )
        return fail('Unknown pool factory');
      if (!isOwn(ctx, to)) return fail('Recipient is not one of your wallets');
      if (minOut === 0n) return fail('No minimum output (no slippage protection)');
      if (deadline < BigInt(ctx.nowS) || deadline > BigInt(ctx.nowS + MAX_DEADLINE_S))
        return fail('Deadline outside the allowed window');
      if (!buy && tx.value !== 0n) return fail('Sell must not carry native value');
      return [{ label, ok: true }];
    },
  };

  return { venue, rule };
}
