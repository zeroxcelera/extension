import { useEffect, useState } from 'preact/hooks';
import { formatEther } from 'viem';
import { browser } from 'wxt/browser';
import { CHAINS } from '../../shared/chains';
import { formatCompact, parseDecimalInput } from '../../shared/format';
import type { PushEvent } from '../../shared/messages';
import type { TradeTicket } from '../../shared/panel';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, Notice, TextField } from '../../ui/components';
import { ChainMark, Picker } from './Picker';

type Mode = 'distribute' | 'collect';

/**
 * Move native funds between your own wallets. Distribute: one wallet sends the same
 * amount to each selected wallet. Collect: the selected wallets send everything (minus
 * a gas reserve) into one wallet. The one wallet starts as the default wallet.
 */
export function Transfers({
  accounts,
  defaultChainId,
  initialMode = 'distribute',
}: {
  accounts: WalletAccount[];
  defaultChainId?: number;
  initialMode?: Mode;
}) {
  const chains = [...CHAINS.values()];
  const visible = accounts.filter((a) => !a.hidden);
  const fallbackHub = accounts.find((a) => a.primary) ?? visible[0];
  const [mode, setMode] = useState<Mode>(initialMode);
  const [chainId, setChainId] = useState(defaultChainId ?? chains[0]?.id ?? 1);
  const [hubId, setHubId] = useState(fallbackHub?.id ?? '');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [ticket, setTicket] = useState<TradeTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chain = chains.find((c) => c.id === chainId);
  const others = visible.filter((a) => a.id !== hubId);

  useEffect(() => {
    setBalances({});
    void send({ type: 'wallets.balances', chainId }).then((r) => {
      if (r.ok) setBalances(Object.fromEntries(r.data.map((b) => [b.id, b.native])));
    });
  }, [chainId, ticket?.status]);

  // The hub can't also be one of the other wallets.
  useEffect(() => setSelected((s) => s.filter((id) => id !== hubId)), [hubId]);

  // Live updates for the ticket started here.
  useEffect(() => {
    const onMsg = (msg: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = msg as PushEvent;
      if (ev?.kind === 'celera.ticket')
        setTicket((t) => (t && t.id === ev.ticket.id ? ev.ticket : t));
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, []);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const sym = chain?.nativeCurrency.symbol ?? 'ETH';
  const bal = (id: string) => formatCompact(Number(formatEther(BigInt(balances[id] ?? '0'))));
  const each = parseDecimalInput(amount);
  const n = selected.length;
  const plural = (k: number) => `${k} wallet${k === 1 ? '' : 's'}`;

  const run = async () => {
    setError(null);
    setBusy(true);
    const r =
      mode === 'distribute'
        ? await send({
            type: 'wallets.distribute',
            chainId,
            hubId,
            walletIds: selected,
            amountEach: each ?? '0',
          })
        : await send({ type: 'wallets.collect', chainId, hubId, walletIds: selected });
    setBusy(false);
    if (r.ok) setTicket(r.data);
    else setError(errorText(r));
  };

  const hubPicker = (
    <Picker
      title={mode === 'distribute' ? 'Send from' : 'Collect into'}
      value={hubId}
      onChange={setHubId}
      options={visible.map((a) => ({
        value: a.id,
        label: `${a.name}${a.primary ? ' ★' : ''}`,
        sub: `${shortAddress(a.address)} · ${bal(a.id)} ${sym}`,
      }))}
    />
  );

  const list =
    others.length === 0 ? (
      <Notice>Add another wallet first.</Notice>
    ) : (
      <div class="stack" style={{ gap: '6px' }}>
        {others.map((a) => (
          <label key={a.id} class="wallet" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={selected.includes(a.id)}
              onChange={() => toggle(a.id)}
            />
            <span style={{ flex: 1 }}>{a.name}</span>
            <span class="muted mono">
              {bal(a.id)} {sym}
            </span>
          </label>
        ))}
      </div>
    );

  return (
    <div class="stack">
      <h2>Move funds</h2>
      <div class="seg-tabs" role="tablist" aria-label="Transfer type">
        {(['distribute', 'collect'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setTicket(null);
              setError(null);
            }}
          >
            {m === 'distribute' ? 'Distribute' : 'Collect'}
          </button>
        ))}
      </div>
      <p class="muted">
        {mode === 'distribute'
          ? 'Send the same amount from one wallet to several others.'
          : 'Move everything from several wallets into one, keeping a little for gas.'}
      </p>

      <div class="field">
        <span class="label">Chain</span>
        <Picker
          title="Move funds on"
          value={chainId}
          onChange={setChainId}
          options={chains.map((c) => ({
            value: c.id,
            label: c.name,
            sub: c.nativeCurrency.symbol,
            mark: <ChainMark chainId={c.id} />,
          }))}
        />
      </div>

      {mode === 'distribute' ? (
        <>
          <div class="field">
            <span class="label">From</span>
            {hubPicker}
          </div>
          <div class="field">
            <span class="label">To</span>
            {list}
          </div>
          <TextField
            label={`Amount each wallet receives (${sym})`}
            value={amount}
            onInput={setAmount}
            placeholder="0.01"
          />
        </>
      ) : (
        <>
          <div class="field">
            <span class="label">From</span>
            {list}
          </div>
          <div class="field">
            <span class="label">Into</span>
            {hubPicker}
          </div>
        </>
      )}

      <Button
        variant="primary"
        disabled={busy || n === 0 || !hubId || (mode === 'distribute' && !each)}
        onClick={() => void run()}
      >
        {busy
          ? 'Sending…'
          : n === 0
            ? 'Select wallets'
            : mode === 'distribute'
              ? `Send ${each ?? '…'} ${sym} to ${plural(n)}`
              : `Collect from ${plural(n)}`}
      </Button>
      <p class="hint">
        Transfers only go between your own wallets.
        {mode === 'distribute' ? ' Your USD limits apply.' : ''}
      </p>
      {error && <p class="error">{error}</p>}
      {ticket && (
        <div class="card" style={{ padding: '10px', display: 'grid', gap: '4px' }}>
          <strong>
            {ticket.kind === 'distribute' ? 'Distribute' : 'Collect'}: {ticket.status}
          </strong>
          {ticket.legs.map((l, i) => (
            <span key={i} class="muted">
              {l.walletName} · {l.status}
              {l.hash && (
                <>
                  {' '}
                  ·{' '}
                  <a
                    href={`${ticket.explorer}/tx/${l.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    view
                  </a>
                </>
              )}
              {l.error && ` · ${l.error}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
