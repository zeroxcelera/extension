import { decodeFunctionData, formatEther, isAddressEqual, type Address, type Hex } from 'viem';
import type { ChainConfig } from '../../shared/chains';
import type { BlockedAction } from '../../shared/panel';
import { erc20WriteAbi } from '../chain/abis';
import { shortAddress as short } from '../../shared/wallet';
import { act } from './actions';
import { PERMIT2 } from './uniswap/addresses';
import {
  ADDRESS_THIS,
  DecodeError,
  MSG_SENDER,
  NATIVE,
  decodeExecute,
  type Command,
  type PermitSingle,
  type V4Action,
} from './uniswap/codec';

/**
 * Runs before EVERY signature (transactions and Permit2 typed data). Pure and
 * synchronous: no RPC, so it stays well under 5 ms. Anything not explicitly
 * understood is rejected.
 */

export interface ExtraContractRule {
  label: string;
  /** Returns the decoded actions; any action with ok=false blocks the tx. */
  validate(tx: TxToValidate, ctx: ValidationContext): BlockedAction[];
  /** Spenders this contract needs ERC-20 approvals for (e.g. a launchpad). */
  approvalSpender?: boolean;
}

export interface ValidationContext {
  chain: ChainConfig;
  from: Address;
  ownWallets: readonly Address[];
  /** The token being traded, if the action involves one. */
  token?: Address | undefined;
  /**
   * For a curve quoted in an ERC-20 (a funded route): that asset. Lets a Celera Router call
   * swap native ↔ this asset around the curve trade.
   */
  fundingAsset?: Address | undefined;
  /** Universal Router for this chain. */
  router?: Address | undefined;
  /** Launchpad contracts etc., keyed by lowercase address. */
  extraContracts?: ReadonlyMap<string, ExtraContractRule>;
  /** Upper bound for ERC-20 approve amounts. Required for approvals to pass. */
  maxApproval?: bigint | undefined;
  /** Upper bound for Permit2 permit amounts. Required for permits to pass. */
  maxPermit?: bigint | undefined;
  /** Max native value per transaction (derived from the USD limit). */
  maxValue: bigint;
  /**
   * An outside address the user typed and confirmed in the popup's Send screen.
   * Never set for anything the trading panel can trigger.
   */
  payee?: Address | undefined;
  nowS: number;
}

