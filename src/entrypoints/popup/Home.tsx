import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatEther, formatUnits, type Address } from 'viem';
import { browser } from 'wxt/browser';
import { getChain } from '../../shared/chains';
import { formatCompact, formatToken, formatUsd } from '../../shared/format';
import type { Portfolio, PortfolioTokenView, PushEvent } from '../../shared/messages';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { useCopy } from '../../ui/components';
import {
  IconCollect,
  IconCopy,
  IconFund,
  IconKey,
  IconReceive,
  IconSend,
  IconSpark,
} from './icons';
import { Sheet } from './Picker';
import { chartUrl } from './links';
import { TokenAvatar } from './TokenAvatar';

const SEL_KEY = 'celera.popup.wallet';

function loadSel(): string {
  try {
    return localStorage.getItem(SEL_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

function saveSel(v: string) {
  try {
    localStorage.setItem(SEL_KEY, v);
  } catch {
    /* storage unavailable: selection just isn't remembered */
  }
}

function pillLabel(a: WalletAccount): string {
  const m = a.name.match(/^Wallet (\d+)$/);
  if (m) return `W${m[1]}`;
  return [...a.name].slice(0, 8).join('');
}

export function Home({
  chainId,
  accounts,
  onManage,
  onImport,
  onTransfers,
  onSend,
  onReceive,
  onChanged,
}: {
  chainId: number;
  accounts: WalletAccount[];
  onManage: (id: string) => void;
  onImport: () => void;
  onTransfers: (mode: 'distribute' | 'collect') => void;
  /** The selected wallet, or null when "All" is selected. */
  onSend: (walletId: string | null) => void;
  onReceive: (walletId: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const chain = getChain(chainId);
  const native = chain?.nativeCurrency.symbol ?? 'ETH';
  const [showHidden, setShowHidden] = useState(false);
  const pills = accounts.filter((a) => showHidden || !a.hidden);
  const [sel, setSel] = useState(loadSel);
  const selected = sel === 'all' ? null : (accounts.find((a) => a.id === sel) ?? null);
  const walletIds = selected ? [selected.id] : pills.map((a) => a.id);

  const [data, setData] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDust, setShowDust] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ token: string; bps: number; usd: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [copied, copy] = useCopy();

  const load = useCallback(async () => {
    if (walletIds.length === 0) return;
    setLoading(true);
    const r = await send({ type: 'portfolio.get', chainId, walletIds });
    setLoading(false);
    if (r.ok) setData(r.data);
    else setMsg(errorText(r));
  }, [chainId, walletIds.join()]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  // Refresh after a trade from this popup (or the panel) confirms.
  useEffect(() => {
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const ev = m as PushEvent;
      if (
        ev?.kind === 'celera.ticket' &&
        ev.ticket.chainId === chainId &&
        ev.ticket.status !== 'working'
      )
        void load();
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [load, chainId]);

  const pick = (v: string) => {
    setSel(v);
    saveSel(v);
    setOpen(null);
  };

  const nativeTotal = data ? Object.values(data.native).reduce((s, v) => s + BigInt(v), 0n) : 0n;
  const nativeUsd = data?.nativeUsd ? Number(formatEther(nativeTotal)) * data.nativeUsd : null;
  const tokens = data?.tokens ?? [];
  const visible = tokens.filter((t) => !t.dust && !t.unsolicited);
  const dust = tokens.filter((t) => t.dust && !t.unsolicited);
  // Airdrops the user never bought: often scams with a faked price, never in totals.
  const spam = tokens.filter((t) => t.unsolicited);
  const totalUsd =
    nativeUsd === null ? null : nativeUsd + visible.reduce((s, t) => s + (t.valueUsd ?? 0), 0);

  const sell = async (t: PortfolioTokenView, bps: number, confirmed = false) => {
    setMsg(null);
    const holders = Object.keys(t.perWallet).filter((id) => walletIds.includes(id));
    const r = await send({
      type: 'trade.sell',
      chainId,
      token: t.address as Address,
      bps,
      walletIds: holders,
      confirmed,
    });
    if (r.ok) {
      setConfirm(null);
      setMsg(`Selling ${bps / 100}% of ${t.symbol} — follow it in Activity.`);
    } else if (r.error === 'needs_confirmation')
      setConfirm({ token: t.address, bps, usd: r.detail ?? '' });
    else setMsg(errorText(r));
  };

  // Fund and Collect move money between your own wallets: they need two of them.
  const moveFunds = (mode: 'distribute' | 'collect') => {
    if (accounts.length < 2) setMsg('Fund and Collect need a second wallet. Add one with +.');
    else onTransfers(mode);
  };

  const addWallet = async () => {
    const r = await send({ type: 'wallets.add' });
    if (r.ok) {
      await onChanged();
      pick(r.data.id);
    } else setMsg(errorText(r));
  };

  const addToken = async () => {
    const addr = newToken.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setMsg('Enter a token contract address (0x…).');
      return;
    }
    const r = await send({ type: 'portfolio.addToken', chainId, token: addr as Address });
    if (r.ok) {
      setAdding(false);
      setNewToken('');
      await load();
    } else setMsg(errorText(r));
  };

  const setTrusted = async (t: PortfolioTokenView, trusted: boolean) => {
    const r = await send({
      type: 'portfolio.setTrusted',
      chainId,
      token: t.address as Address,
      trusted,
    });
    if (r.ok) {
      setOpen(null);
      await load();
    } else setMsg(errorText(r));
  };

  const tokenRow = (t: PortfolioTokenView) => {
    const holders = Object.keys(t.perWallet).filter((id) => walletIds.includes(id)).length;
    const isOpen = open === t.address;
    return (
      <li key={t.address} class={`tok${t.dust || t.unsolicited ? ' is-dust' : ''}`}>
        <button
          type="button"
          class="tok-main"
          aria-expanded={isOpen}
          onClick={() => setOpen(isOpen ? null : t.address)}
        >
          <TokenAvatar chainId={chainId} token={t.address} symbol={t.symbol} />
          <span class="tname">
            {t.symbol}
            <small>{selected ? t.name : `in ${holders} wallet${holders === 1 ? '' : 's'}`}</small>
          </span>
          <span class="tval">
            {t.valueUsd !== null ? formatUsd(t.valueUsd) : 'Unpriced'}
            <small>{formatToken(BigInt(t.total), t.decimals)}</small>
          </span>
        </button>
        {isOpen && t.unsolicited && (
          <div class="tok-actions tok-spam">
            <p class="hint">
              You never bought this token: it was sent to you. Unrequested tokens are often scams,
              and their price and name can be faked. Do not visit links in its name.
            </p>
            <button type="button" class="btn btn--sm" onClick={() => void setTrusted(t, true)}>
              It's mine, show it
            </button>
          </div>
        )}
        {isOpen && !t.unsolicited && (
          <div class="tok-actions">
            <a
              class="btn btn--sm"
              href={chartUrl(chainId, t.address)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open chart
            </a>
            <button type="button" class="btn btn--sm btn--sell" onClick={() => void sell(t, 5_000)}>
              Sell 50%
            </button>
            <button
              type="button"
              class="btn btn--sm btn--sell"
              onClick={() => void sell(t, 10_000)}
            >
              Sell 100%
            </button>
            <button type="button" class="btn btn--sm" onClick={() => void setTrusted(t, false)}>
              Hide
            </button>
          </div>
        )}
        {confirm?.token === t.address && (
          <div class="notice notice--warn tok-confirm" role="alertdialog">
            Sell {confirm.bps / 100}% (about {confirm.usd})?
            <span class="row" style={{ marginTop: '6px' }}>
              <button type="button" class="btn btn--sm" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                class="btn btn--sm btn--sell"
                onClick={() => void sell(t, confirm.bps, true)}
              >
                Confirm
              </button>
            </span>
          </div>
        )}
      </li>
    );
  };

  return (
    <div class="stack" style={{ gap: '10px' }}>
      <div class="pills" role="tablist" aria-label="Wallets">
        <button
          type="button"
          role="tab"
          class="pill"
          aria-selected={!selected}
          onClick={() => pick('all')}
        >
          All<small>{pills.length}</small>
        </button>
        {pills.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            class={`pill${a.hidden ? ' is-hidden' : ''}`}
            aria-selected={selected?.id === a.id}
            title={`${a.name} · ${a.address}`}
            onClick={() => pick(a.id)}
          >
            {pillLabel(a)}
            {a.primary && (
              <i class="star" title="Default wallet" aria-label="default">
                ★
              </i>
            )}
          </button>
        ))}
        <button
          type="button"
          class="pill add"
          aria-label="New wallet"
          title="New wallet"
          onClick={() => setAddOpen(true)}
        >
          +
        </button>
      </div>

      <div class="card total2">
        <div class="row">
          {selected ? (
            <>
              <span class="wname" title={selected.name}>
                {selected.name}
              </span>
              <button
                type="button"
                class="addr-btn mono"
                onClick={() => void copy(selected.address)}
                title="Copy address"
              >
                {copied ? 'Copied' : shortAddress(selected.address)} <IconCopy size={11} />
              </button>
              <span class="spacer" />
              <button type="button" class="link" onClick={() => onManage(selected.id)}>
                Manage
              </button>
            </>
          ) : (
            <>
              <span class="wname">All wallets</span>
              <span class="spacer" />
              {accounts.some((a) => a.hidden) && (
                <button type="button" class="link" onClick={() => setShowHidden(!showHidden)}>
                  {showHidden
                    ? 'Hide hidden'
                    : `Hidden (${accounts.filter((a) => a.hidden).length})`}
                </button>
              )}
            </>
          )}
        </div>
        <span class="big">{totalUsd !== null ? formatUsd(totalUsd) : loading ? '…' : '–'}</span>
        <span class="muted small">
          {formatCompact(Number(formatEther(nativeTotal)))} {native}
          {visible.length > 0 &&
            ` + ${visible.length} token${visible.length === 1 ? '' : 's'}`} on {chain?.name}
        </span>
        <div class="wallet-acts">
          <button type="button" class="wact" onClick={() => onSend(selected?.id ?? null)}>
            <span class="wact-ico">
              <IconSend size={16} />
            </span>
            Send
          </button>
          <button type="button" class="wact" onClick={() => onReceive(selected?.id ?? null)}>
            <span class="wact-ico">
              <IconReceive size={16} />
            </span>
            Receive
          </button>
          <button
            type="button"
            class="wact"
            title="Send from one of your wallets to the others"
            onClick={() => moveFunds('distribute')}
          >
            <span class="wact-ico">
              <IconFund size={16} />
            </span>
            Fund
          </button>
          <button
            type="button"
            class="wact"
            title="Gather funds from your wallets into one"
            onClick={() => moveFunds('collect')}
          >
            <span class="wact-ico">
              <IconCollect size={16} />
            </span>
            Collect
          </button>
        </div>
      </div>

      <div class="row">
        <span class="section-title">Tokens</span>
        <span class="spacer" />
        <span class="hint">{loading ? 'Updating…' : 'Sorted by value'}</span>
      </div>
      <ul class="toks">
        <li class="tok">
          <div class="tok-main static">
            <TokenAvatar chainId={chainId} token="native" symbol={native} />
            <span class="tname">
              {native}
              <small>Native</small>
            </span>
            <span class="tval">
              {nativeUsd !== null ? formatUsd(nativeUsd) : '–'}
              <small>{formatCompact(Number(formatUnits(nativeTotal, 18)))}</small>
            </span>
          </div>
        </li>
        {visible.map(tokenRow)}
        {showDust && dust.map(tokenRow)}
        {showSpam && spam.map(tokenRow)}
      </ul>
      {spam.length > 0 && (
        <button
          type="button"
          class="dust"
          onClick={() => setShowSpam(!showSpam)}
          aria-expanded={showSpam}
          title="Tokens sent to your wallets that you never bought or added. Often scams."
        >
          <span>
            {spam.length} token{spam.length === 1 ? '' : 's'} you didn't buy{' '}
            {showSpam ? 'shown' : 'hidden'}
          </span>
          <span class="spacer" />
          <span class="showlink">{showSpam ? 'Hide' : 'Show'}</span>
        </button>
      )}
      {dust.length > 0 && (
        <button
          type="button"
          class="dust"
          onClick={() => setShowDust(!showDust)}
          aria-expanded={showDust}
        >
          <span>
            {dust.length} small or unpriced token{dust.length === 1 ? '' : 's'}{' '}
            {showDust ? 'shown' : 'hidden'}
          </span>
          <span class="spacer" />
          <span class="showlink">{showDust ? 'Hide' : 'Show'}</span>
        </button>
      )}

      {adding ? (
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void addToken();
          }}
        >
          <input
            class="input mono"
            aria-label="Token contract address"
            placeholder="0x… token address"
            value={newToken}
            onInput={(e) => setNewToken(e.currentTarget.value)}
          />
          <button type="submit" class="btn btn--sm btn--primary">
            Add
          </button>
        </form>
      ) : (
        <button
          type="button"
          class="link"
          style={{ justifySelf: 'start' }}
          onClick={() => setAdding(true)}
        >
          + Add token
        </button>
      )}

      {msg && (
        <p class="hint" role="status">
          {msg}
        </p>
      )}

      <Sheet title="Add a wallet" open={addOpen} onClose={() => setAddOpen(false)}>
        <div class="sheet-list">
          <button
            type="button"
            class="sheet-row"
            onClick={() => {
              setAddOpen(false);
              void addWallet();
            }}
          >
            <span class="add-ico accent">
              <IconSpark size={18} />
            </span>
            <span class="sheet-text">
              <span>Create new wallet</span>
              <small>Next address from your recovery phrase. Restorable.</small>
            </span>
          </button>
          <button
            type="button"
            class="sheet-row"
            onClick={() => {
              setAddOpen(false);
              onImport();
            }}
          >
            <span class="add-ico">
              <IconKey size={18} />
            </span>
            <span class="sheet-text">
              <span>Import private key</span>
              <small>From MetaMask or another app. Back up the key yourself.</small>
            </span>
          </button>
        </div>
      </Sheet>
    </div>
  );
}
