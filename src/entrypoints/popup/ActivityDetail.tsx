import type { ComponentChildren } from 'preact';
import { formatEther, formatUnits } from 'viem';
import { getChain } from '../../shared/chains';
import {
  formatCompact,
  formatDuration,
  formatPercent,
  formatToken,
  formatUsd,
} from '../../shared/format';
import type { TicketLeg } from '../../shared/panel';
import { shortAddress as short } from '../../shared/wallet';
import { useCopy } from '../../ui/components';
import {
  TicketIcon,
  chainShort,
  nativeSym,
  statusOf,
  swapLegs,
  title,
  totals,
  useHistory,
} from './Activity';
import { IconCopy, IconExternal } from './icons';
import { chartUrl, txUrl } from './links';

const LEG_STATUS: Record<TicketLeg['status'], string> = {
  queued: 'Queued',
  sending: 'Signing',
  submitted: 'Sent',
  confirmed: 'Confirmed',
  failed: 'Failed',
  skipped: 'Skipped',
  blocked: 'Blocked',
};

function when(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function Row({ k, children }: { k: string; children: ComponentChildren }) {
  return (
    <div class="kv">
      <span class="muted">{k}</span>
      <span class="kv-v">{children}</span>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <section class="td-sec">
      <h3 class="td-label">{label}</h3>
      <div class="card td-card">{children}</div>
    </section>
  );
}

export function ActivityDetail({ id }: { id: string }) {
  const items = useHistory();
  const [copied, copy] = useCopy();
  if (items === null) return <p class="muted">Loading…</p>;
  const t = items.find((x) => x.id === id);
  if (!t) return <p class="muted">This entry is no longer in your history.</p>;

  const st = statusOf(t);
  const sym = nativeSym(t.chainId);
  const usd = (wei: bigint) =>
    t.nativeUsd !== undefined ? (
      <span class="usd">{formatUsd(Number(formatEther(wei)) * t.nativeUsd)}</span>
    ) : null;
  const native = (wei: bigint) => (
    <>
      {formatCompact(Number(formatEther(wei)))} {sym}
      {usd(wei)}
    </>
  );
  const tokens = (raw: bigint) =>
    t.decimals !== undefined ? `${formatToken(raw, t.decimals)} ${t.symbol ?? ''}` : null;

  const swaps = swapLegs(t);
  const { paid, out } = totals(t);
  const isTrade = t.kind === 'buy' || t.kind === 'sell';
  const nativeSide = t.kind === 'buy' ? paid : out;
  const tokenSide = t.kind === 'buy' ? out : paid;
  // USD per token, from the native side and the token side of the same trade.
  const price =
    isTrade && nativeSide !== null && tokenSide && t.decimals !== undefined && t.nativeUsd
      ? (Number(formatEther(nativeSide)) * t.nativeUsd) / Number(formatUnits(tokenSide, t.decimals))
      : null;

  const sentMs = swaps.find((l) => l.sentMs !== undefined)?.sentMs;
  const phases = swaps.find((l) => l.phases)?.phases;
  const confirmMs = swaps.find((l) => l.confirmMs !== undefined)?.confirmMs;
  const fees = t.legs.filter((l) => l.feeWei !== undefined);
  const feeTotal = fees.reduce((s, l) => s + BigInt(l.feeWei ?? '0'), 0n);
  const s = t.settings;

  return (
    <div class="stack" style={{ gap: '4px' }}>
      <div class="td-head">
        <TicketIcon t={t} />
        <div class="td-title">
          <strong>{title(t)}</strong>
          {t.kind !== 'bridge' && <span class="cb">{chainShort(t.chainId)}</span>}
          <div class="faint">{when(t.createdAt)}</div>
        </div>
        <span class={`td-status ${st.cls}`}>{st.text}</span>
      </div>

      {isTrade && (
        <Section label="Summary">
          {t.kind === 'buy' ? (
            <>
              <Row k="Paid">{native(paid)}</Row>
              {out !== null && tokens(out) && (
                <Row k="Received">
                  <span class="ok">{tokens(out)}</span>
                </Row>
              )}
            </>
          ) : (
            <>
              <Row k="Sold">{tokens(paid) ?? '—'}</Row>
              {out !== null && (
                <Row k="Received">
                  <span class="ok">{native(out)}</span>
                </Row>
              )}
            </>
          )}
          {price !== null && Number.isFinite(price) && <Row k="Price">{formatUsd(price)}</Row>}
        </Section>
      )}

      {t.kind === 'bridge' && t.bridge && (
        <Section label="Summary">
          <Row k="Sent">{native(BigInt(t.bridge.amountIn))}</Row>
          <Row k="Received">
            {formatCompact(Number(formatEther(BigInt(t.bridge.amountOut))))}{' '}
            {nativeSym(t.bridge.toChainId)} on {getChain(t.bridge.toChainId)?.name}
          </Row>
          <Row k="To">{t.bridge.recipientName}</Row>
        </Section>
      )}

      {t.kind === 'send' && t.recipient && (
        <Section label="Summary">
          <Row k="Sent">{t.token ? (tokens(paid) ?? '—') : native(paid)}</Row>
          <Row k="To">
            <span class="td-hash">
              {short(t.recipient)}
              <button
                type="button"
                class="icon-btn sm"
                aria-label="Copy recipient address"
                title={copied === t.recipient ? 'Copied' : 'Copy'}
                onClick={() => void copy(t.recipient as string)}
              >
                <IconCopy size={12} />
              </button>
            </span>
          </Row>
        </Section>
      )}

      {(t.kind === 'distribute' || t.kind === 'collect') && (
        <Section label="Summary">
          <Row k={t.kind === 'distribute' ? 'Sent' : 'Collected'}>{native(paid)}</Row>
          <Row k="Wallets">{swaps.length}</Row>
        </Section>
      )}

      {(sentMs !== undefined || confirmMs !== undefined) && (
        <Section label="Speed">
          {sentMs !== undefined && (
            <Row k="Click to sent">
              <span class="r-ms">{formatDuration(sentMs)}</span>
            </Row>
          )}
          {phases && (
            <>
              <Row k="· Route and prepare">{formatDuration(phases.prepMs)}</Row>
              <Row k="· Balance check and simulation">{formatDuration(phases.checkMs)}</Row>
              <Row k="· Nonce and signing">{formatDuration(phases.signMs)}</Row>
              <Row k="· Network accepted">{formatDuration(phases.sendMs)}</Row>
            </>
          )}
          {confirmMs !== undefined && <Row k="Sent to confirmed">{formatDuration(confirmMs)}</Row>}
        </Section>
      )}

      {(t.route || s) && (
        <Section label="Route and settings">
          {t.route && <Row k="Pool">{t.route}</Row>}
          {s && <Row k="Slippage">{formatPercent(s.slippageBps)}</Row>}
          {s?.priority && (
            <Row k="Priority">
              {s.priority.level[0]?.toUpperCase()}
              {s.priority.level.slice(1)} · {s.priority.gwei} gwei
            </Row>
          )}
          {s?.mev !== undefined && <Row k="MEV protection">{s.mev ? 'On' : 'Off'}</Row>}
        </Section>
      )}

      {fees.length > 0 && (
        <Section label="Costs">
          <Row k="Network fee">{native(feeTotal)}</Row>
          <Row k="Platform fee">
            <span class="ok">0%</span>
          </Row>
        </Section>
      )}

      <Section label={t.legs.length > 1 ? 'Transactions' : 'Transaction'}>
        {t.legs.map((l, i) => (
          <div key={i} class="td-leg">
            <div class="kv">
              <span>{l.note ?? (l.kind === 'approve' ? 'Approve for selling' : l.walletName)}</span>
              <span class={l.status === 'confirmed' ? 'ok' : l.error ? 'bad' : 'muted'}>
                {LEG_STATUS[l.status]}
              </span>
            </div>
            {(l.hash || l.sentMs !== undefined) && (
              <div class="kv faint">
                <span class="td-hash">
                  {l.hash && (
                    <>
                      {short(l.hash)}
                      <button
                        type="button"
                        class="icon-btn sm"
                        aria-label="Copy transaction hash"
                        title={copied === l.hash ? 'Copied' : 'Copy'}
                        onClick={() => void copy(l.hash as string)}
                      >
                        <IconCopy size={12} />
                      </button>
                      <a
                        class="icon-btn sm"
                        href={txUrl(t.chainId, l.hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="View on explorer"
                      >
                        <IconExternal size={12} />
                      </a>
                    </>
                  )}
                </span>
                {l.sentMs !== undefined && <span class="r-ms">{formatDuration(l.sentMs)}</span>}
              </div>
            )}
            {l.error && <div class="leg-err">{l.error}</div>}
          </div>
        ))}
        {t.bridge?.outHash && (
          <div class="td-leg">
            <div class="kv">
              <span>Received on {getChain(t.bridge.toChainId)?.name}</span>
              <a
                class="icon-btn sm"
                href={txUrl(t.bridge.toChainId, t.bridge.outHash)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on explorer"
              >
                <IconExternal size={12} />
              </a>
            </div>
          </div>
        )}
      </Section>

      {t.token && isTrade && (
        <div class="td-actions">
          <a
            class="btn"
            href={chartUrl(t.chainId, t.token)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open chart
          </a>
          <button type="button" class="btn" onClick={() => void copy(t.token as string)}>
            {copied === t.token ? 'Copied' : 'Copy token address'}
          </button>
        </div>
      )}
    </div>
  );
}
