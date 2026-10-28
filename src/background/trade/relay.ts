import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import type { BlockedAction } from '../../shared/panel';
import { sanitizeLabel } from '../../shared/sanitize';
import {
  isOwn,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from './validator';

/**
 * Bridging via Relay (relay.link). Relay quotes a single deposit into its depository on
 * the origin chain; a solver then pays the recipient on the destination chain.
 *
 * The depository is the same CREATE2 address on every supported chain (identical
 * bytecode checked on all five) and its source is verified on Basescan. The only call
 * Celera makes to it is depositNative(depositor, id).
 */
const RELAY_API = 'https://api.relay.link';
export const RELAY_DEPOSITORY: Address = getAddress('0x4cd00e387622c35bddb9b4c962c136462338bc31');
const NATIVE = '0x0000000000000000000000000000000000000000';

const depositoryAbi = parseAbi(['function depositNative(address depositor, bytes32 id) payable']);

const QuoteSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      items: z.array(
        z.object({
          data: z.object({
            to: z.string(),
            data: z.string(),
            value: z.string(),
            chainId: z.number(),
          }),
          check: z.object({ endpoint: z.string() }).optional(),
        }),
      ),
    }),
  ),
  fees: z
    .record(z.string(), z.object({ amountUsd: z.string().optional() }).nullable().optional())
    .optional(),
  details: z.object({
    recipient: z.string(),
    timeEstimate: z.number().optional(),
    currencyOut: z.object({ amount: z.string() }),
  }),
});

export interface BridgeQuote {
  amountIn: bigint;
  amountOut: bigint;
  feeUsd: number | null;
  timeEstimateS: number | null;
  tx: { to: Address; data: Hex; value: bigint };
  requestId: Hex;
  /** Relay status path for this request, e.g. /intents/status?requestId=0x… */
  statusPath: string;
}

export class RelayError extends Error {}

export interface RelayClient {
  quote(p: {
    user: Address;
    recipient: Address;
    fromChainId: number;
    toChainId: number;
    amount: bigint;
  }): Promise<BridgeQuote>;
  status(statusPath: string): Promise<{ status: string; outHash?: Hex }>;
}

export function createRelayClient(fetchFn: typeof fetch = fetch): RelayClient {
  const call = async (path: string, init?: RequestInit) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetchFn(`${RELAY_API}${path}`, {
        ...init,
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      // Relay's own wording is outside text: cleaned, shortened and labelled as Relay's.
      const said = typeof json?.message === 'string' ? sanitizeLabel(json.message, 120) : '';
      if (!res.ok) throw new RelayError(said ? `Relay: ${said}` : `Relay error ${res.status}`);
      return json;
    } finally {
      clearTimeout(t);
    }
  };

  return {
    async quote(p) {
      const raw = await call('/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user: p.user,
          recipient: p.recipient,
          originChainId: p.fromChainId,
          destinationChainId: p.toChainId,
          originCurrency: NATIVE,
          destinationCurrency: NATIVE,
          amount: p.amount.toString(),
          tradeType: 'EXACT_INPUT',
        }),
      });
      const q = QuoteSchema.safeParse(raw);
      if (!q.success) throw new RelayError('Unexpected quote format');
      return checkQuote(q.data, p);
    },
    async status(statusPath) {
      if (!/^\/intents\/status(\/v\d)?\?requestId=0x[0-9a-fA-F]{64}$/.test(statusPath)) {
        throw new RelayError('Unexpected status path');
      }
      const raw = (await call(statusPath)) as { status?: string; txHashes?: string[] } | null;
      const out = raw?.txHashes?.find((h) => /^0x[0-9a-fA-F]{64}$/.test(h)) as Hex | undefined;
      return { status: String(raw?.status ?? 'unknown'), ...(out ? { outHash: out } : {}) };
    },
  };
}

/**
 * Accepts only the shape Celera expects: one deposit transaction on the origin chain,
 * into the depository, for exactly the requested amount, crediting our own wallet,
 * with the destination recipient we asked for.
 */
export function checkQuote(
  q: z.infer<typeof QuoteSchema>,
  p: { user: Address; recipient: Address; fromChainId: number; amount: bigint },
): BridgeQuote {
  const items = q.steps.flatMap((s) => s.items.map((i) => ({ step: s, item: i })));
  if (q.steps.length !== 1 || items.length !== 1)
    throw new RelayError('Quote has unexpected steps');
  const { step, item } = items[0] as (typeof items)[number];
  if (step.kind !== 'transaction') throw new RelayError('Quote step is not a transaction');
  const d = item.data;
  if (d.chainId !== p.fromChainId) throw new RelayError('Quote is for a different chain');
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.to) || !isAddressEqual(d.to as Address, RELAY_DEPOSITORY)) {
    throw new RelayError('Quote targets an unknown contract');
  }
  if (BigInt(d.value) !== p.amount) throw new RelayError('Quote value differs from the amount');
  let call;
  try {
    call = decodeFunctionData({ abi: depositoryAbi, data: d.data as Hex });
  } catch {
    throw new RelayError('Quote calldata is not a native deposit');
  }
  const [depositor, id] = call.args;
  if (!isAddressEqual(depositor, p.user))
    throw new RelayError('Deposit is not credited to your wallet');
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(q.details.recipient) ||
    !isAddressEqual(q.details.recipient as Address, p.recipient)
  ) {
    throw new RelayError('Quote recipient differs from your wallet');
  }
  const statusPath = item.check?.endpoint ?? `/intents/status?requestId=${id}`;
  // Relay lists sub-fees (relayerGas, relayerService) next to their totals; add the
  // two top-level ones: origin gas + relayer.
  const feeUsd =
    q.fees && (q.fees.gas || q.fees.relayer)
      ? Number(q.fees.gas?.amountUsd ?? 0) + Number(q.fees.relayer?.amountUsd ?? 0)
      : null;
  return {
    amountIn: p.amount,
    amountOut: BigInt(q.details.currencyOut.amount),
    feeUsd: feeUsd !== null && Number.isFinite(feeUsd) ? feeUsd : null,
    timeEstimateS: q.details.timeEstimate ?? null,
    tx: { to: RELAY_DEPOSITORY, data: d.data as Hex, value: BigInt(d.value) },
    requestId: id,
    statusPath,
  };
}

/** Validator rule for the depository: only depositNative crediting one of your wallets. */
export const relayRule: ExtraContractRule = {
  label: 'Relay',
  validate(tx: TxToValidate, ctx: ValidationContext): BlockedAction[] {
    let call;
    try {
      call = decodeFunctionData({ abi: depositoryAbi, data: tx.data });
    } catch {
      return [{ label: 'Relay call', ok: false, reason: 'Only native deposits are allowed' }];
    }
    const [depositor] = call.args;
    const label = `Relay deposit for ${depositor.slice(0, 6)}…`;
    if (!isOwn(ctx, depositor) || !isAddressEqual(depositor, ctx.from)) {
      return [{ label, ok: false, reason: 'Deposit is not credited to the sending wallet' }];
    }
    if (tx.value === 0n) return [{ label, ok: false, reason: 'Empty deposit' }];
    return [{ label, ok: true }];
  },
};
