import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import { act as label } from './actions';
import type { Funding, PoolRef, Side, Venue, VenueCtx } from './types';
import { uniswapVenue, type UniPool } from './uniswap/venue';
import type { ExtraContractRule } from './validator';

/**
 * Virtuals bonding curves (BondingV5 + FRouterV3). They trade in VIRTUAL, not native:
 * quotes chain the WETH/VIRTUAL Uniswap pool with the curve, and the engine runs the
 * native ↔ VIRTUAL swap as its own transaction around the curve trade (`funding`).
 * Verified on-chain (Base): contract ABIs from the explorer, and buy → sell simulated.
 */

interface VirtualsDeployment {
  bonding: Address;
  /** FRouterV3: pulls VIRTUAL on buys and the token on sells, so it is the spender. */
  router: Address;
  asset: Address;
  /** WETH/VIRTUAL Uniswap v3 pool used for funding. */
  bridge: { pool: Address; fee: number };
}

const VIRTUALS: Record<number, VirtualsDeployment> = {
  8453: {
    bonding: '0x1a540088125d00dd3990f9da45ca0859af4d3b01',
    router: '0x02fe8ec3d9bbf7318eb54590bcc39198a8b47ded',
    asset: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
    bridge: { pool: '0x9c087eb773291e50cf6c6a90ef0f4500e349b903', fee: 500 },
  },
};

const bondingAbi = parseAbi([
  'function buy(uint256 amountIn, address tokenAddress, uint256 amountOutMin, uint256 deadline) payable returns (bool)',
  'function sell(uint256 amountIn, address tokenAddress, uint256 amountOutMin, uint256 deadline) returns (bool)',
  'function tokenInfo(address) view returns (address creator, address token, address pair, address agentToken, (address token, string name, string _name, string ticker, uint256 supply, uint256 price, uint256 marketCap, uint256 liquidity, uint256 volume, uint256 volume24H, uint256 prevPrice, uint256 lastUpdated) data, string description, string image, string twitter, string telegram, string youtube, string website, bool trading, bool tradingOnUniswap, uint256 applicationId, uint256 initialPurchase, uint256 virtualId, bool launchExecuted)',
]);
const routerAbi = parseAbi([
  'function getAmountsOut(address token, address assetToken_, uint256 amountIn) view returns (uint256)',
]);

const DEADLINE_MAX_S = 30 * 60;

