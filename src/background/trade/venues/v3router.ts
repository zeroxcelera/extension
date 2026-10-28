import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import type { BlockedAction } from '../../../shared/panel';
import { hopStables, stableSymbol } from '../stables';
import type { BuyParams, PoolRef, SellParams, Side, TxDraft, Venue, VenueCtx } from '../types';
import { decodeV3Path, encodeV3Path, type V3Hop } from '../uniswap/codec';
import {
  isOwn,
  isStable,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from '../validator';

/**
 * Concentrated-liquidity venues behind a Uniswap "SwapRouter02"-style router
 * (PancakeSwap v3 SmartRouter). Buys pay with msg.value (router wraps); sells swap to
 * the router and unwrap to the wallet in one multicall. Approvals go to the router.
 * Tokens quoted in a stablecoin use a two-hop path: native → stable → token.
 */
export interface V3RouterConfig {
  id: string;
  label: string;
  chainId: number;
  router: Address;
  factory: Address;
  quoter: Address;
  fees: readonly number[];
}

interface V3Pool {
  pool: Address;
  fee: number;
  /** Stablecoin quote, reached through the native/stable pool with this fee. */
  via?: { stable: Address; fee: number };
}

const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

const routerAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
]);
const factoryAbi = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[], uint32[], uint256)',
]);

const MAX_DEADLINE_S = 30 * 60;

