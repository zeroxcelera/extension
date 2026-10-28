import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import { act as label } from './actions';
import { erc20Abi } from '../chain/abis';
import { findLeg, quoteLeg } from './legs';
import type {
  BuyParams,
  Funding,
  PoolRef,
  SellParams,
  Side,
  TxDraft,
  Venue,
  VenueCtx,
} from './types';
import { chainQuotes } from './uniswap/venue';
import { virtualsVenue } from './virtuals';
import {
  isOwn,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from './validator';

/**
 * Bonding-curve launchpads. A token is only routed here while it is still on its
 * curve; after graduation it trades on a DEX and the AMM venues pick it up. Curves quoted
 * in an ERC-20 the launchpad cannot buy with native itself are funded through the best
 * native ↔ asset AMM pool (`legs.ts`).
 *
 * Contract facts were verified on-chain: four.meme/Flap selectors are present in the
 * deployed bytecode, the Pons curve ABI is verified on the explorer, and every flow
 * (buy → approve → sell) was simulated against mainnet state.
 */

/** A quote asset's symbol for route labels (plain text, shortened). */
async function symbolOf(ctx: VenueCtx, asset: Address): Promise<string> {
  const s = await ctx.client
    .readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' })
    .catch(() => '');
  return s.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 12) || 'quote';
}

/** native → asset, then asset → token (buy); token → asset, then asset → native (sell). */
function fundedQuote(
  ctx: VenueCtx,
  leg: PoolRef,
  curve: (side: Side, amounts: readonly bigint[]) => Promise<(bigint | null)[]>,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const swap = (s: Side) => (a: readonly bigint[]) => quoteLeg(ctx, leg, s, a);
  const own = (s: Side) => (a: readonly bigint[]) => curve(s, a);
  return side === 'buy'
    ? chainQuotes(amounts, swap('buy'), own('buy'))
    : chainQuotes(amounts, own('sell'), swap('sell'));
}

// ── four.meme (BSC) ──────────────────────────────────────────────────────────

const FOUR_TM: Address = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const FOUR_HELPER: Address = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';
/** four.meme trades token amounts in whole multiples of 1e9 units. */
const FOUR_UNIT = 10n ** 9n;

/**
 * A curve quoted in a BEP-20 asset (USDT, USD1, tokenised stocks...). four.meme's helper
 * swaps BNB into that asset and back inside the same call; `leg` only prices that swap.
 */
interface FourPool {
  quote?: Address;
  leg?: PoolRef;
}

const fourPool = (ref: PoolRef) => (ref.data ?? {}) as FourPool;

const fourAbi = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
  'function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) payable',
  'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)',
  'function buyWithEth(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
  // The manager pulls the tokens from tx.origin: only ever sent by the wallet itself.
  'function sellForEth(uint256 origin, address token, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)',
]);