function bondingRule(): ExtraContractRule {
  return {
    label: 'Virtuals curve',
    validate(tx, ctx) {
      let call;
      try {
        call = decodeFunctionData({ abi: bondingAbi, data: tx.data });
      } catch {
        return [label('Virtuals call', 'Unknown function')];
      }
      if (call.functionName !== 'buy' && call.functionName !== 'sell')
        return [label(`Virtuals ${call.functionName}`, 'Not a trade')];
      const [amountIn, token, minOut, deadline] = call.args;
      const l = `Virtuals ${call.functionName}`;
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Wrong token')];
      if (tx.value !== 0n) return [label(l, 'Must not carry native value (paid in VIRTUAL)')];
      if (amountIn === 0n) return [label(l, 'Zero amount')];
      if (minOut === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (deadline < BigInt(ctx.nowS) || deadline > BigInt(ctx.nowS + DEADLINE_MAX_S))
        return [label(l, 'Deadline outside the allowed window')];
      // The curve pays msg.sender (the validated `from`).
      return [label(l)];
    },
  };
}

/** The router is only ever an approval spender, never called directly. */
const spenderRule: ExtraContractRule = {
  label: 'Virtuals router',
  approvalSpender: true,
  validate: () => [label('Call to the Virtuals router', 'Only approvals are allowed')],
};

function bridgeRef(ctx: VenueCtx, d: VirtualsDeployment): PoolRef<UniPool> {
  return {
    venueId: 'uniswap',
    id: d.bridge.pool.toLowerCase(),
    label: 'Uniswap v3',
    token: d.asset,
    data: { kind: 'v3', pool: d.bridge.pool, quote: ctx.chain.wrappedNative, fee: d.bridge.fee },
  };
}

function curveQuote(ctx: VenueCtx, d: VirtualsDeployment, token: Address) {
  return async (side: Side, amounts: readonly bigint[]): Promise<(bigint | null)[]> => {
    if (amounts.length === 0) return [];
    // getAmountsOut(token, asset, x) quotes asset → token; (token, 0, x) quotes token → asset.
    const res = await ctx.client.multicall({
      allowFailure: true,
      contracts: amounts.map(
        (a) =>
          ({
            address: d.router,
            abi: routerAbi,
            functionName: 'getAmountsOut',
            args: [token, side === 'buy' ? d.asset : zeroAddress, a],
          }) as const,
      ),
    });
    return res.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
  };
}

export const virtualsVenue: Venue = {
  id: 'virtuals',
  supports: (chainId) => chainId in VIRTUALS,
  async discover(ctx, token) {
    const d = VIRTUALS[ctx.chain.id];
    if (!d) return [];
    const info = await ctx.client
      .readContract({
        address: d.bonding,
        abi: bondingAbi,
        functionName: 'tokenInfo',
        args: [token],
      })
      .catch(() => null);
    if (!info) return [];
    const [, infoToken, , , , , , , , , , trading, tradingOnUniswap, , , , launched] = info;
    if (!isAddressEqual(infoToken, token) || !trading || tradingOnUniswap || !launched) return [];
    return [
      {
        venueId: 'virtuals',
        id: `virtuals:${token.toLowerCase()}`,
        label: 'Virtuals curve via VIRTUAL',
        token,
        data: null,
      },
    ];
  },
  async quote(ctx, ref, side, amounts) {
    const d = VIRTUALS[ctx.chain.id] as VirtualsDeployment;
    const bridge = bridgeRef(ctx, d);
    const curve = curveQuote(ctx, d, ref.token);
    const pick = (xs: (bigint | null)[]) => xs.map((x) => (x && x > 0n ? x : null));
    if (side === 'buy') {
      const asset = pick(await uniswapVenue.quote(ctx, bridge, 'buy', amounts));
      const live = asset.flatMap((a, i) => (a ? [i] : []));
      const outs = await curve(
        'buy',
        live.map((i) => asset[i] as bigint),
      );
      const result: (bigint | null)[] = amounts.map(() => null);
      live.forEach((i, k) => (result[i] = outs[k] ?? null));
      return result;
    }
    const asset = pick(await curve('sell', amounts));
    const live = asset.flatMap((a, i) => (a ? [i] : []));
    const outs = await uniswapVenue.quote(
      ctx,
      bridge,
      'sell',
      live.map((i) => asset[i] as bigint),
    );
    const result: (bigint | null)[] = amounts.map(() => null);
    live.forEach((i, k) => (result[i] = outs[k] ?? null));
    return result;
  },
  // Amounts here are in VIRTUAL (buy) or tokens (sell); the engine funds the buy first.
  buildBuy(ctx, ref, p) {
    const d = VIRTUALS[ctx.chain.id] as VirtualsDeployment;
    return {
      to: d.bonding,
      data: encodeFunctionData({
        abi: bondingAbi,
        functionName: 'buy',
        args: [p.amountIn, ref.token, p.minOut, p.deadline],
      }),
      value: 0n,
    };
  },
  buildSell(ctx, ref, p) {
    const d = VIRTUALS[ctx.chain.id] as VirtualsDeployment;
    return {
      to: d.bonding,
      data: encodeFunctionData({
        abi: bondingAbi,
        functionName: 'sell',
        args: [p.amountIn, ref.token, p.minOut, p.deadline],
      }),
      value: 0n,
    };
  },
  sellApproval(ctx) {
    const d = VIRTUALS[ctx.chain.id] as VirtualsDeployment;
    return { spender: d.router, viaPermit2: false, router: d.bonding };
  },
  funding(ctx, ref): Funding {
    const d = VIRTUALS[ctx.chain.id] as VirtualsDeployment;
    const curve = curveQuote(ctx, d, ref.token);
    return {
      asset: d.asset,
      symbol: 'VIRTUAL',
      leg: bridgeRef(ctx, d),
      quoteAsset: (_ctx, side, amounts) => curve(side, amounts),
    };
  },
  poolRules(ctx) {
    const d = VIRTUALS[ctx.chain.id] as VirtualsDeployment;
    return [
      [d.bonding, bondingRule()],
      [d.router, spenderRule],
    ];
  },
};
