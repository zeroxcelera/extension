import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  maxUint256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import type { BlockedAction } from '../../shared/panel';
import type { PoolRef, TxDraft, Venue, VenueCtx } from './types';
import { erc20WriteAbi } from '../chain/abis';
import { shortAddress as short } from '../../shared/wallet';
import { act } from './actions';
import { PERMIT2 } from './uniswap/addresses';
import {
  validateUniversalRouter,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from './validator';

/**
 * The Celera Router (contracts/src/CeleraRouter.sol) runs a funded curve trade — native ↔
 * quote asset on an AMM, plus the curve trade — as ONE transaction. Its steps are plain
 * venue calls made by the router, built here with the venues' own builders. Where a step
 * must spend what an earlier one produced, the router writes its balance of that asset
 * into the step's calldata just before the call (balance injection). A venue that pulls
 * the asset (curves, allowance-based routers) is named as the step's `spender`: the router
 * approves it for exactly that amount for that call only, and resets it to zero after, so
 * no allowance outlives a step (steps themselves may not call `approve`).
 *
 * Users never approve the router: a sell hands it exactly the amount sold through a
 * one-time Permit2 SignatureTransfer. The validator below decodes every step.
 */

/** The router's name for native ether in `tokenOut`, `sweep` and injections. */
export const ROUTER_NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
/** A step `value` meaning "all the ether the router holds". */
export const ALL_VALUE = maxUint256;

export const celeraRouterAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; address injectToken; uint256 injectOffset; address spender; }',
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'struct Input { PermitTransferFrom permit; bytes signature; }',
  'function execute(Call[] calls, Input input, address tokenOut, uint256 minOut, address[] sweep, uint256 deadline) payable returns (uint256 out)',
]);

export interface RouterCall {
  target: Address;
  value: bigint;
  data: Hex;
  /** Zero address: no injection. */
  injectToken: Address;
  injectOffset: bigint;
  /** May pull the injected amount during this call only (zero address: nobody). */
  spender: Address;
}

export interface TransferPermit {
  permitted: { token: Address; amount: bigint };
  nonce: bigint;
  deadline: bigint;
}

// ── step builders ────────────────────────────────────────────────────────────

/** Amount the builders are called with; where it lands in the calldata is the injection offset. */
const SENTINEL = 0xce1e7ace1e7ace1e7ace1e7ace1e7ace1e7ace1e7ace1e7ace1e7ace1e7ace1en;
const SENTINEL_WORD = SENTINEL.toString(16).padStart(64, '0');

function plain(tx: TxDraft): RouterCall {
  return {
    target: tx.to,
    value: tx.value,
    data: tx.data,
    injectToken: zeroAddress,
    injectOffset: 0n,
    spender: zeroAddress,
  };
}

/**
 * A call that spends the router's whole balance of `token`, built by `build(amount)`.
 * `spender`, when set, may pull that amount during the call (the router approves it).
 */
export function injected(
  token: Address,
  build: (amount: bigint) => TxDraft,
  spender: Address = zeroAddress,
): RouterCall {
  const tx = build(SENTINEL);
  const hex = tx.data.slice(2).toLowerCase();
  const at = hex.indexOf(SENTINEL_WORD);
  if (at < 0 || at % 2 !== 0 || hex.indexOf(SENTINEL_WORD, at + 1) >= 0 || tx.value === SENTINEL)
    throw new Error('Cannot place the amount in this call');
  return {
    target: tx.to,
    value: tx.value,
    data: `0x${hex.slice(0, at)}${'0'.repeat(64)}${hex.slice(at + 64)}`,
    injectToken: token,
    injectOffset: BigInt(at / 2),
    spender,
  };
}

/** Sends the router's whole balance of `token` to `to` (the contract the next step calls). */
function handOver(token: Address, to: Address): RouterCall {
  return injected(token, (amount) => ({
    to: token,
    data: encodeFunctionData({ abi: erc20WriteAbi, functionName: 'transfer', args: [to, amount] }),
    value: 0n,
  }));
}

