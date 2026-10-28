import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  numberToHex,
  parseAbi,
  parseAbiParameters,
  sliceHex,
  size,
  type Address,
  type Hex,
} from 'viem';

/**
 * Universal Router v2.1.2 command encoding (Uniswap/universal-router@802fe4c,
 * v4-periphery@545a5d2). Only the commands Celera uses are supported; the decoder
 * rejects everything else, which is what the transaction validator relies on.
 */

const URAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

const CMD = {
  V3_SWAP_EXACT_IN: 0x00,
  SWEEP: 0x04,
  V2_SWAP_EXACT_IN: 0x08,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

const V4_ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

/** Recipient placeholders understood by the router. */
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
export const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
export const NATIVE: Address = '0x0000000000000000000000000000000000000000';
/** v4 "use the full open delta" amount. */
export const OPEN_DELTA = 0n;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PermitSingle {
  details: { token: Address; amount: bigint; expiration: number; nonce: number };
  spender: Address;
  sigDeadline: bigint;
}

export type V4Action =
  | {
      type: 'SWAP_EXACT_IN_SINGLE';
      poolKey: PoolKey;
      zeroForOne: boolean;
      amountIn: bigint;
      amountOutMinimum: bigint;
      minHopPriceX36: bigint;
      hookData: Hex;
    }
  | { type: 'SETTLE'; currency: Address; amount: bigint; payerIsUser: boolean }
  | { type: 'SETTLE_ALL'; currency: Address; maxAmount: bigint }
  | { type: 'TAKE'; currency: Address; recipient: Address; amount: bigint }
  | { type: 'TAKE_ALL'; currency: Address; minAmount: bigint };

export interface V3Hop {
  tokenIn: Address;
  fee: number;
  tokenOut: Address;
}

export type Command =
  | { type: 'WRAP_ETH'; recipient: Address; amount: bigint }
  | { type: 'UNWRAP_WETH'; recipient: Address; amountMin: bigint }
  | { type: 'SWEEP'; token: Address; recipient: Address; amountMin: bigint }
  | {
      type: 'V2_SWAP_EXACT_IN';
      recipient: Address;
      amountIn: bigint;
      amountOutMin: bigint;
      path: Address[];
      payerIsUser: boolean;
    }
  | {
      type: 'V3_SWAP_EXACT_IN';
      recipient: Address;
      amountIn: bigint;
      amountOutMin: bigint;
      path: V3Hop[];
      payerIsUser: boolean;
    }
  | { type: 'PERMIT2_PERMIT'; permit: PermitSingle; signature: Hex }
  | { type: 'V4_SWAP'; actions: V4Action[] };

// ── ABI parameter layouts ─────────────────────────────────────────────────────

const P = {
  addrUint: parseAbiParameters('address, uint256'),
  addrAddrUint: parseAbiParameters('address, address, uint256'),
  v2: parseAbiParameters('address, uint256, uint256, address[], bool, uint256[]'),
  v3: parseAbiParameters('address, uint256, uint256, bytes, bool, uint256[]'),
  permit: parseAbiParameters(
    '((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline), bytes',
  ),
  v4Swap: parseAbiParameters('bytes, bytes[]'),
  v4ExactInSingle: parseAbiParameters(
    '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
  ),
  settle: parseAbiParameters('address, uint256, bool'),
  currencyUint: parseAbiParameters('address, uint256'),
  take: parseAbiParameters('address, address, uint256'),
};

// ── V3 path ─────────────────────────────────────────────────────────────────

export function encodeV3Path(hops: V3Hop[]): Hex {
  const first = hops[0];
  if (!first) throw new Error('empty v3 path');
  const parts: Hex[] = [first.tokenIn];
  for (const h of hops) parts.push(numberToHex(h.fee, { size: 3 }), h.tokenOut);
  return concatHex(parts);
}

export function decodeV3Path(path: Hex): V3Hop[] {
  const len = size(path);
  if (len < 43 || (len - 20) % 23 !== 0) throw new Error('bad v3 path');
  const hops: V3Hop[] = [];
  for (let o = 0; o + 43 <= len; o += 23) {
    hops.push({
      tokenIn: getAddress(sliceHex(path, o, o + 20)),
      fee: Number(BigInt(sliceHex(path, o + 20, o + 23))),
      tokenOut: getAddress(sliceHex(path, o + 23, o + 43)),
    });
  }
  return hops;
}

// ── encode ──────────────────────────────────────────────────────────────────

function encodeV4Action(a: V4Action): Hex {
  switch (a.type) {
    case 'SWAP_EXACT_IN_SINGLE':
      return encodeAbiParameters(P.v4ExactInSingle, [
        {
          poolKey: a.poolKey,
          zeroForOne: a.zeroForOne,
          amountIn: a.amountIn,
          amountOutMinimum: a.amountOutMinimum,
          minHopPriceX36: a.minHopPriceX36,
          hookData: a.hookData,
        },
      ]);
    case 'SETTLE':
      return encodeAbiParameters(P.settle, [a.currency, a.amount, a.payerIsUser]);
    case 'SETTLE_ALL':
      return encodeAbiParameters(P.currencyUint, [a.currency, a.maxAmount]);
    case 'TAKE':
      return encodeAbiParameters(P.take, [a.currency, a.recipient, a.amount]);
    case 'TAKE_ALL':
      return encodeAbiParameters(P.currencyUint, [a.currency, a.minAmount]);
  }
}

function encodeInput(c: Command): Hex {
  switch (c.type) {
    case 'WRAP_ETH':
      return encodeAbiParameters(P.addrUint, [c.recipient, c.amount]);
    case 'UNWRAP_WETH':
      return encodeAbiParameters(P.addrUint, [c.recipient, c.amountMin]);
    case 'SWEEP':
      return encodeAbiParameters(P.addrAddrUint, [c.token, c.recipient, c.amountMin]);
    case 'V2_SWAP_EXACT_IN':
      return encodeAbiParameters(P.v2, [
        c.recipient,
        c.amountIn,
        c.amountOutMin,
        c.path,
        c.payerIsUser,
        [],
      ]);
    case 'V3_SWAP_EXACT_IN':
      return encodeAbiParameters(P.v3, [
        c.recipient,
        c.amountIn,
        c.amountOutMin,
        encodeV3Path(c.path),
        c.payerIsUser,
        [],
      ]);
    case 'PERMIT2_PERMIT':
      return encodeAbiParameters(P.permit, [c.permit, c.signature]);
    case 'V4_SWAP': {
      const actions = concatHex(c.actions.map((a) => numberToHex(V4_ACTION[a.type], { size: 1 })));
      return encodeAbiParameters(P.v4Swap, [actions, c.actions.map(encodeV4Action)]);
    }
  }
}

export function encodeExecute(commands: Command[], deadline: bigint): Hex {
  const cmdBytes = concatHex(commands.map((c) => numberToHex(CMD[c.type], { size: 1 })));
  return encodeFunctionData({
    abi: URAbi,
    functionName: 'execute',
    args: [cmdBytes, commands.map(encodeInput), deadline],
  });
}

// ── decode (used by the validator; throws on anything unknown) ──────────────

export class DecodeError extends Error {}

function decodeV4Actions(input: Hex): V4Action[] {
  const [actionBytes, params] = decodeAbiParameters(P.v4Swap, input);
  const n = size(actionBytes);
  if (n !== params.length) throw new DecodeError('v4 actions/params length mismatch');
  const out: V4Action[] = [];
  for (let i = 0; i < n; i++) {
    const code = Number(BigInt(sliceHex(actionBytes, i, i + 1)));
    const p = params[i] as Hex;
    switch (code) {
      case V4_ACTION.SWAP_EXACT_IN_SINGLE: {
        const [s] = decodeAbiParameters(P.v4ExactInSingle, p);
        out.push({ type: 'SWAP_EXACT_IN_SINGLE', ...s, poolKey: { ...s.poolKey } });
        break;
      }
      case V4_ACTION.SETTLE: {
        const [currency, amount, payerIsUser] = decodeAbiParameters(P.settle, p);
        out.push({ type: 'SETTLE', currency, amount, payerIsUser });
        break;
      }
      case V4_ACTION.SETTLE_ALL: {
        const [currency, maxAmount] = decodeAbiParameters(P.currencyUint, p);
        out.push({ type: 'SETTLE_ALL', currency, maxAmount });
        break;
      }
      case V4_ACTION.TAKE: {
        const [currency, recipient, amount] = decodeAbiParameters(P.take, p);
        out.push({ type: 'TAKE', currency, recipient, amount });
        break;
      }
      case V4_ACTION.TAKE_ALL: {
        const [currency, minAmount] = decodeAbiParameters(P.currencyUint, p);
        out.push({ type: 'TAKE_ALL', currency, minAmount });
        break;
      }
      default:
        throw new DecodeError(`unsupported v4 action 0x${code.toString(16).padStart(2, '0')}`);
    }
  }
  return out;
}

function decodeInput(code: number, input: Hex): Command {
  switch (code) {
    case CMD.WRAP_ETH: {
      const [recipient, amount] = decodeAbiParameters(P.addrUint, input);
      return { type: 'WRAP_ETH', recipient, amount };
    }
    case CMD.UNWRAP_WETH: {
      const [recipient, amountMin] = decodeAbiParameters(P.addrUint, input);
      return { type: 'UNWRAP_WETH', recipient, amountMin };
    }
    case CMD.SWEEP: {
      const [token, recipient, amountMin] = decodeAbiParameters(P.addrAddrUint, input);
      return { type: 'SWEEP', token, recipient, amountMin };
    }
    case CMD.V2_SWAP_EXACT_IN: {
      const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(
        P.v2,
        input,
      );
      return {
        type: 'V2_SWAP_EXACT_IN',
        recipient,
        amountIn,
        amountOutMin,
        path: [...path],
        payerIsUser,
      };
    }
    case CMD.V3_SWAP_EXACT_IN: {
      const [recipient, amountIn, amountOutMin, path, payerIsUser] = decodeAbiParameters(
        P.v3,
        input,
      );
      return {
        type: 'V3_SWAP_EXACT_IN',
        recipient,
        amountIn,
        amountOutMin,
        path: decodeV3Path(path),
        payerIsUser,
      };
    }
    case CMD.PERMIT2_PERMIT: {
      const [permit, signature] = decodeAbiParameters(P.permit, input);
      return {
        type: 'PERMIT2_PERMIT',
        permit: {
          details: { ...permit.details },
          spender: permit.spender,
          sigDeadline: permit.sigDeadline,
        },
        signature,
      };
    }
    case CMD.V4_SWAP:
      return { type: 'V4_SWAP', actions: decodeV4Actions(input) };
    default:
      throw new DecodeError(`unsupported router command 0x${code.toString(16).padStart(2, '0')}`);
  }
}

export interface DecodedExecute {
  commands: Command[];
  deadline: bigint;
}

/** Decodes Universal Router calldata. Throws DecodeError for anything outside the subset. */
export function decodeExecute(data: Hex): DecodedExecute {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: URAbi, data });
  } catch {
    throw new DecodeError('not a Universal Router execute(bytes,bytes[],uint256) call');
  }
  const [cmdBytes, inputs, deadline] = decoded.args;
  const n = size(cmdBytes);
  if (n === 0 || n !== inputs.length) throw new DecodeError('commands/inputs length mismatch');
  const commands: Command[] = [];
  for (let i = 0; i < n; i++) {
    const raw = Number(BigInt(sliceHex(cmdBytes, i, i + 1)));
    if (raw & 0x80) throw new DecodeError('allow-revert flag is not permitted');
    try {
      commands.push(decodeInput(raw, inputs[i] as Hex));
    } catch (e) {
      if (e instanceof DecodeError) throw e;
      throw new DecodeError(`malformed input for command 0x${raw.toString(16)}`);
    }
  }
  return { commands, deadline };
}