export interface TxToValidate {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface ValidationResult {
  ok: boolean;
  actions: BlockedAction[];
}

const MAX_DEADLINE_S = 30 * 60;
const MAX_PERMIT_TTL_S = 2 * 60 * 60;
const CONTRACT_BALANCE = 1n << 255n;

export function isOwn(ctx: ValidationContext, a: Address): boolean {
  return ctx.ownWallets.some((w) => isAddressEqual(w, a));
}

const isPayee = (ctx: ValidationContext, a: Address) => !!ctx.payee && isAddressEqual(ctx.payee, a);

function result(actions: BlockedAction[]): ValidationResult {
  return { ok: actions.length > 0 && actions.every((a) => a.ok), actions };
}

/**
 * The chain's listed stablecoins and hop tokens: allowed only as the hop between native
 * and the token.
 */
export function isStable(ctx: { chain: ChainConfig }, a: Address): boolean {
  return [...ctx.chain.stablecoins, ...(ctx.chain.hopTokens ?? [])].some((s) =>
    isAddressEqual(s.address, a),
  );
}

/** Assets a swap may touch: the traded token, native ETH/BNB, its wrapped form, stablecoins. */
function allowedAsset(ctx: ValidationContext, a: Address): boolean {
  return (
    isAddressEqual(a, NATIVE) ||
    isAddressEqual(a, ctx.chain.wrappedNative) ||
    isStable(ctx, a) ||
    (!!ctx.token && isAddressEqual(a, ctx.token))
  );
}

/** Where swap output may go: the router itself (to unwrap/settle), the sender, or own wallets. */
function recipientOk(ctx: ValidationContext, r: Address): boolean {
  return isAddressEqual(r, ADDRESS_THIS) || isAddressEqual(r, MSG_SENDER) || isOwn(ctx, r);
}

/** Recipients that end up with the user (excludes the router). */
function paysUser(ctx: ValidationContext, r: Address): boolean {
  return isAddressEqual(r, MSG_SENDER) || isOwn(ctx, r);
}

function checkPermit(permit: PermitSingle, ctx: ValidationContext): BlockedAction {
  const label = `Permit2: allow router to pull ${permit.details.amount} of ${short(permit.details.token)}`;
  if (!ctx.token || !isAddressEqual(permit.details.token, ctx.token))
    return act(label, 'Permit is for a different token');
  if (!ctx.router || !isAddressEqual(permit.spender, ctx.router))
    return act(label, 'Permit spender is not the router');
  if (ctx.maxPermit === undefined || permit.details.amount > ctx.maxPermit) {
    return act(label, 'Permit amount is above the amount being sold');
  }
  if (permit.details.expiration > ctx.nowS + MAX_PERMIT_TTL_S)
    return act(label, 'Permit expiry too long');
  if (permit.sigDeadline > BigInt(ctx.nowS + MAX_PERMIT_TTL_S))
    return act(label, 'Permit signature deadline too long');
  return act(label);
}

function checkV4(a: V4Action, ctx: ValidationContext, out: BlockedAction[]): boolean {
  switch (a.type) {
    case 'SWAP_EXACT_IN_SINGLE': {
      const { currency0, currency1 } = a.poolKey;
      const label = `v4 swap ${short(currency0)} / ${short(currency1)}`;
      const nativeSide = (c: Address) =>
        isAddressEqual(c, NATIVE) || isAddressEqual(c, ctx.chain.wrappedNative);
      // Native ↔ hop asset leg (e.g. ETH → flETH): its output stays inside the same
      // unlock as credit for the next swap, never with the router.
      const bridgeLeg =
        (nativeSide(currency0) && isStable(ctx, currency1)) ||
        (nativeSide(currency1) && isStable(ctx, currency0));
      if (!allowedAsset(ctx, currency0) || !allowedAsset(ctx, currency1)) {
        out.push(act(label, 'Pool contains an unexpected asset'));
      } else if (
        !bridgeLeg &&
        (!ctx.token ||
          (!isAddressEqual(currency0, ctx.token) && !isAddressEqual(currency1, ctx.token)))
      ) {
        out.push(act(label, 'Pool does not contain the traded token'));
      } else out.push(act(label));
      return false;
    }
    case 'SETTLE': {
      const label = `v4 settle ${short(a.currency)}${a.payerIsUser ? ' from wallet' : ' from router'}`;
      out.push(allowedAsset(ctx, a.currency) ? act(label) : act(label, 'Unexpected asset'));
      return false;
    }
    case 'SETTLE_ALL': {
      const label = `v4 settle all ${short(a.currency)}`;
      out.push(allowedAsset(ctx, a.currency) ? act(label) : act(label, 'Unexpected asset'));
      return false;
    }
    case 'TAKE': {
      const label = `v4 take ${short(a.currency)} → ${short(a.recipient)}`;
      if (!allowedAsset(ctx, a.currency)) out.push(act(label, 'Unexpected asset'));
      else if (!recipientOk(ctx, a.recipient))
        out.push(act(label, 'Recipient is not one of your wallets'));
      else out.push(act(label));
      return paysUser(ctx, a.recipient);
    }
    case 'TAKE_ALL': {
      const label = `v4 take all ${short(a.currency)} → sender`;
      out.push(allowedAsset(ctx, a.currency) ? act(label) : act(label, 'Unexpected asset'));
      return true;
    }
  }
}

function checkCommand(
  c: Command,
  ctx: ValidationContext,
  value: bigint,
  out: BlockedAction[],
): boolean {
  switch (c.type) {
    case 'WRAP_ETH': {
      const label = `Wrap ${c.amount === CONTRACT_BALANCE ? 'all' : formatEther(c.amount)} ${ctx.chain.nativeCurrency.symbol}`;
      if (!isAddressEqual(c.recipient, ADDRESS_THIS) && !isOwn(ctx, c.recipient)) {
        out.push(act(label, 'Wrapped funds go to an unknown address'));
      } else if (c.amount !== CONTRACT_BALANCE && c.amount > value) {
        out.push(act(label, 'Wraps more than the transaction value'));
      } else out.push(act(label));
      return isOwn(ctx, c.recipient);
    }
    case 'UNWRAP_WETH': {
      const label = `Unwrap to ${short(c.recipient)}`;
      out.push(
        paysUser(ctx, c.recipient)
          ? act(label)
          : act(label, 'Recipient is not one of your wallets'),
      );
      return paysUser(ctx, c.recipient);
    }
    case 'SWEEP': {
      const label = `Sweep ${short(c.token)} → ${short(c.recipient)}`;
      if (!allowedAsset(ctx, c.token)) out.push(act(label, 'Unexpected asset'));
      else if (!paysUser(ctx, c.recipient))
        out.push(act(label, 'Recipient is not one of your wallets'));
      else out.push(act(label));
      return paysUser(ctx, c.recipient);
    }
    case 'V2_SWAP_EXACT_IN':
    case 'V3_SWAP_EXACT_IN': {
      const tokens =
        c.type === 'V2_SWAP_EXACT_IN'
          ? c.path
          : [c.path[0]?.tokenIn, ...c.path.map((h) => h.tokenOut)];
      const label = `${c.type === 'V2_SWAP_EXACT_IN' ? 'v2' : 'v3'} swap ${tokens.map((t) => (t ? short(t) : '?')).join(' → ')}`;
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      const tradesToken =
        !!ctx.token &&
        !!first &&
        !!last &&
        (isAddressEqual(first, ctx.token) || isAddressEqual(last, ctx.token));
      // Native ↔ stable leg of a stable-quoted route: its output must stay in the router
      // for the next leg (checked for leftovers in validateUniversalRouter).
      const bridgeLeg =
        !tradesToken &&
        isAddressEqual(c.recipient, ADDRESS_THIS) &&
        tokens.some((t) => !!t && isStable(ctx, t));
      if (tokens.some((t) => !t || !allowedAsset(ctx, t)))
        out.push(act(label, 'Path contains an unexpected asset'));
      else if (!tradesToken && !bridgeLeg) {
        out.push(act(label, 'Path does not trade the selected token'));
      } else if (tokens.slice(1, -1).some((t) => !!t && !isStable(ctx, t))) {
        out.push(act(label, 'Only a stablecoin may sit between native and the token'));
      } else if (!recipientOk(ctx, c.recipient))
        out.push(act(label, 'Recipient is not one of your wallets'));
      else if (c.amountOutMin === 0n)
        out.push(act(label, 'No minimum output (no slippage protection)'));
      else out.push(act(label));
      return paysUser(ctx, c.recipient);
    }
    case 'PERMIT2_PERMIT':
      out.push(checkPermit(c.permit, ctx));
      return false;
    case 'V4_SWAP': {
      let pays = false;
      for (const a of c.actions) pays = checkV4(a, ctx, out) || pays;
      const swaps = c.actions.filter((a) => a.type === 'SWAP_EXACT_IN_SINGLE');
      if (swaps.some((s) => s.type === 'SWAP_EXACT_IN_SINGLE' && s.amountOutMinimum === 0n)) {
        out.push(act('v4 swap minimum output', 'No minimum output (no slippage protection)'));
      }
      return pays;
    }
  }
}

/**
 * A stablecoin a step leaves in the router must be used up by a later step (its whole
 * balance swapped on, or swept to you); anything left there could be taken by anyone.
 */
function strandedStables(commands: readonly Command[], ctx: ValidationContext): Address[] {
  const held = new Map<string, Address>();
  const put = (a: Address) => isStable(ctx, a) && held.set(a.toLowerCase(), a);
  const use = (a: Address) => held.delete(a.toLowerCase());
  for (const c of commands) {
    switch (c.type) {
      case 'V2_SWAP_EXACT_IN':
      case 'V3_SWAP_EXACT_IN': {
        const path =
          c.type === 'V2_SWAP_EXACT_IN'
            ? c.path
            : [c.path[0]?.tokenIn, ...c.path.map((h) => h.tokenOut)];
        const first = path[0];
        const last = path[path.length - 1];
        if (first && !c.payerIsUser && c.amountIn === CONTRACT_BALANCE) use(first);
        if (last && isAddressEqual(c.recipient, ADDRESS_THIS)) put(last);
        break;
      }
      case 'SWEEP':
        if (paysUser(ctx, c.recipient)) use(c.token);
        break;
      case 'V4_SWAP':
        for (const a of c.actions) {
          if (a.type === 'SETTLE' && !a.payerIsUser && a.amount === CONTRACT_BALANCE)
            use(a.currency);
          if (a.type === 'TAKE' && isAddressEqual(a.recipient, ADDRESS_THIS)) put(a.currency);
        }
        break;
      default:
        break;
    }
  }
  return [...held.values()];
}

/** Universal Router `execute`. Also used for router steps inside a Celera Router call. */
export function validateUniversalRouter(tx: TxToValidate, ctx: ValidationContext): BlockedAction[] {
  const out: BlockedAction[] = [];
  let decoded;
  try {
    decoded = decodeExecute(tx.data);
  } catch (e) {
    return [
      act('Universal Router call', e instanceof DecodeError ? e.message : 'Could not decode'),
    ];
  }
  const { commands, deadline } = decoded;
  if (deadline < BigInt(ctx.nowS) || deadline > BigInt(ctx.nowS + MAX_DEADLINE_S)) {
    out.push(act('Deadline', 'Deadline outside the allowed window'));
  }
  let paysOut = false;
  for (const c of commands) paysOut = checkCommand(c, ctx, tx.value, out) || paysOut;
  if (!paysOut) out.push(act('Output', 'No step sends the output to your wallet'));
  for (const s of strandedStables(commands, ctx)) {
    out.push(act(`Stablecoin ${short(s)}`, 'Left in the router instead of being swapped on'));
  }
  if (tx.value > 0n && !commands.some((c) => c.type === 'WRAP_ETH' || c.type === 'V4_SWAP')) {
    out.push(act('Value', 'Sends native funds without using them'));
  }
  return out;
}

function validateToken(tx: TxToValidate, ctx: ValidationContext): BlockedAction[] {
  if (tx.value !== 0n) return [act('Token call', 'Token calls must not carry native value')];
  let call;
  try {
    call = decodeFunctionData({ abi: erc20WriteAbi, data: tx.data });
  } catch {
    return [act(`Call to token ${short(tx.to)}`, 'Unknown function')];
  }
  if (call.functionName === 'approve') {
    const [spender, amount] = call.args;
    const label = `Approve ${short(spender)} for ${amount}`;
    const spenderOk =
      isAddressEqual(spender, PERMIT2) ||
      !!ctx.extraContracts?.get(spender.toLowerCase())?.approvalSpender;
    if (!spenderOk) return [act(label, 'Spender is not Permit2 or an allowlisted launchpad')];
    if (ctx.maxApproval === undefined || amount > ctx.maxApproval)
      return [act(label, 'Approval above the bounded amount')];
    return [act(label)];
  }
  const [to, amount] = call.args;
  const label = `Transfer ${amount} to ${short(to)}`;
  return [
    isOwn(ctx, to) || isPayee(ctx, to)
      ? act(label)
      : act(label, 'Recipient is not one of your wallets'),
  ];
}

export function validateTx(tx: TxToValidate, ctx: ValidationContext): ValidationResult {
  const pre: BlockedAction[] = [];
  if (!isOwn(ctx, ctx.from)) pre.push(act('Sender', 'Sender is not one of your wallets'));
  if (tx.value > ctx.maxValue) {
    pre.push(
      act(
        `Value ${formatEther(tx.value)} ${ctx.chain.nativeCurrency.symbol}`,
        'Above your per-transaction limit',
      ),
    );
  }

  let actions: BlockedAction[];
  const extra = ctx.extraContracts?.get(tx.to.toLowerCase());
  if (ctx.router && isAddressEqual(tx.to, ctx.router)) actions = validateUniversalRouter(tx, ctx);
  else if (ctx.token && isAddressEqual(tx.to, ctx.token)) actions = validateToken(tx, ctx);
  else if (extra) actions = extra.validate(tx, ctx);
  else if (isOwn(ctx, tx.to) || isPayee(ctx, tx.to)) {
    actions =
      tx.data === '0x'
        ? [
            act(
              `Send ${formatEther(tx.value)} ${ctx.chain.nativeCurrency.symbol} to ${short(tx.to)}`,
            ),
          ]
        : [act(`Call to ${short(tx.to)}`, 'Calls with data to a wallet are not allowed')];
  } else actions = [act(`Call to ${short(tx.to)}`, 'Contract is not on the allowlist')];

  return result([...pre, ...actions]);
}

/** Validates a Permit2 PermitSingle before it is signed. */
export function validatePermit(permit: PermitSingle, ctx: ValidationContext): ValidationResult {
  return result([checkPermit(permit, ctx)]);
}