export interface FundedRoute {
  ctx: VenueCtx;
  router: Address;
  wallet: Address;
  /** The curve and its pool. */
  venue: Venue;
  pool: PoolRef;
  /** The AMM pool converting native ↔ `asset`. */
  legVenue: Venue;
  leg: PoolRef;
  asset: Address;
  deadline: bigint;
}

/** Whether the router can sell into this leg (allowance-based, or swaps its own balance). */
export function legSupported(ctx: VenueCtx, legVenue: Venue, leg: PoolRef): boolean {
  if (!legVenue.sellApproval(ctx, leg).viaPermit2) return true;
  const probe = { wallet: zeroAddress, minOut: 1n, deadline: 0n };
  return !!legVenue.buildSellPrefunded?.(ctx, leg, probe);
}

/** native → asset (into the router) → curve buy with all of it (the curve may pull it). */
export function routerBuyCalls(
  r: FundedRoute & { amountIn: bigint; assetMin: bigint; minOut: bigint },
): RouterCall[] {
  const fund = r.legVenue.buildBuy(r.ctx, r.leg, {
    wallet: r.router,
    amountIn: r.amountIn,
    minOut: r.assetMin,
    deadline: r.deadline,
  });
  return [
    plain(fund),
    injected(
      r.asset,
      (amountIn) =>
        r.venue.buildBuy(r.ctx, r.pool, {
          wallet: r.wallet,
          amountIn,
          minOut: r.minOut,
          deadline: r.deadline,
        }),
      r.venue.sellApproval(r.ctx, r.pool).spender,
    ),
  ];
}

/**
 * (tokens pulled by Permit2) → curve sell into the router → asset → native to the wallet.
 * Null when the leg cannot be sold into from the router.
 */
export function routerSellCalls(
  r: FundedRoute & { assetMin: bigint; minOut: bigint },
): RouterCall[] | null {
  const token = r.pool.token;
  const calls: RouterCall[] = [
    injected(
      token,
      (amountIn) =>
        r.venue.buildSell(r.ctx, r.pool, {
          wallet: r.router,
          amountIn,
          minOut: r.assetMin,
          deadline: r.deadline,
        }),
      r.venue.sellApproval(r.ctx, r.pool).spender,
    ),
  ];
  const legApproval = r.legVenue.sellApproval(r.ctx, r.leg);
  if (!legApproval.viaPermit2) {
    calls.push(
      injected(
        r.asset,
        (amountIn) =>
          r.legVenue.buildSell(r.ctx, r.leg, {
            wallet: r.wallet,
            amountIn,
            minOut: r.minOut,
            deadline: r.deadline,
          }),
        legApproval.spender,
      ),
    );
    return calls;
  }
  const swap = r.legVenue.buildSellPrefunded?.(r.ctx, r.leg, {
    wallet: r.wallet,
    minOut: r.minOut,
    deadline: r.deadline,
  });
  if (!swap) return null;
  calls.push(handOver(r.asset, swap.to), plain(swap));
  return calls;
}

export function encodeRouterExecute(p: {
  calls: RouterCall[];
  permit?: { permit: TransferPermit; signature: Hex } | undefined;
  tokenOut: Address;
  minOut: bigint;
  sweep: Address[];
  deadline: bigint;
}): Hex {
  const input = p.permit ?? {
    permit: { permitted: { token: zeroAddress, amount: 0n }, nonce: 0n, deadline: 0n },
    signature: '0x' as Hex,
  };
  return encodeFunctionData({
    abi: celeraRouterAbi,
    functionName: 'execute',
    args: [p.calls, input, p.tokenOut, p.minOut, p.sweep, p.deadline],
  });
}

// ── Permit2 SignatureTransfer (sells) ────────────────────────────────────────

export const TRANSFER_PERMIT_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

/** One sell, signed just before it is sent. */
const TRANSFER_PERMIT_TTL_S = 10 * 60;
const MAX_WINDOW_S = 30 * 60;

/** Permit2 nonces are unordered (a bitmap); a random one never collides in practice. */
export function buildTransferPermit(
  token: Address,
  amount: bigint,
  nowS: number,
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): TransferPermit {
  const bytes = [...random(31)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    permitted: { token, amount },
    nonce: BigInt(`0x${bytes}`),
    deadline: BigInt(nowS + TRANSFER_PERMIT_TTL_S),
  };
}

