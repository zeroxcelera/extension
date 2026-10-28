import { useEffect, useState } from 'preact/hooks';
import { formatEther } from 'viem';
import { formatCompact, formatDuration, formatToken } from '../../shared/format';
import { readyMs, type TicketLeg, type TradeTicket } from '../../shared/panel';
import { trusted } from './hooks';

export interface ToastItem {
  id: string;
  ticket?: TradeTicket;
  error?: string;
  /** Heading of an error toast (what did not happen). */
  title?: string;
  retry?: boolean;
}

const STATUS: Record<TicketLeg['status'], string> = {
  queued: 'queued',
  sending: 'signing…',
  submitted: 'sent',
  confirmed: 'confirmed',
  failed: 'failed',
  skipped: 'skipped',
  blocked: 'blocked',
};

/** How long a finished toast stays up (paused while hovered). Working tickets stay. */
const LIFETIME_MS = { ok: 6_000, problem: 10_000 } as const;

function title(t: TradeTicket, fallbackSymbol: string): string {
  const sym = t.symbol ?? fallbackSymbol;
  const what =
    t.kind === 'buy'
      ? `Buy ${sym}`
      : t.kind === 'sell'
        ? `Sell ${sym}`
        : t.kind === 'distribute'
          ? 'Distribute'
          : t.kind === 'bridge'
            ? 'Bridge'
            : t.kind === 'send'
              ? 'Send'
              : 'Collect';
  switch (t.status) {
    case 'working':
      return `${what}: sending`;
    case 'done':
      return `${what}: done`;
    case 'partial':
      return `${what}: partly done`;
    case 'blocked':
      return `${what}: blocked`;
    case 'failed':
      return `${what}: failed`;
  }
}

function tone(t: TradeTicket): string {
  return t.status === 'done'
    ? 'ok'
    : t.status === 'partial'
      ? 'warn'
      : t.status === 'working'
        ? 'live'
        : 'bad';
}

/** Ms until auto-close, or null to stay until dismissed. */
function lifetime(item: ToastItem): number | null {
  if (item.error) return LIFETIME_MS.problem;
  const t = item.ticket;
  if (!t || t.status === 'working') return null;
  // A transaction still in flight can be sped up or cancelled: keep it visible.
  if (t.legs.some((l) => l.status === 'submitted' || l.status === 'sending')) return null;
  return t.status === 'done' ? LIFETIME_MS.ok : LIFETIME_MS.problem;
}

/**
 * Every wallet failed for the same reason (e.g. all skipped for insufficient balance):
 * one line instead of the same error under each wallet.
 */
/**
 * How long a leg took: Celera's own part (click → signed) and the network accepting it,
 * apart. Older records without the split show the total.
 */
function LegSpeed({ leg }: { leg: TicketLeg }) {
  const ready = readyMs(leg);
  if (ready === undefined) {
    if (leg.sentMs === undefined) return null;
    return (
      <span class="t-ms" title="From the click until the network accepted it">
        {' '}
        in {formatDuration(leg.sentMs)}
      </span>
    );
  }
  return (
    <>
      <span class="t-ms" title="From the click until signed and ready to send">
        {' '}
        in {formatDuration(ready)}
      </span>
      <span class="t-net" title="The network accepting it">
        {' '}
        + {formatDuration(leg.phases?.sendMs ?? 0)} network
      </span>
    </>
  );
}

function sharedError(legs: TicketLeg[]): string | null {
  if (legs.length < 2) return null;
  const first = legs[0]?.error;
  if (!first) return null;
  return legs.every((l) => l.error === first && (l.status === 'skipped' || l.status === 'failed'))
    ? first
    : null;
}

export function Toasts(props: {
  items: ToastItem[];
  decimals: number;
  native: string;
  /** The panel token symbol, used until the ticket carries its own. */
  symbol: string;
  /** Where the stack sits (kept clear of the panel). */
  placement?: Record<string, string>;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
  onReplace: (ticketId: string, walletId: string, mode: 'speedUp' | 'cancel') => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <div class="toasts" role="status" aria-live="polite" style={props.placement}>
      {props.items.map((item) => (
        <Toast key={item.id} item={item} {...props} />
      ))}
    </div>
  );
}