const fourRule: ExtraContractRule = {
  label: 'four.meme',
  approvalSpender: true,
  validate(tx, ctx) {
    let call;
    try {
      call = decodeFunctionData({ abi: fourAbi, data: tx.data });
    } catch {
      return [label('four.meme call', 'Unknown function')];
    }
    if (call.functionName === 'buyTokenAMAP') {
      const [token, to, funds, minAmount] = call.args;
      const l = 'four.meme buy';
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (!isOwn(ctx, to)) return [label(l, 'Recipient is not one of your wallets')];
      if (minAmount === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (tx.value !== funds) return [label(l, 'Value does not match funds')];
      return [label(l)];
    }
    if (call.functionName === 'sellToken') {
      const [origin, token, , minFunds] = call.args;
      const l = 'four.meme sell';
      if (origin !== 0n) return [label(l, 'Unexpected origin')];
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (minFunds === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
      return [label(l)];
    }
    return [label(`four.meme ${call.functionName}`, 'Not a trade')];
  },
};

const fourHelperRule: ExtraContractRule = {
  label: 'four.meme helper',
  validate(tx, ctx) {
    let call;
    try {
      call = decodeFunctionData({ abi: fourAbi, data: tx.data });
    } catch {
      return [label('four.meme helper call', 'Unknown function')];
    }
    if (call.functionName === 'buyWithEth') {
      const [origin, token, to, funds, minAmount] = call.args;
      const l = 'four.meme buy';
      if (origin !== 0n) return [label(l, 'Unexpected origin')];
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (!isOwn(ctx, to)) return [label(l, 'Recipient is not one of your wallets')];
      if (minAmount === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (tx.value !== funds) return [label(l, 'Value does not match funds')];
      return [label(l)];
    }
    if (call.functionName === 'sellForEth') {
      const [origin, token, , minFunds, feeRate, feeRecipient] = call.args;
      const l = 'four.meme sell';
      if (origin !== 0n) return [label(l, 'Unexpected origin')];
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (minFunds === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (feeRate !== 0n || feeRecipient !== zeroAddress)
        return [label(l, 'Pays a fee to a third party')];
      if (tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
      return [label(l)];
    }
    return [label(`four.meme ${call.functionName}`, 'Not a trade')];
  },
};

/** tryBuy: tokens for an amount of the quote asset; trySell: quote asset for tokens. */
async function fourCurveQuote(
  ctx: VenueCtx,
  token: Address,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const res = await ctx.client.multicall({
    allowFailure: true,
    contracts: amounts.map((a) =>
      side === 'buy'
        ? ({
            address: FOUR_HELPER,
            abi: fourAbi,
            functionName: 'tryBuy',
            args: [token, 0n, a],
          } as const)
        : ({
            address: FOUR_HELPER,
            abi: fourAbi,
            functionName: 'trySell',
            args: [token, (a / FOUR_UNIT) * FOUR_UNIT],
          } as const),
    ),
  });
  return res.map((r) =>
    r.status === 'success' ? ((r.result as readonly unknown[])[2] as bigint) : null,
  );
}

const fourVenue: Venue = {
  id: 'fourmeme',
  supports: (chainId) => chainId === 56,
  async discover(ctx, token) {
    const info = await ctx.client
      .readContract({
        address: FOUR_HELPER,
        abi: fourAbi,
        functionName: 'getTokenInfo',
        args: [token],
      })
      .catch(() => null);
    if (!info) return [];
    const [version, manager, quote, , , , , , , , , liquidityAdded] = info;
    if (version !== 2n || !isAddressEqual(manager, FOUR_TM) || liquidityAdded) return [];
    const id = `four:${token.toLowerCase()}`;
    if (quote === zeroAddress)
      return [{ venueId: 'fourmeme', id, label: 'four.meme curve', token, data: {} }];
    const leg = await findLeg(ctx, quote);
    if (!leg) return [];
    return [
      {
        venueId: 'fourmeme',
        id,
        label: `four.meme curve via ${await symbolOf(ctx, quote)}`,
        token,
        data: { quote, leg } satisfies FourPool,
      },
    ];
  },
  quote(ctx, ref, side, amounts) {
    const { leg } = fourPool(ref);
    const curve = (s: Side, a: readonly bigint[]) => fourCurveQuote(ctx, ref.token, s, a);
    return leg ? fundedQuote(ctx, leg, curve, side, amounts) : curve(side, amounts);
  },
  buildBuy(_ctx, ref, p) {
    if (fourPool(ref).quote)
      return {
        to: FOUR_HELPER,
        data: encodeFunctionData({
          abi: fourAbi,
          functionName: 'buyWithEth',
          args: [0n, ref.token, p.wallet, p.amountIn, p.minOut],
        }),
        value: p.amountIn,
      };
    return {
      to: FOUR_TM,
      data: encodeFunctionData({
        abi: fourAbi,
        functionName: 'buyTokenAMAP',
        args: [ref.token, p.wallet, p.amountIn, p.minOut],
      }),
      value: p.amountIn,
    };
  },
  buildSell(_ctx, ref, p) {
    const amount = (p.amountIn / FOUR_UNIT) * FOUR_UNIT;
    if (fourPool(ref).quote)
      return {
        to: FOUR_HELPER,
        data: encodeFunctionData({
          abi: fourAbi,
          functionName: 'sellForEth',
          args: [0n, ref.token, amount, p.minOut, 0n, zeroAddress],
        }),
        value: 0n,
      };
    return {
      to: FOUR_TM,
      data: encodeFunctionData({
        abi: fourAbi,
        functionName: 'sellToken',
        args: [0n, ref.token, amount, p.minOut],
      }),
      value: 0n,
    };
  },
  // The manager pulls the tokens either way.
  sellApproval: (_ctx, ref) => ({
    spender: FOUR_TM,
    viaPermit2: false,
    router: fourPool(ref).quote ? FOUR_HELPER : FOUR_TM,
  }),
  poolRules: (_ctx, ref) =>
    fourPool(ref).quote
      ? [
          [FOUR_TM, fourRule],
          [FOUR_HELPER, fourHelperRule],
        ]
      : [[FOUR_TM, fourRule]],
};

// ── Flap (BSC, Base, Robinhood) ──────────────────────────────────────────────

/** Portals per chain (Flap has redeployed on Base; older tokens stay on the old one). */
const FLAP_PORTALS: Record<number, Address[]> = {
  56: ['0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0'],
  8453: [
    '0x0000bc1c4fd15dd79029af8f5d77d68ae4490000',
    '0x00214f8C22A076575f4B67f3B4AA62f99E166e36',
  ],
  4663: ['0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09'],
};

interface FlapPool {
  portal: Address;
  /**
   * Set for a curve quoted in an ERC-20 the portal cannot buy with native itself
   * (`nativeToQuoteSwapEnabled` false): it trades in that asset, funded through `leg`.
   */
  quote?: Address;
  symbol?: string;
  leg?: PoolRef;
}

const flapPool = (ref: PoolRef) => ref.data as FlapPool;
/** getTokenV3 status: 1 = trading on the curve. */
const FLAP_TRADABLE = 1;
const FLAP_FEE_BPS = 100;

const flapAbi = parseAbi([
  'function getTokenV3(address token) view returns (uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 dexSupplyThresh, address quoteToken, bool nativeToQuoteSwapEnabled)',
  'function quoteExactInput((address inputToken, address outputToken, uint256 inputAmount)) returns (uint256)',
  'function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData)) payable returns (uint256)',
]);

function flapRule(quote: Address | undefined): ExtraContractRule {
  // What the curve trades against: native (address 0) or the pool's ERC-20.
  const asset = quote ?? zeroAddress;
  return {
    label: 'Flap',
    approvalSpender: true,
    validate(tx, ctx) {
      let call;
      try {
        call = decodeFunctionData({ abi: flapAbi, data: tx.data });
      } catch {
        return [label('Flap call', 'Unknown function')];
      }
      if (call.functionName !== 'swapExactInput')
        return [label(`Flap ${call.functionName}`, 'Not a trade')];
      const [s] = call.args;
      const l = 'Flap swap';
      const isTok = (a: Address) => !!ctx.token && isAddressEqual(a, ctx.token);
      const buy = isAddressEqual(s.inputToken, asset) && isTok(s.outputToken);
      const sell = isTok(s.inputToken) && isAddressEqual(s.outputToken, asset);
      if (!buy && !sell) return [label(l, 'Unexpected assets')];
      if (s.permitData !== '0x') return [label(l, 'Embedded permits are not allowed')];
      if (s.minOutputAmount === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (buy && tx.value !== (quote ? 0n : s.inputAmount))
        return [label(l, 'Value does not match input')];
      if (sell && tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
      // Output goes to msg.sender (the validated `from`).
      return [label(l)];
    },
  };
}

/** Curve quotes in the curve's own asset (native, or the pool's ERC-20). */
async function flapCurveQuote(
  ctx: VenueCtx,
  ref: PoolRef,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const { portal, quote } = flapPool(ref);
  const asset = quote ?? zeroAddress;
  const [inputToken, outputToken] = side === 'buy' ? [asset, ref.token] : [ref.token, asset];
  const res = await ctx.client.multicall({
    allowFailure: true,
    contracts: amounts.map(
      (inputAmount) =>
        ({
          address: portal,
          abi: flapAbi,
          functionName: 'quoteExactInput',
          args: [{ inputToken, outputToken, inputAmount }],
        }) as const,
    ),
  });
  return res.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
}

function flapSwap(ref: PoolRef, side: Side, p: BuyParams): TxDraft {
  const { portal, quote } = flapPool(ref);
  const asset = quote ?? zeroAddress;
  const [inputToken, outputToken] = side === 'buy' ? [asset, ref.token] : [ref.token, asset];
  return {
    to: portal,
    data: encodeFunctionData({
      abi: flapAbi,
      functionName: 'swapExactInput',
      args: [
        {
          inputToken,
          outputToken,
          inputAmount: p.amountIn,
          minOutputAmount: p.minOut,
          permitData: '0x',
        },
      ],
    }),
    value: side === 'buy' && !quote ? p.amountIn : 0n,
  };
}

const flapVenue: Venue = {
  id: 'flap',
  supports: (chainId) => chainId in FLAP_PORTALS,
  async discover(ctx, token) {
    const portals = FLAP_PORTALS[ctx.chain.id] ?? [];
    const infos = await Promise.all(
      portals.map((portal) =>
        ctx.client
          .readContract({
            address: portal,
            abi: flapAbi,
            functionName: 'getTokenV3',
            args: [token],
          })
          .catch(() => null),
      ),
    );
    const live = infos.map((info) => (info && info[0] === FLAP_TRADABLE ? info : null));
    const id = `flap:${token.toLowerCase()}`;
    // Native in and out: native-quoted, or the portal swaps native into the quote itself.
    const direct = live.findIndex((i) => !!i && (i[7] === zeroAddress || i[8]));
    const directPortal = portals[direct];
    if (directPortal) {
      const data: FlapPool = { portal: directPortal };
      return [{ venueId: 'flap', id, label: 'Flap curve', token, data }];
    }
    const at = live.findIndex((i) => !!i);
    const info = live[at];
    const portal = portals[at];
    if (!info || !portal) return [];
    const quote = info[7];
    const leg = await findLeg(ctx, quote);
    if (!leg) return [];
    const symbol = await symbolOf(ctx, quote);
    return [
      {
        venueId: 'flap',
        id,
        label: `Flap curve via ${symbol}`,
        token,
        data: { portal, quote, symbol, leg } satisfies FlapPool,
      },
    ];
  },
  // Flap's 1% trading fee, already in its quotes. Token taxes are read from the token.
  venueTax: async () => ({ buyBps: FLAP_FEE_BPS, sellBps: FLAP_FEE_BPS }),
  quote(ctx, ref, side, amounts) {
    const { leg } = flapPool(ref);
    const curve = (s: Side, a: readonly bigint[]) => flapCurveQuote(ctx, ref, s, a);
    return leg ? fundedQuote(ctx, leg, curve, side, amounts) : curve(side, amounts);
  },
  // On a funded pool, amounts are in the quote asset (buy) or tokens (sell).
  buildBuy: (_ctx, ref, p) => flapSwap(ref, 'buy', p),
  buildSell: (_ctx, ref, p) => flapSwap(ref, 'sell', p),
  sellApproval: (_ctx, ref) => {
    const { portal } = flapPool(ref);
    return { spender: portal, viaPermit2: false, router: portal };
  },
  funding(_ctx, ref): Funding | undefined {
    const { quote, symbol, leg } = flapPool(ref);
    if (!quote || !leg) return undefined;
    return {
      asset: quote,
      symbol: symbol ?? 'quote',
      leg,
      quoteAsset: (ctx, side, amounts) => flapCurveQuote(ctx, ref, side, amounts),
    };
  },
  poolRules: (_ctx, ref) => {
    const { portal, quote } = flapPool(ref);
    return [[portal, flapRule(quote)]];
  },
};

// ── Pons (Robinhood Chain) ───────────────────────────────────────────────────

const PONS_FACTORY: Address = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

const ponsTokenAbi = parseAbi(['function curve() view returns (address)']);
const ponsCurveAbi = parseAbi([
  'function token() view returns (address)',
  'function factory() view returns (address)',
  'function graduated() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);

interface PonsPool {
  curve: Address;
  /** Set for a curve quoted in an ERC-20 (e.g. USDG): it trades in that asset, funded through `leg`. */
  quote?: Address;
  symbol?: string;
  leg?: PoolRef;
}

function ponsRule(nativeQuote: boolean): ExtraContractRule {
  return {
    label: 'Pons curve',
    approvalSpender: true,
    validate(tx, ctx) {
      let call;
      try {
        call = decodeFunctionData({ abi: ponsCurveAbi, data: tx.data });
      } catch {
        return [label('Pons call', 'Unknown function')];
      }
      if (call.functionName === 'buy') {
        const [quoteIn, minOut, recipient] = call.args;
        const l = 'Pons buy';
        if (!isOwn(ctx, recipient)) return [label(l, 'Recipient is not one of your wallets')];
        if (minOut === 0n) return [label(l, 'No minimum output (no slippage protection)')];
        if (tx.value !== (nativeQuote ? quoteIn : 0n))
          return [label(l, 'Value does not match input')];
        return [label(l)];
      }
      if (call.functionName === 'sell') {
        const [, minOut, recipient] = call.args;
        const l = 'Pons sell';
        if (!isOwn(ctx, recipient)) return [label(l, 'Recipient is not one of your wallets')];
        if (minOut === 0n) return [label(l, 'No minimum output (no slippage protection)')];
        if (tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
        return [label(l)];
      }
      return [label(`Pons ${call.functionName}`, 'Not a trade')];
    },
  };
}

/** Constant product on the curve's (virtual) reserves, after fee + taxes. */
function ponsQuote(
  side: Side,
  amountIn: bigint,
  quoteReserve: bigint,
  tokenReserve: bigint,
  totalFeeBps: bigint,
): bigint {
  if (amountIn <= 0n || quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  if (side === 'buy') {
    const net = (amountIn * (10_000n - totalFeeBps)) / 10_000n;
    return (tokenReserve * net) / (quoteReserve + net);
  }
  const gross = (quoteReserve * amountIn) / (tokenReserve + amountIn);
  return (gross * (10_000n - totalFeeBps)) / 10_000n;
}

/** Curve quotes in the curve's own asset (native, or the pool's ERC-20). */
async function ponsCurveQuote(
  ctx: VenueCtx,
  curve: Address,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const [res, fee, tax, snipe] = await ctx.client.multicall({
    allowFailure: false,
    contracts: [
      { address: curve, abi: ponsCurveAbi, functionName: 'getReserves' },
      { address: curve, abi: ponsCurveAbi, functionName: 'feeBps' },
      { address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' },
      {
        address: curve,
        abi: ponsCurveAbi,
        functionName: 'currentSnipeTaxBps',
        args: [zeroAddress],
      },
    ],
  });
  const [q, t] = res as readonly [bigint, bigint];
  const totalFee = (fee as bigint) + (tax as bigint) + (snipe as bigint);
  return amounts.map((a) => ponsQuote(side, a, q, t, totalFee));
}

const ponsVenue: Venue = {
  id: 'pons',
  supports: (chainId) => chainId === 4663,
  async discover(ctx, token) {
    const curve = await ctx.client
      .readContract({ address: token, abi: ponsTokenAbi, functionName: 'curve' })
      .catch(() => null);
    if (!curve || curve === zeroAddress) return [];
    const r = await ctx.client.multicall({
      allowFailure: true,
      contracts: [
        { address: curve, abi: ponsCurveAbi, functionName: 'token' },
        { address: curve, abi: ponsCurveAbi, functionName: 'factory' },
        { address: curve, abi: ponsCurveAbi, functionName: 'graduated' },
        { address: curve, abi: ponsCurveAbi, functionName: 'isNativeQuote' },
        { address: curve, abi: ponsCurveAbi, functionName: 'pairToken' },
      ],
    });
    const [t, f, g, n, q] = r.map((x) => (x.status === 'success' ? x.result : null));
    if (!t || !isAddressEqual(t as Address, token)) return [];
    if (!f || !isAddressEqual(f as Address, PONS_FACTORY)) return [];
    if (g !== false || typeof n !== 'boolean') return [];
    const id = `pons:${curve.toLowerCase()}`;
    if (n) {
      const data: PonsPool = { curve };
      return [{ venueId: 'pons', id, label: 'Pons curve', token, data }];
    }
    const quote = q as Address | null;
    if (!quote || quote === zeroAddress) return [];
    const leg = await findLeg(ctx, quote);
    if (!leg) return [];
    const symbol = await symbolOf(ctx, quote);
    return [
      {
        venueId: 'pons',
        id,
        label: `Pons curve via ${symbol}`,
        token,
        data: { curve, quote, symbol, leg } satisfies PonsPool,
      },
    ];
  },
  quote(ctx, ref, side, amounts) {
    const { curve, leg } = ref.data as PonsPool;
    const own = (s: Side, a: readonly bigint[]) => ponsCurveQuote(ctx, curve, s, a);
    return leg ? fundedQuote(ctx, leg, own, side, amounts) : own(side, amounts);
  },
  // On a funded pool, amounts are in the quote asset (buy) or tokens (sell).
  buildBuy(_ctx, ref, p) {
    const { curve, quote } = ref.data as PonsPool;
    return {
      to: curve,
      data: encodeFunctionData({
        abi: ponsCurveAbi,
        functionName: 'buy',
        args: [p.amountIn, p.minOut, p.wallet],
      }),
      value: quote ? 0n : p.amountIn,
    };
  },
  buildSell(_ctx, ref, p) {
    const { curve } = ref.data as PonsPool;
    return {
      to: curve,
      data: encodeFunctionData({
        abi: ponsCurveAbi,
        functionName: 'sell',
        args: [p.amountIn, p.minOut, p.wallet],
      }),
      value: 0n,
    };
  },
  sellApproval: (_ctx, ref) => {
    const { curve } = ref.data as PonsPool;
    return { spender: curve, viaPermit2: false, router: curve };
  },
  funding(_ctx, ref): Funding | undefined {
    const { curve, quote, symbol, leg } = ref.data as PonsPool;
    if (!quote || !leg) return undefined;
    return {
      asset: quote,
      symbol: symbol ?? 'quote',
      leg,
      quoteAsset: (ctx, side, amounts) => ponsCurveQuote(ctx, curve, side, amounts),
    };
  },
  async venueTax(ctx, ref) {
    const { curve } = ref.data as PonsPool;
    const [fee, tax, snipe] = await ctx.client.multicall({
      allowFailure: false,
      contracts: [
        { address: curve, abi: ponsCurveAbi, functionName: 'feeBps' },
        { address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' },
        {
          address: curve,
          abi: ponsCurveAbi,
          functionName: 'currentSnipeTaxBps',
          args: [zeroAddress],
        },
      ],
    });
    // All three apply to either side (see quote()). The platform fee is counted too, as
    // terminals such as GMGN show it in the total.
    const bps = Number((fee as bigint) + (tax as bigint) + (snipe as bigint));
    return { buyBps: bps, sellBps: bps };
  },
  poolRules: (_ctx, ref) => {
    const { curve, quote } = ref.data as PonsPool;
    return [[curve, ponsRule(!quote)]];
  },
};

export const launchpadVenues: Venue[] = [fourVenue, flapVenue, ponsVenue, virtualsVenue];

/** Static rules (none: launchpad rules come with the pool via Venue.poolRules). */
export function launchpadRules(chainId: number): ReadonlyMap<string, ExtraContractRule> {
  void chainId;
  return new Map();
}

export type { BuyParams, PoolRef, SellParams, TxDraft, TxToValidate, ValidationContext, VenueCtx };