const same = (a: Address, b: Address) => isAddressEqual(a, b);

/** Checks a SignatureTransfer before it is signed: this token, at most this amount, this router. */
export function checkTransferPermit(
  permit: TransferPermit,
  spender: Address,
  ctx: ValidationContext,
): BlockedAction {
  const { token, amount } = permit.permitted;
  const label = `Permit2: Celera Router pulls ${amount} of ${short(token)} once`;
  if (!ctx.token || !same(token, ctx.token)) return act(label, 'Permit is for a different token');
  if (!ctx.chain.celeraRouter || !same(spender, ctx.chain.celeraRouter))
    return act(label, 'Spender is not the Celera Router');
  if (ctx.maxPermit === undefined || amount > ctx.maxPermit)
    return act(label, 'Permit amount is above the amount being sold');
  if (permit.deadline < BigInt(ctx.nowS) || permit.deadline > BigInt(ctx.nowS + MAX_WINDOW_S))
    return act(label, 'Permit deadline outside the allowed window');
  return act(label);
}

// ── validator rule ───────────────────────────────────────────────────────────

const allOk = (xs: BlockedAction[]) => xs.length > 0 && xs.every((x) => x.ok);

/** The call with a non-zero amount in its injection slot, so venue rules see a real trade. */
function withPlaceholder(data: Hex, offset: number): Hex {
  const i = 2 + offset * 2;
  return `${data.slice(0, i)}${'1'.padStart(64, '0')}${data.slice(i + 64)}` as Hex;
}

function checkStep(
  c: RouterCall,
  tx: TxToValidate,
  next: RouterCall | undefined,
  ctx: ValidationContext,
  isAsset: (a: Address) => boolean,
): BlockedAction[] {
  const token = ctx.token as Address;
  const asset = ctx.fundingAsset as Address;
  if (isAsset(c.target)) {
    // An asset the route holds: only handed, all of it, to the contract the next step
    // calls. Approvals are the router's own (see `spender`); it refuses `approve` steps.
    if (tx.value !== 0n)
      return [act(`Token call ${short(c.target)}`, 'Must not carry native value')];
    let call;
    try {
      call = decodeFunctionData({ abi: erc20WriteAbi, data: c.data });
    } catch {
      return [act(`Token call ${short(c.target)}`, 'Unknown function')];
    }
    const [to] = call.args;
    if (call.functionName === 'approve')
      return [act(`Approve ${short(to)}`, 'Approvals are made by the router itself')];
    const label = `Hand over ${short(c.target)} → ${short(to)}`;
    if (!same(c.injectToken, c.target) || c.injectOffset !== 36n)
      return [act(label, "Amount is not the router's balance")];
    return ctx.router && same(to, ctx.router) && next && same(next.target, to)
      ? [act(label)]
      : [act(label, 'Recipient is not the next step')];
  }
  if (ctx.router && same(c.target, ctx.router))
    return validateUniversalRouter(tx, { ...ctx, token: asset });
  const rule = ctx.extraContracts?.get(c.target.toLowerCase());
  if (!rule) return [act(`Call to ${short(c.target)}`, 'Contract is not on the allowlist')];
  // A step trades either the selected token (the curve) or the quote asset (the leg).
  const asToken = rule.validate(tx, { ...ctx, token });
  if (allOk(asToken)) return asToken;
  const asAsset = rule.validate(tx, { ...ctx, token: asset });
  return allOk(asAsset) ? asAsset : asToken;
}

/**
 * Validates `execute` for the funded curve trade in `ctx` (`token` + `fundingAsset`): what
 * comes in (ether for buys, the Permit2 pull for sells), every step, what goes out, and
 * that every asset the route touches is returned to the wallet.
 */