export function v3RouterVenue(cfg: V3RouterConfig): { venue: Venue; rule: ExtraContractRule } {
  /** Hops in trade order; one hop for native-quoted pools, two through a stable. */
  const hops = (ctx: VenueCtx, ref: PoolRef, side: Side): V3Hop[] => {
    const pool = ref.data as V3Pool;
    const weth = ctx.chain.wrappedNative;
    const buy: V3Hop[] = pool.via
      ? [
          { tokenIn: weth, fee: pool.via.fee, tokenOut: pool.via.stable },
          { tokenIn: pool.via.stable, fee: pool.fee, tokenOut: ref.token },
        ]
      : [{ tokenIn: weth, fee: pool.fee, tokenOut: ref.token }];
    return side === 'buy'
      ? buy
      : buy.reverse().map((h) => ({ tokenIn: h.tokenOut, fee: h.fee, tokenOut: h.tokenIn }));
  };

  const discover = async (ctx: VenueCtx, token: Address): Promise<PoolRef<V3Pool>[]> => {
    const weth = ctx.chain.wrappedNative;
    const stables = hopStables(ctx, token);
    const lookups = [
      ...[weth, ...stables].flatMap((q) => cfg.fees.map((fee) => ({ a: token, b: q, fee }))),
      // Native/stable pools: the hop every stable-quoted route shares.
      ...stables.flatMap((s) => cfg.fees.map((fee) => ({ a: weth, b: s, fee }))),
    ];
    const found = await ctx.client.multicall({
      allowFailure: true,
      contracts: lookups.map(
        (l) =>
          ({
            address: cfg.factory,
            abi: factoryAbi,
            functionName: 'getPool',
            args: [l.a, l.b, l.fee],
          }) as const,
      ),
    });
    const pools = lookups
      .map((l, i) => {
        const r = found[i];
        return { ...l, pool: r?.status === 'success' ? (r.result as Address) : zeroAddress };
      })
      .filter((p) => p.pool !== zeroAddress);
    if (pools.length === 0) return [];
    const liq = await ctx.client.multicall({
      allowFailure: true,
      contracts: pools.map(
        (p) => ({ address: p.pool, abi: poolAbi, functionName: 'liquidity' }) as const,
      ),
    });
    const live = pools
      .map((p, i) => ({
        ...p,
        liquidity: liq[i]?.status === 'success' ? (liq[i].result as bigint) : 0n,
      }))
      .filter((p) => p.liquidity > 0n);
    // Per stable, the native/stable pool with the most in-range liquidity.
    const bridge = new Map<string, { fee: number; liquidity: bigint }>();
    for (const p of live.filter((p) => isAddressEqual(p.a, weth))) {
      const k = p.b.toLowerCase();
      if (p.liquidity > (bridge.get(k)?.liquidity ?? 0n)) bridge.set(k, p);
    }
    return live
      .filter((p) => isAddressEqual(p.a, token))
      .flatMap((p) => {
        const native = isAddressEqual(p.b, weth);
        const b = bridge.get(p.b.toLowerCase());
        if (!native && !b) return [];
        const via = native || !b ? undefined : { stable: p.b, fee: b.fee };
        return [
          {
            venueId: cfg.id,
            id: p.pool.toLowerCase(),
            label: `${cfg.label} · ${p.fee / 10_000}%${via ? ` via ${stableSymbol(ctx, via.stable)}` : ''}`,
            token,
            data: { pool: p.pool, fee: p.fee, ...(via ? { via } : {}) },
          },
        ];
      });
  };

  const quote = async (ctx: VenueCtx, ref: PoolRef, side: Side, amounts: readonly bigint[]) => {
    const path = hops(ctx, ref, side);
    const single = path.length === 1 ? path[0] : undefined;
    const res = await ctx.client.multicall({
      allowFailure: true,
      contracts: amounts.map((amountIn) =>
        single
          ? ({
              address: cfg.quoter,
              abi: quoterAbi,
              functionName: 'quoteExactInputSingle',
              args: [
                {
                  tokenIn: single.tokenIn,
                  tokenOut: single.tokenOut,
                  amountIn,
                  fee: single.fee,
                  sqrtPriceLimitX96: 0n,
                },
              ],
            } as const)
          : ({
              address: cfg.quoter,
              abi: quoterAbi,
              functionName: 'quoteExactInput',
              args: [encodeV3Path(path), amountIn],
            } as const),
      ),
    });
    return res.map((r) =>
      r.status === 'success' ? ((r.result as readonly unknown[])[0] as bigint) : null,
    );
  };

  const swap = (path: V3Hop[], recipient: Address, amountIn: bigint, minOut: bigint): Hex => {
    const only = path.length === 1 ? path[0] : undefined;
    return only
      ? encodeFunctionData({
          abi: routerAbi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: only.tokenIn,
              tokenOut: only.tokenOut,
              fee: only.fee,
              recipient,
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: routerAbi,
          functionName: 'exactInput',
          args: [{ path: encodeV3Path(path), recipient, amountIn, amountOutMinimum: minOut }],
        });
  };

  const buildBuy = (ctx: VenueCtx, ref: PoolRef, p: BuyParams): TxDraft => {
    const inner = swap(hops(ctx, ref, 'buy'), p.wallet, p.amountIn, p.minOut);
    return {
      to: cfg.router,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: 'multicall',
        args: [p.deadline, [inner]],
      }),
      value: p.amountIn,
    };
  };

  const buildSell = (ctx: VenueCtx, ref: PoolRef, p: SellParams): TxDraft => {
    const inner = [
      swap(hops(ctx, ref, 'sell'), ADDRESS_THIS, p.amountIn, p.minOut),
      encodeFunctionData({
        abi: routerAbi,
        functionName: 'unwrapWETH9',
        args: [p.minOut, p.wallet],
      }),
    ];
    return {
      to: cfg.router,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: 'multicall',
        args: [p.deadline, inner],
      }),
      value: 0n,
    };
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

  /** Native on one end, the traded token on the other, at most one stablecoin between. */
  const checkPath = (path: V3Hop[], ctx: ValidationContext): string | null => {
    const weth = ctx.chain.wrappedNative;
    if (path.length < 1 || path.length > 2)
      return 'Only direct swaps or one stablecoin hop are allowed';
    const first = (path[0] as V3Hop).tokenIn;
    const last = (path[path.length - 1] as V3Hop).tokenOut;
    const ends = [first, last];
    if (!ends.some((a) => isAddressEqual(a, weth))) return 'Unexpected asset';
    if (!ctx.token || !ends.some((a) => isAddressEqual(a, ctx.token as Address)))
      return 'Path does not trade the selected token';
    if (path.slice(1).some((h) => !isStable(ctx, h.tokenIn)))
      return 'Only a stablecoin may sit between native and the token';
    return null;
  };

  const rule: ExtraContractRule = {
    label: cfg.label,
    approvalSpender: true,
    validate(tx: TxToValidate, ctx: ValidationContext): BlockedAction[] {
      const out: BlockedAction[] = [];
      let outer;
      try {
        outer = decodeFunctionData({ abi: routerAbi, data: tx.data });
      } catch {
        return [{ label: `${cfg.label} call`, ok: false, reason: 'Unknown function' }];
      }
      if (outer.functionName !== 'multicall')
        return [
          {
            label: `${cfg.label} ${outer.functionName}`,
            ok: false,
            reason: 'Only multicall(deadline, …) is allowed',
          },
        ];
      const [deadline, calls] = outer.args;
      if (deadline < BigInt(ctx.nowS) || deadline > BigInt(ctx.nowS + MAX_DEADLINE_S)) {
        out.push({ label: 'Deadline', ok: false, reason: 'Deadline outside the allowed window' });
      }
      let paysUser = false;
      for (const data of calls) {
        let c;
        try {
          c = decodeFunctionData({ abi: routerAbi, data });
        } catch {
          out.push({ label: 'Inner call', ok: false, reason: 'Unknown function' });
          continue;
        }
        if (c.functionName === 'exactInputSingle' || c.functionName === 'exactInput') {
          let path: V3Hop[];
          let recipient: Address;
          let minOut: bigint;
          if (c.functionName === 'exactInputSingle') {
            const s = c.args[0];
            path = [{ tokenIn: s.tokenIn, fee: s.fee, tokenOut: s.tokenOut }];
            recipient = s.recipient;
            minOut = s.amountOutMinimum;
          } else {
            const s = c.args[0];
            try {
              path = decodeV3Path(s.path);
            } catch {
              out.push({ label: `${cfg.label} swap`, ok: false, reason: 'Malformed path' });
              continue;
            }
            recipient = s.recipient;
            minOut = s.amountOutMinimum;
          }
          const label = `${cfg.label} swap ${[path[0]?.tokenIn, ...path.map((h) => h.tokenOut)]
            .map((a) => `${(a ?? '?').slice(0, 6)}…`)
            .join(' → ')}`;
          const toRouter = isAddressEqual(recipient, ADDRESS_THIS);
          const bad = checkPath(path, ctx);
          if (bad) out.push({ label, ok: false, reason: bad });
          else if (!toRouter && !isOwn(ctx, recipient))
            out.push({ label, ok: false, reason: 'Recipient is not one of your wallets' });
          else if (minOut === 0n)
            out.push({ label, ok: false, reason: 'No minimum output (no slippage protection)' });
          else out.push({ label, ok: true });
          if (!toRouter && isOwn(ctx, recipient)) paysUser = true;
        } else if (c.functionName === 'unwrapWETH9') {
          const [, recipient] = c.args;
          const label = `Unwrap to ${recipient.slice(0, 6)}…`;
          if (isOwn(ctx, recipient)) {
            out.push({ label, ok: true });
            paysUser = true;
          } else out.push({ label, ok: false, reason: 'Recipient is not one of your wallets' });
        } else {
          out.push({ label: c.functionName, ok: false, reason: 'Not allowed inside multicall' });
        }
      }
      if (!paysUser)
        out.push({ label: 'Output', ok: false, reason: 'No step sends the output to your wallet' });
      return out;
    },
  };

  return { venue, rule };
}