function Toast({
  item,
  decimals,
  native,
  symbol,
  onDismiss,
  onRetry,
  onReplace,
}: Parameters<typeof Toasts>[0] & { item: ToastItem }) {
  const ms = lifetime(item);
  const [hover, setHover] = useState(false);

  // Auto-close once finished; hovering pauses (and restarts) the countdown.
  useEffect(() => {
    if (ms === null || hover) return;
    const id = setTimeout(() => onDismiss(item.id), ms);
    return () => clearTimeout(id);
  }, [ms, hover, item.id]);

  const dismiss = (
    <button
      type="button"
      class="ib"
      aria-label="Dismiss"
      onClick={trusted(() => onDismiss(item.id))}
    >
      ×
    </button>
  );
  const timer = ms !== null && !hover && (
    // Restarted by key whenever the countdown restarts.
    <span key={`${ms}-${String(hover)}`} class="ttl" style={{ animationDuration: `${ms}ms` }} />
  );
  const hoverProps = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };

  if (item.error) {
    return (
      <div class="toast bad" {...hoverProps}>
        <div class="t-head">
          <strong>{item.title ?? 'Trade not sent'}</strong>
          {dismiss}
        </div>
        <span class="t-msg">{item.error}</span>
        {item.retry && (
          <div class="row">
            <button type="button" class="btn" onClick={trusted(() => onRetry(item.id))}>
              Try again
            </button>
          </div>
        )}
        {timer}
      </div>
    );
  }

  const t = item.ticket as TradeTicket;
  const swapLegs = t.legs.filter((l) => l.kind !== 'approve' && l.kind !== 'step');
  const shared = sharedError(swapLegs);
  const amountOf = (l: TicketLeg) =>
    !l.amountIn || l.kind === 'approve'
      ? ''
      : t.kind === 'sell'
        ? `${formatToken(BigInt(l.amountIn), decimals)} ${t.symbol ?? symbol}`
        : `${formatCompact(Number(formatEther(BigInt(l.amountIn))))} ${native}`;

  return (
    <div class={`toast ${tone(t)}`} {...hoverProps}>
      <div class="t-head">
        <strong>{title(t, symbol)}</strong>
        {swapLegs.length > 1 && (
          <span class="t-count">
            {swapLegs.filter((l) => l.status === 'confirmed').length}/{swapLegs.length}
          </span>
        )}
        {dismiss}
      </div>
      {shared ? (
        <div class="t-legs">
          <span class="t-msg">{shared}</span>
          <span class="faint">
            {swapLegs.map((l) => l.walletName).join(', ')} · {amountOf(swapLegs[0] as TicketLeg)}{' '}
            each
          </span>
        </div>
      ) : (
        <div class="t-legs">
          {t.legs.map((l, i) => (
            <div key={i} class={`t-leg s-${l.status}`}>
              <span class="t-dot" />
              <span class="t-who">
                {l.note ?? (l.kind === 'approve' ? 'Approve' : l.walletName)}
              </span>
              <span class="t-amt">{amountOf(l)}</span>
              <span class="t-st">
                {l.hash ? (
                  <a href={`${t.explorer}/tx/${l.hash}`} target="_blank" rel="noopener noreferrer">
                    {STATUS[l.status]}
                  </a>
                ) : (
                  STATUS[l.status]
                )}
                <LegSpeed leg={l} />
              </span>
              {l.error && <span class="t-err">{l.error}</span>}
              {l.status === 'submitted' && l.kind !== 'approve' && (
                <span class="t-acts">
                  <button
                    type="button"
                    class="btn sm"
                    onClick={trusted(() => onReplace(t.id, l.walletId, 'speedUp'))}
                  >
                    Speed up
                  </button>
                  <button
                    type="button"
                    class="btn sm"
                    onClick={trusted(() => onReplace(t.id, l.walletId, 'cancel'))}
                  >
                    Cancel
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {timer}
    </div>
  );
}
