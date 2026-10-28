import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatEther, parseEther } from 'viem';
import { browser } from 'wxt/browser';
import { CHAINS, getChain } from '../../shared/chains';
import { formatCompact, formatUsd, parseDecimalInput } from '../../shared/format';
import type { BridgeQuoteView, PushEvent } from '../../shared/messages';
import type { TradeTicket } from '../../shared/panel';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { statusOf } from './Activity';
import { IconSwap } from './icons';
import { ChainMark, Picker } from './Picker';
import { txUrl } from './links';

/** Kept back by MAX so the deposit transaction itself can pay gas. */
function gasReserve(chainId: number): bigint {
  if (chainId === 1) return parseEther('0.002');
  if (chainId === 56) return parseEther('0.0005');
  return parseEther('0.0002');
}

export function Bridge({
  accounts,
  defaultChainId,
}: {
  accounts: WalletAccount[];
  defaultChainId: number;
}) {
  const chains = [...CHAINS.values()];
  const visible = accounts.filter((a) => !a.hidden);
  const primary = accounts.find((a) => a.primary) ?? visible[0];
  const [fromChain, setFromChain] = useState(defaultChainId);
  const [toChain, setToChain] = useState(chains.find((c) => c.id !== defaultChainId)?.id ?? 1);
  const [fromWallet, setFromWallet] = useState(primary?.id ?? '');
  const [toWallet, setToWallet] = useState(primary?.id ?? '');
  const [amount, setAmount] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<BridgeQuoteView | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TradeTicket | null>(null);
  const [busy, setBusy] = useState(false);

  const fromSym = getChain(fromChain)?.nativeCurrency.symbol ?? 'ETH';
  const toSym = getChain(toChain)?.nativeCurrency.symbol ?? 'ETH';
  const balance = BigInt(balances[fromWallet] ?? '0');
  const parsed = parseDecimalInput(amount);
  const amountWei = (() => {
    try {
      return parsed ? parseEther(parsed) : null;
    } catch {
      return null; // more than 18 decimals
    }
  })();
  const tooMuch = amountWei !== null && amountWei > balance;

  useEffect(() => {
    void send({ type: 'wallets.balances', chainId: fromChain }).then((r) => {
      if (r.ok) setBalances(Object.fromEntries(r.data.map((b) => [b.id, b.native])));
    });
  }, [fromChain, ticket?.status]);

  // Live progress for the bridge started here.
  useEffect(() => {
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = m as PushEvent;
      if (ev?.kind === 'celera.ticket')
        setTicket((t) => (t && t.id === ev.ticket.id ? ev.ticket : t));
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);

  // Quote as you type (debounced).
  const req = useMemo(
    () =>
      parsed &&
      amountWei !== null &&
      amountWei > 0n &&
      fromChain !== toChain &&
      fromWallet &&
      toWallet
        ? {
            fromChainId: fromChain,
            toChainId: toChain,
            amount: parsed,
            fromWalletId: fromWallet,
            toWalletId: toWallet,
          }
        : null,
    [parsed, amountWei, fromChain, toChain, fromWallet, toWallet],
  );
  useEffect(() => {
    setQuote(null);
    setError(null);
    setConfirm(null);
    if (!req) return;
    let alive = true;
    setQuoting(true);
    const t = setTimeout(async () => {
      const r = await send({ type: 'bridge.quote', ...req });
      if (!alive) return;
      setQuoting(false);
      if (r.ok) setQuote(r.data);
      else setError(errorText(r));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [req && JSON.stringify(req)]);

  const flip = () => {
    setFromChain(toChain);
    setToChain(fromChain);
  };

  const max = () => {
    const v = balance - gasReserve(fromChain);
    setAmount(v > 0n ? formatEther(v) : '0');
  };

  const run = async (confirmed: boolean) => {
    if (!req) return;
    setBusy(true);
    setError(null);
    const r = await send({ type: 'bridge.execute', ...req, confirmed });
    setBusy(false);
    if (r.ok) {
      setConfirm(null);
      setTicket(r.data);
      setAmount('');
    } else if (r.error === 'needs_confirmation') setConfirm(r.detail ?? '');
    else setError(errorText(r));
  };

  const walletSelect = (
    value: string,
    onChange: (v: string) => void,
    title: string,
    showBalance: boolean,
  ) => (
    <Picker
      title={title}
      variant="compact"
      value={value}
      onChange={onChange}
      options={visible.map((a) => ({
        value: a.id,
        label: a.name,
        sub: showBalance
          ? `${shortAddress(a.address)} · ${formatCompact(Number(formatEther(BigInt(balances[a.id] ?? '0'))))} ${fromSym}`
          : shortAddress(a.address),
      }))}
    />
  );

  const chainSelect = (
    value: number,
    onChange: (v: number) => void,
    title: string,
    exclude: number,
    excludeNote: string,
  ) => (
    <Picker
      title={title}
      variant="compact"
      value={value}
      onChange={onChange}
      options={chains.map((c) => ({
        value: c.id,
        label: c.name,
        sub: c.nativeCurrency.symbol,
        mark: <ChainMark chainId={c.id} />,
        disabled: c.id === exclude,
        disabledNote: excludeNote,
      }))}
    />
  );

  const st = ticket ? statusOf(ticket) : null;
  const depositHash = ticket?.legs.find((l) => l.hash)?.hash;

  return (
    <div class="stack" style={{ gap: '8px' }}>
      <div class="card leg">
        <div class="row">
          <span class="section-title">From</span>
          <span class="spacer" />
          <span class="hint">
            Balance {formatCompact(Number(formatEther(balance)))} {fromSym}
          </span>
          <button type="button" class="link" onClick={max}>
            MAX
          </button>
        </div>
        <div class="row">
          <input
            class="amt-input"
            aria-label={`Amount in ${fromSym}`}
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onInput={(e) => setAmount(e.currentTarget.value)}
          />
          {chainSelect(fromChain, setFromChain, 'Bridge from', toChain, 'Selected as destination')}
        </div>
        <div class="row">
          <span class="hint">
            {quote?.amountInUsd != null ? `≈ ${formatUsd(quote.amountInUsd)}` : ''}
          </span>
          <span class="spacer" />
          {walletSelect(fromWallet, setFromWallet, 'Send from', true)}
        </div>
      </div>

      <button type="button" class="swap" aria-label="Swap chains" onClick={flip}>
        <IconSwap size={16} />
      </button>

      <div class="card leg">
        <div class="row">
          <span class="section-title">To</span>
        </div>
        <div class="row">
          <span class="amt-out">
            {quote
              ? formatCompact(Number(formatEther(BigInt(quote.amountOut))))
              : quoting
                ? '…'
                : '0.0'}
          </span>
          <span class="spacer" />
          {chainSelect(toChain, setToChain, 'Bridge to', fromChain, 'Selected as source')}
        </div>
        <div class="row">
          <span class="hint">{toSym}</span>
          <span class="spacer" />
          {walletSelect(toWallet, setToWallet, 'Receive in', false)}
        </div>
      </div>

      {quote && (
        <div class="card quote">
          <div class="row">
            <span class="muted">Fee</span>
            <span class="spacer" />
            <span>{quote.feeUsd != null ? formatUsd(quote.feeUsd) : '–'}</span>
          </div>
          <div class="row">
            <span class="muted">Estimated time</span>
            <span class="spacer" />
            <span>
              {quote.timeEstimateS != null
                ? `~${Math.max(1, Math.round(quote.timeEstimateS))} s`
                : '–'}
            </span>
          </div>
          <div class="row">
            <span class="muted">Route</span>
            <span class="spacer" />
            <span>Relay</span>
          </div>
        </div>
      )}

      {confirm !== null ? (
        <div class="notice notice--warn" role="alertdialog">
          Bridge about {confirm}? This is above your confirmation threshold.
          <div class="row" style={{ marginTop: '8px' }}>
            <button type="button" class="btn btn--sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" class="btn btn--sm btn--primary" onClick={() => void run(true)}>
              Confirm
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          class="btn btn--primary btn--block"
          style={{ height: '40px' }}
          disabled={!quote || busy || quoting || tooMuch}
          onClick={() => void run(false)}
        >
          {tooMuch
            ? 'Insufficient balance'
            : busy
              ? 'Sending…'
              : `Bridge ${parsed ?? ''} ${fromSym}`}
        </button>
      )}

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {ticket && st && (
        <div class="card quote" role="status">
          <div class="row">
            <strong>Bridge</strong>
            <span class="spacer" />
            <span class={st.cls}>{st.text}</span>
          </div>
          {depositHash && (
            <a href={txUrl(ticket.chainId, depositHash)} target="_blank" rel="noopener noreferrer">
              Deposit transaction ↗
            </a>
          )}
          {ticket.bridge?.outHash && (
            <a
              href={txUrl(ticket.bridge.toChainId, ticket.bridge.outHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Received on {getChain(ticket.bridge.toChainId)?.name} ↗
            </a>
          )}
          {ticket.legs.find((l) => l.error)?.error && (
            <span class="error">{ticket.legs.find((l) => l.error)?.error}</span>
          )}
        </div>
      )}

      <p class="hint" style={{ textAlign: 'center' }}>
        Recipient is always one of your wallets. Your USD limits apply. Powered by Relay.
      </p>
    </div>
  );
}
