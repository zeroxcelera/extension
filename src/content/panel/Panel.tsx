import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatEther, formatUnits, parseEther } from 'viem';
import { browser } from 'wxt/browser';
import { getChain } from '../../shared/chains';
import type { Detection, ResolvedTarget } from '../../shared/detection';
import {
  formatCompact,
  formatPercent,
  formatToken,
  formatUsd,
  parseDecimalInput,
} from '../../shared/format';
import type { PushEvent } from '../../shared/messages';
import { unrealisedPnl } from '../../shared/pnl';
import type {
  BlockedAction,
  PanelState,
  QuoteSet,
  QuoteView,
  TaxView,
  TradeTicket,
} from '../../shared/panel';
import { shortAddress } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { PANEL_GAP, PANEL_WIDTH, toastPlacement } from './layout';
import { clamp, isEditable, trusted, useDrag, useHotkeys, usePanelPrefs } from './hooks';
import { BirdMark } from '../../ui/BirdMark';
import { Toasts, type ToastItem } from './Toasts';
import {
  PenIcon,
  QuickValuesEditor,
  TradeSettings,
  isSellPercent,
  type TradePatch,
} from './TradeSettings';

const SELL_KEYS = ['q', 'w', 'e', 'r'];
/** RPC keep-alive cadence, and how long it continues once the tab is hidden. */
const WARM_EVERY_MS = 20_000;
const WARM_HIDDEN_MAX_MS = 10 * 60_000;

type Pending =
  { kind: 'buy'; amount: string; usd: string } | { kind: 'sell'; bps: number; usd: string };

/** "· Tax 5% / 5%" in the status bar; red when over Max tax or the sell fails. */
function TaxBadge({ tax, maxBps }: { tax: TaxView; maxBps: number }) {
  const pct = (bps: number) => formatPercent(bps);
  if (tax.sellFails)
    return (
      <span
        class="imp-bad"
        title="A simulated sell of this token reverted. You may not be able to sell."
      >
        · Sell fails
      </span>
    );
  const worst = Math.max(tax.buyBps, tax.sellBps ?? 0);
  const tone = maxBps < 10_000 && worst > maxBps ? 'imp-bad' : worst > 0 ? 'imp-warn' : '';
  return (
    <span
      class={tone}
      title={`Token tax from a simulated buy and sell: ${pct(tax.buyBps)} on buys, ${tax.sellBps === null ? 'unknown' : pct(tax.sellBps)} on sells. Pool fees are not included.`}
    >
      · Tax {pct(tax.buyBps)} / {tax.sellBps === null ? '?' : pct(tax.sellBps)}
    </span>
  );
}

/**
 * Protection as it really is: private only when it is on AND a private RPC is set;
 * otherwise sends go to the public mempool, which the user must see.
 */
function MevStatus({ mev }: { mev: PanelState['chain']['mev'] }) {
  if (!mev.supported) return <span title={mev.reason ?? ''}>MEV: n/a (L2)</span>;
  if (mev.enabled && mev.configured) return <span>MEV: private RPC</span>;
  return (
    <span
      class="imp-warn"
      title="Transactions go to the public mempool and can be sandwiched. Turn on MEV protection (and set a private RPC) in Settings → Chains."
    >
      MEV: unprotected
    </span>
  );
}