export function celeraRouterRule(router: Address): ExtraContractRule {
  return {
    label: 'Celera Router',
    validate(tx, ctx) {
      let call;
      try {
        call = decodeFunctionData({ abi: celeraRouterAbi, data: tx.data });
      } catch {
        return [act('Celera Router call', 'Unknown function')];
      }
      const [calls, input, tokenOut, minOut, sweep, deadline] = call.args;
      const token = ctx.token;
      const asset = ctx.fundingAsset;
      if (!token || !asset) return [act('Celera Router', 'Not a funded curve trade')];
      const out: BlockedAction[] = [];
      const nowS = BigInt(ctx.nowS);
      if (deadline < nowS || deadline > nowS + BigInt(MAX_WINDOW_S))
        out.push(act('Deadline', 'Deadline outside the allowed window'));
      if (minOut === 0n)
        out.push(act('Minimum output', 'No minimum output (no slippage protection)'));

      const pull = input.permit.permitted;
      if (pull.amount > 0n) {
        out.push(checkTransferPermit(input.permit, router, ctx));
        if (!same(tokenOut, ROUTER_NATIVE)) out.push(act('Output', 'A sell must pay out native'));
        if (tx.value !== 0n) out.push(act('Value', 'A sell must not carry native value'));
      } else {
        if (!same(tokenOut, token))
          out.push(act('Output', 'A buy must pay out the selected token'));
        if (tx.value === 0n) out.push(act('Value', 'A buy without native input'));
      }

      const assets = [token, asset, ctx.chain.wrappedNative];
      const isAsset = (a: Address) => assets.some((x) => same(x, a));
      for (const a of assets) {
        if (!same(a, tokenOut) && !sweep.some((s) => same(s, a)))
          out.push(act(`Return ${short(a)}`, 'Left in the router instead of returned to you'));
      }
      for (const s of sweep)
        if (!isAsset(s)) out.push(act(`Return ${short(s)}`, 'Unexpected asset'));
      if (calls.length === 0) out.push(act('Steps', 'No steps'));

      const stepCtx: ValidationContext = {
        ...ctx,
        from: router,
        // What a step pays the router is returned to the wallet at the end (checked above).
        ownWallets: [...ctx.ownWallets, router],
        payee: undefined,
        maxValue: tx.value,
      };
      let fixedValue = 0n;
      calls.forEach((c, i) => {
        const prefix = (a: BlockedAction) => ({ ...a, label: `Step ${i + 1}: ${a.label}` });
        if (c.value !== ALL_VALUE) fixedValue += c.value;
        if (same(c.target, router) || same(c.target, PERMIT2)) {
          out.push(
            prefix(
              act(`Call to ${short(c.target)}`, 'Permit2 and the router itself are off limits'),
            ),
          );
          return;
        }
        let data = c.data;
        if (!same(c.injectToken, zeroAddress)) {
          const len = BigInt((data.length - 2) / 2);
          if (!isAsset(c.injectToken) && !same(c.injectToken, ROUTER_NATIVE)) {
            out.push(prefix(act(`Amount of ${short(c.injectToken)}`, 'Unexpected asset')));
            return;
          }
          if (c.injectOffset < 4n || c.injectOffset + 32n > len) {
            out.push(prefix(act('Amount slot', 'Outside the call data')));
            return;
          }
          data = withPlaceholder(data, Number(c.injectOffset));
        }
        if (!same(c.spender, zeroAddress)) {
          // The router lets `spender` pull the injected ERC-20 for this call only.
          const l = `Let ${short(c.spender)} take ${short(c.injectToken)} for this step`;
          if (same(c.injectToken, zeroAddress) || same(c.injectToken, ROUTER_NATIVE)) {
            out.push(prefix(act(l, 'Approval without an injected token amount')));
            return;
          }
          if (!ctx.extraContracts?.get(c.spender.toLowerCase())?.approvalSpender) {
            out.push(prefix(act(l, 'Spender is not an allowlisted venue')));
            return;
          }
          out.push(prefix(act(l)));
        }
        const value = c.value === ALL_VALUE ? tx.value : c.value;
        const step: TxToValidate = { to: c.target, data, value };
        out.push(...checkStep(c, step, calls[i + 1], stepCtx, isAsset).map(prefix));
      });
      if (fixedValue > tx.value)
        out.push(act('Value', 'Steps spend more than the transaction value'));
      return out;
    },
  };
}