export function Panel({ detection }: { detection: Detection | null }) {
  const [target, setTarget] = useState<ResolvedTarget | null | 'loading'>('loading');
  const [state, setState] = useState<PanelState | null>(null);
  const [quotes, setQuotes] = useState<QuoteSet | null>(null);
  const [quoteErr, setQuoteErr] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [picker, setPicker] = useState(false);
  const [custom, setCustom] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [blocked, setBlocked] = useState<BlockedAction[] | null>(null);
  /** Which button is waiting for the background ("buy:0.01", "sell:5000"). */
  const [busy, setBusy] = useState<string | null>(null);
  const [editingAmounts, setEditingAmounts] = useState(false);
  const [editingSells, setEditingSells] = useState(false);
  const [prefs, setPrefs] = usePanelPrefs();
  const drag = useDrag((x, y) => setPrefs({ x, y }));
  // Re-place (and re-clamp) the panel and its toasts when the window is resized.
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const retries = useRef(new Map<string, () => void>());
  const typingInPanel = useRef(false);
  const quoteTick = useRef<(() => void) | null>(null);
  const chainIdRef = useRef<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── resolve the token from the URL ────────────────────────────────────────
  useEffect(() => {
    setQuotes(null);
    setState(null);
    if (!detection) {
      setTarget(null);
      return;
    }
    setTarget('loading');
    let alive = true;
    void send({ type: 'panel.resolve', detection }).then(
      (r) => alive && setTarget(r.ok ? r.data : null),
    );
    return () => {
      alive = false;
    };
  }, [detection?.address, detection?.poolId, detection?.chainId]);

  const t = target && target !== 'loading' ? target : null;
  const chain = t ? getChain(t.chainId) : undefined;
  chainIdRef.current = t?.chainId ?? null;
  const native = chain?.nativeCurrency.symbol ?? 'ETH';

  const loadState = useCallback(async () => {
    if (!t) return;
    const r = await send({ type: 'panel.state', chainId: t.chainId, token: t.token });
    if (r.ok) setState(r.data);
  }, [t?.chainId, t?.token]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  // ── quotes: prefetch on open, refresh while the tab is visible ────────────
  const maxSellBps = Math.max(...(state?.chain.quickSellBps ?? [10_000]));
  const holding = useMemo(
    () =>
      (state?.wallets ?? []).filter((w) => w.selected).reduce((s, w) => s + BigInt(w.token), 0n),
    [state],
  );
  useEffect(() => {
    // Locked: nothing to quote for (no buttons), and the token stays private until unlocked.
    if (!t || !state || state.locked || prefs.hidden) return;
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await send({
        type: 'panel.quotes',
        chainId: t.chainId,
        token: t.token,
        buyAmounts: state.chain.quickBuyAmounts,
        sellBps: !state.locked && holding > 0n ? state.chain.quickSellBps : [],
      });
      if (!alive) return;
      if (r.ok) {
        setQuotes(r.data);
        setQuoteErr(false);
      } else setQuoteErr(true);
    };
    let last = 0;
    quoteTick.current = () => {
      // Block events can arrive several times a second on L2s; refresh at most ~1/s.
      if (Date.now() - last < 900) return;
      last = Date.now();
      void tick();
    };
    void tick();
    const id = setInterval(tick, state.global.quoteRefreshMs);
    return () => {
      alive = false;
      quoteTick.current = null;
      clearInterval(id);
    };
  }, [
    t?.chainId,
    t?.token,
    state?.chain.quickBuyAmounts.join(),
    state?.chain.quickSellBps.join(),
    state?.locked,
    holding > 0n,
    prefs.hidden,
  ]);

  // ── RPC keep-alive: a click right after a pause should not wait for a new TLS
  // handshake. Runs while visible and for a while after the tab is hidden.
  const chainId = t?.chainId;
  const locked = state?.locked ?? true;
  useEffect(() => {
    if (chainId === undefined || locked || prefs.hidden) return;
    let seenAt = Date.now();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') seenAt = Date.now();
      else if (Date.now() - seenAt > WARM_HIDDEN_MAX_MS) return;
      void send({ type: 'rpc.warm', chainId });
    }, WARM_EVERY_MS);
    return () => clearInterval(id);
  }, [chainId, locked, prefs.hidden]);

  // ── wallet list: close on any click outside it (selection is saved on each toggle) ──
  useEffect(() => {
    if (!picker) return;
    const host = (sectionRef.current?.getRootNode() as ShadowRoot | undefined)?.host;
    // Clicks inside the closed shadow root reach the page retargeted to the host;
    // those are judged by the panel's own handler below.
    const onPage = (e: PointerEvent) => {
      if (e.target !== host) setPicker(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicker(false);
    };
    window.addEventListener('pointerdown', onPage, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPage, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [picker]);

  // ── push events from the background ──────────────────────────────────────
  useEffect(() => {
    const onMsg = (msg: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = msg as PushEvent;
      if (ev?.kind === 'celera.vault') void loadState();
      // New block (WebSocket RPC): refresh quotes right away instead of waiting.
      if (ev?.kind === 'celera.block' && ev.chainId === chainIdRef.current) quoteTick.current?.();
      if (ev?.kind === 'celera.ticket') {
        upsertTicket(ev.ticket);
        if (ev.ticket.legs.some((l) => l.status === 'confirmed')) void loadState();
        if (ev.ticket.blocked) setBlocked(ev.ticket.blocked);
      }
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [loadState]);

  const upsertTicket = (ticket: TradeTicket) =>
    setToasts((prev) => {
      const others = prev.filter((x) => x.id !== ticket.id);
      return [{ id: ticket.id, ticket }, ...others].slice(0, 4);
    });
  const pushError = (text: string, retry?: () => void, title = 'Trade not sent') => {
    const id = crypto.randomUUID();
    if (retry) retries.current.set(id, retry);
    setToasts((prev) =>
      [{ id, error: text, title, ...(retry ? { retry: true } : {}) }, ...prev].slice(0, 4),
    );
  };

  // ── actions ───────────────────────────────────────────────────────────────
  const selectedIds = (state?.wallets ?? []).filter((w) => w.selected).map((w) => w.id);

  const buy = async (amount: string, confirmed = false) => {
    if (!t || !state || state.locked || selectedIds.length === 0) return;
    const clickedAt = Date.now();
    setBlocked(null);
    setBusy(`buy:${amount}`);
    const r = await send({
      type: 'trade.buy',
      chainId: t.chainId,
      token: t.token,
      amount,
      walletIds: selectedIds,
      mode: state.global.multiWalletMode,
      confirmed,
      clickedAt,
    });
    setBusy(null);
    if (r.ok) upsertTicket(r.data);
    else if (r.error === 'locked') void loadState();
    else if (r.error === 'needs_confirmation')
      setPending({ kind: 'buy', amount, usd: r.detail ?? '' });
    else pushError(errorText(r), () => void buy(amount, confirmed));
  };

  const sell = async (bps: number, confirmed = false) => {
    if (!t || !state || state.locked || selectedIds.length === 0) return;
    const clickedAt = Date.now();
    setBlocked(null);
    setBusy(`sell:${bps}`);
    const r = await send({
      type: 'trade.sell',
      chainId: t.chainId,
      token: t.token,
      bps,
      walletIds: selectedIds,
      confirmed,
      clickedAt,
    });
    setBusy(null);
    if (r.ok) upsertTicket(r.data);
    else if (r.error === 'locked') void loadState();
    else if (r.error === 'needs_confirmation')
      setPending({ kind: 'sell', bps, usd: r.detail ?? '' });
    else pushError(errorText(r), () => void sell(bps, confirmed));
  };

  const replace = async (ticketId: string, walletId: string, mode: 'speedUp' | 'cancel') => {
    const r = await send({
      type: mode === 'speedUp' ? 'trade.speedUp' : 'trade.cancel',
      ticketId,
      walletId,
    });
    if (r.ok) upsertTicket(r.data);
    else
      pushError(
        errorText(r),
        undefined,
        mode === 'speedUp' ? 'Speed-up not sent' : 'Cancel not sent',
      );
  };

  // Optimistic: update the UI immediately, persist in the background, resync on failure.
  const setTrade = async (patch: TradePatch) => {
    if (!t || !state) return;
    const { mevEnabled, ...rest } = patch;
    setState({
      ...state,
      chain: {
        ...state.chain,
        ...rest,
        mev:
          mevEnabled === undefined ? state.chain.mev : { ...state.chain.mev, enabled: mevEnabled },
      },
    });
    const r = await send({ type: 'panel.setTrade', chainId: t.chainId, patch });
    if (!r.ok) {
      pushError(errorText(r), undefined, 'Setting not saved');
      await loadState();
    }
  };

  const toggleWallet = async (id: string) => {
    if (!state) return;
    const ids = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    if (ids.length === 0) return;
    setState({
      ...state,
      wallets: state.wallets.map((w) => ({ ...w, selected: ids.includes(w.id) })),
    });
    const r = await send({ type: 'panel.selectWallets', walletIds: ids });
    if (!r.ok) await loadState();
  };

  useHotkeys(
    !!state && !state.locked && state.global.hotkeysEnabled && !prefs.minimized && !prefs.hidden,
    (k) => {
      const i = ['1', '2', '3', '4'].indexOf(k);
      const amount = state?.chain.quickBuyAmounts[i];
      if (i >= 0 && amount) void buy(amount);
      const s = SELL_KEYS.indexOf(k);
      const bps = state?.chain.quickSellBps[s];
      if (s >= 0 && bps && holding > 0n) void sell(bps);
    },
    () => typingInPanel.current,
  );

  // ── render ───────────────────────────────────────────────────────────────
  if (target === null && !detection) return null;
  if (prefs.hidden) {
    return (
      <button
        type="button"
        class="k chip"
        style={{ right: '16px', bottom: '16px', width: 'auto' }}
        onClick={trusted(() => setPrefs({ hidden: false }))}
      >
        <span class="brand">
          <BirdMark size={16} />
          Celera
        </span>
      </button>
    );
  }

  const x =
    prefs.x < 0
      ? window.innerWidth - PANEL_WIDTH - PANEL_GAP
      : clamp(prefs.x, 0, window.innerWidth - PANEL_WIDTH);
  const y = prefs.y < 0 ? 80 : clamp(prefs.y, 0, window.innerHeight - 40);
  const pos = drag.live ?? { x, y };

  const quoteSub = (q: QuoteView | null | undefined, side: 'buy' | 'sell') => {
    if (!q) return quotes ? 'no route' : '…';
    const out =
      side === 'buy'
        ? `${formatToken(BigInt(q.amountOut), t?.decimals ?? 18)}`
        : `${formatCompact(Number(formatEther(BigInt(q.amountOut))))} ${native}`;
    return out;
  };
  const impactCls = (bps: number | null | undefined) =>
    bps === null || bps === undefined || !state
      ? 'faint'
      : bps >= state.global.priceImpactDangerBps
        ? 'imp-bad'
        : bps >= state.global.priceImpactWarnBps
          ? 'imp-warn'
          : 'imp-ok';

  const selectedCount = selectedIds.length;
  const customAmount = parseDecimalInput(custom);
  const summaryAmount = customAmount ?? state?.chain.quickBuyAmounts[0] ?? '0';
  const perWallet = (() => {
    try {
      const a = parseEther(summaryAmount);
      return state?.global.multiWalletMode === 'split' && selectedCount > 0
        ? a / BigInt(selectedCount)
        : a;
    } catch {
      return 0n;
    }
  })();
  const totalWei = perWallet * BigInt(Math.max(selectedCount, 1));
  const totalUsd = state?.nativeUsd ? Number(formatEther(totalWei)) * state.nativeUsd : null;
  const holdingUsd =
    quotes?.tokenUsd && t ? Number(formatUnits(holding, t.decimals)) * quotes.tokenUsd : null;
  // Of the tokens bought through Celera and still held: value now against what they cost.
  const pnl =
    t && state
      ? unrealisedPnl(
          state.wallets.filter((w) => w.selected),
          t.decimals,
          quotes?.tokenUsd ?? null,
          state.nativeUsd,
        )
      : null;
  const nativeBal = (state?.wallets ?? [])
    .filter((w) => w.selected)
    .reduce((s, w) => s + BigInt(w.native), 0n);
  const disabled = !state || state.locked || selectedCount === 0;

  const header = (
    <div class="head" {...drag.handlers}>
      <span class="brand">
        <BirdMark size={16} />
        Celera
      </span>
      {chain && <span class="chain">{chain.shortName}</span>}
      {t && (
        <span class="sym" title={t.name}>
          {t.symbol}
        </span>
      )}
      {t && chain && (
        // The contract address is what is actually traded; let the user check it.
        <a
          class="addr"
          href={`${chain.explorer.url}/token/${t.token}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`${t.name} — ${t.token}`}
        >
          {shortAddress(t.token)}
        </a>
      )}
      <span class="sp" />
      <button
        type="button"
        class="ib"
        aria-label={prefs.minimized ? 'Expand' : 'Minimize'}
        onClick={trusted(() => setPrefs({ minimized: !prefs.minimized }))}
      >
        {prefs.minimized ? '▢' : '–'}
      </button>
      <button
        type="button"
        class="ib"
        aria-label="Hide panel"
        onClick={trusted(() => setPrefs({ hidden: true }))}
      >
        ×
      </button>
    </div>
  );

  let body;
  if (target === 'loading') {
    body = <div class="body muted">Detecting token…</div>;
  } else if (!t) {
    body = (
      <div class="body">
        <div class="card warn">
          <strong>Token not detected</strong>
          <span class="muted">This page does not point to a token on a supported chain.</span>
        </div>
      </div>
    );
  } else if (!state) {
    body = <div class="body muted">Loading…</div>;
  } else if (state.locked) {
    body = (
      <div class="body">
        <span class="muted">
          Unlock Celera to trade. Your password is typed into an extension frame the page cannot
          read.
        </span>
        <iframe
          class="unlock-frame"
          title="Unlock Celera"
          src={browser.runtime.getURL('/unlock.html')}
        />
      </div>
    );
  } else if (prefs.minimized) {
    body = (
      <div class="mini">
        {state.chain.quickBuyAmounts.slice(0, 2).map((a, i) => (
          <button
            key={i}
            type="button"
            class="tb buy"
            disabled={disabled}
            onClick={trusted(() => void buy(a))}
            aria-busy={busy === `buy:${a}`}
          >
            <span class="main">
              {a} {native}
            </span>
          </button>
        ))}
        <button
          type="button"
          class="tb sell"
          disabled={disabled || holding === 0n}
          onClick={trusted(() => void sell(maxSellBps))}
          aria-busy={busy === `sell:${maxSellBps}`}
        >
          <span class="main">Sell {formatPercent(maxSellBps)}</span>
        </button>
      </div>
    );
  } else {
    body = (
      <div class="body">
        <div class="pick-wrap" ref={pickerRef}>
          <div class="row">
            <button
              type="button"
              class="chip"
              aria-expanded={picker}
              onClick={trusted(() => setPicker(!picker))}
            >
              {selectedCount} wallet{selectedCount === 1 ? '' : 's'} ▾
            </button>
          </div>

          {picker && (
            <div class="picker" role="group" aria-label="Wallets">
              {state.wallets.map((w) => (
                <label key={w.id} class="wrow">
                  <input
                    type="checkbox"
                    checked={w.selected}
                    onChange={trusted(() => void toggleWallet(w.id))}
                  />
                  <span style={{ flex: 1 }}>
                    {w.name} <span class="faint">{shortAddress(w.address)}</span>
                  </span>
                  <span class="muted">
                    {formatToken(BigInt(w.native), 18)} {native}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div class="pos">
          <span class="muted">
            Balance {formatToken(nativeBal, 18)} {native}
          </span>
          <span>
            {holding > 0n ? (
              <>
                {formatToken(holding, t.decimals)} {t.symbol}
                {holdingUsd !== null && <span class="muted"> · {formatUsd(holdingUsd)}</span>}
                {pnl && (
                  <span
                    class={`pnl ${pnl.usd >= 0 ? 'up' : 'down'}`}
                    title="Unrealised PnL of the tokens bought through Celera, gas not included"
                  >
                    {pnl.usd >= 0 ? '+' : '−'}
                    {formatUsd(Math.abs(pnl.usd))} ({pnl.bps >= 0 ? '+' : '−'}
                    {formatPercent(Math.abs(pnl.bps))})
                  </span>
                )}
              </>
            ) : (
              <span class="faint">No position</span>
            )}
          </span>
        </div>

        <TradeSettings chain={state.chain} onChange={(patch) => void setTrade(patch)} />

        <div>
          <div class="lbl-row">
            <span class="lbl">Buy</span>
            <button
              type="button"
              class="ib pen"
              aria-label="Edit quick-buy amounts"
              title="Edit quick-buy amounts"
              aria-pressed={editingAmounts}
              onClick={trusted(() => setEditingAmounts(!editingAmounts))}
            >
              <PenIcon />
            </button>
          </div>
          {editingAmounts ? (
            <QuickValuesEditor
              values={state.chain.quickBuyAmounts}
              unit={native}
              what="Quick-buy amount"
              columns={2}
              validate={(n) => n > 0}
              onCancel={() => setEditingAmounts(false)}
              onSave={(amounts) => {
                setEditingAmounts(false);
                void setTrade({ quickBuyAmounts: amounts });
              }}
            />
          ) : (
            <div class="grid">
              {state.chain.quickBuyAmounts.map((a, i) => {
                const q = quotes?.buys[i];
                return (
                  <button
                    key={i}
                    type="button"
                    class="tb buy"
                    disabled={disabled}
                    onClick={trusted(() => void buy(a))}
                    aria-busy={busy === `buy:${a}`}
                    aria-label={`Buy ${a} ${native}`}
                  >
                    <kbd>{i + 1}</kbd>
                    <span class="main">
                      {a} {native}
                    </span>
                    <span class="sub">
                      {busy === `buy:${a}` ? 'Sending…' : quoteSub(q, 'buy')}
                      {q?.priceImpactBps !== undefined && q?.priceImpactBps !== null && (
                        <span class={impactCls(q.priceImpactBps)}>
                          {' '}
                          · {formatPercent(q.priceImpactBps)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <form
          class="custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (!e.isTrusted) return;
            if (customAmount) void buy(customAmount);
          }}
        >
          <input
            aria-label={`Custom amount in ${native}`}
            placeholder={`Amount (${native})`}
            inputMode="decimal"
            value={custom}
            onInput={(e) => setCustom(e.currentTarget.value)}
          />
          <button type="submit" class="btn buy" disabled={disabled || !customAmount}>
            Buy
          </button>
        </form>

        {selectedCount > 1 && (
          <div class="summary">
            {formatCompact(Number(formatEther(perWallet)))} {native} per wallet × {selectedCount} ={' '}
            {formatCompact(Number(formatEther(totalWei)))} {native}
            {totalUsd !== null && <span class="muted"> ≈ {formatUsd(totalUsd)}</span>}
            <span class="faint">
              {' '}
              · {state.global.multiWalletMode === 'split' ? 'split total' : 'same per wallet'}
            </span>
          </div>
        )}

        <div>
          <div class="lbl-row">
            <span class="lbl">Sell</span>
            <button
              type="button"
              class="ib pen"
              aria-label="Edit quick-sell percentages"
              title="Edit quick-sell percentages"
              aria-pressed={editingSells}
              onClick={trusted(() => setEditingSells(!editingSells))}
            >
              <PenIcon />
            </button>
          </div>
          {editingSells ? (
            <QuickValuesEditor
              values={state.chain.quickSellBps.map((b) => String(b / 100))}
              unit="%"
              what="Quick-sell percentage"
              columns={4}
              validate={isSellPercent}
              onCancel={() => setEditingSells(false)}
              onSave={(values) => {
                setEditingSells(false);
                void setTrade({ quickSellBps: values.map((v) => Math.round(Number(v) * 100)) });
              }}
            />
          ) : (
            <div class="sells">
              {state.chain.quickSellBps.map((bps, i) => (
                <button
                  key={i}
                  type="button"
                  class="tb sell"
                  disabled={disabled || holding === 0n}
                  onClick={trusted(() => void sell(bps))}
                  aria-busy={busy === `sell:${bps}`}
                  aria-label={`Sell ${bps / 100}%`}
                >
                  <kbd>{(SELL_KEYS[i] ?? '').toUpperCase()}</kbd>
                  <span class="main">{bps / 100}%</span>
                  <span class="sub">
                    {busy === `sell:${bps}`
                      ? 'Sending…'
                      : holding > 0n
                        ? quoteSub(quotes?.sells[i], 'sell')
                        : '–'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {pending && (
          <div class="card warn" role="alertdialog" aria-label="Confirm trade">
            <strong>
              Confirm{' '}
              {pending.kind === 'buy'
                ? `buy ${pending.amount} ${native}`
                : `sell ${pending.bps / 100}%`}
            </strong>
            <span class="muted">Worth about {pending.usd}, above your confirmation threshold.</span>
            <div class="row">
              <button type="button" class="btn" onClick={trusted(() => setPending(null))}>
                Cancel
              </button>
              <button
                type="button"
                class={`btn ${pending.kind}`}
                onClick={trusted(() => {
                  const p = pending;
                  setPending(null);
                  if (p.kind === 'buy') void buy(p.amount, true);
                  else void sell(p.bps, true);
                })}
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        {blocked && (
          <div class="card danger" role="alert">
            <div class="row">
              <strong>Transaction blocked</strong>
              <span class="sp" />
              <button
                type="button"
                class="ib"
                aria-label="Dismiss"
                onClick={trusted(() => setBlocked(null))}
              >
                ×
              </button>
            </div>
            <span class="muted">Nothing was signed. Decoded actions:</span>
            {blocked.map((a, i) => (
              <div key={i} class="act">
                <span class={a.ok ? 'ok' : 'no'}>{a.ok ? '✓' : '✗'}</span>
                <span>
                  {a.label}
                  {a.reason && <span class="no"> — {a.reason}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const status = (
    <div class="status">
      <span class={`dot ${quoteErr ? 'err' : quotes ? 'on' : ''}`} />
      <span class="venue" title={quotes?.venue ?? ''}>
        {quoteErr
          ? 'Quote failed'
          : quotes
            ? `${quotes.venue ?? 'No route'}`
            : state?.locked
              ? 'Locked'
              : 'Waiting for quotes'}
      </span>
      {quotes?.tax && state && <TaxBadge tax={quotes.tax} maxBps={state.chain.maxTaxBps} />}
      {quotes?.taxUnknown && state && (
        <span
          class={state.chain.maxTaxBps < 10_000 ? 'imp-bad' : 'imp-warn'}
          title="The token tax could not be measured (the RPC may not simulate, or only an aggregator trades it). With Max tax on, buys are refused."
        >
          · Tax ?
        </span>
      )}
      <span class="sp" />
      {state && <MevStatus mev={state.chain.mev} />}
      {state && !state.locked && state.global.hotkeysEnabled && <span>· 1–4 / Q–R</span>}
    </div>
  );

  return (
    <>
      <section
        class="k"
        ref={sectionRef}
        onPointerDown={(e) => {
          if (picker && !pickerRef.current?.contains(e.target as Node)) setPicker(false);
        }}
        // Ends above the window's bottom edge wherever it sits; the rest scrolls inside.
        style={{
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          maxHeight: `${Math.max(120, window.innerHeight - pos.y - 8)}px`,
        }}
        aria-label="Celera trading panel"
        // Track focus inside the closed shadow root so hotkeys stay off while typing here.
        onFocusIn={(e) => (typingInPanel.current = isEditable(e.target))}
        onFocusOut={() => (typingInPanel.current = false)}
      >
        {header}
        {body}
        {t && !prefs.minimized && status}
      </section>
      <Toasts
        items={toasts}
        decimals={t?.decimals ?? 18}
        symbol={t?.symbol ?? ''}
        native={native}
        placement={toastPlacement(pos.x, window.innerWidth)}
        onDismiss={(id) => {
          retries.current.delete(id);
          setToasts((p) => p.filter((x) => x.id !== id));
        }}
        onRetry={(id) => {
          retries.current.get(id)?.();
          retries.current.delete(id);
          setToasts((p) => p.filter((x) => x.id !== id));
        }}
        onReplace={replace}
      />
    </>
  );
}
