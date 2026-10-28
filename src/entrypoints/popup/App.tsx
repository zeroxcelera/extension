import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { CHAINS } from '../../shared/chains';
import type { PushEvent } from '../../shared/messages';
import type { WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, PasswordField } from '../../ui/components';
import { Activity } from './Activity';
import { ActivityDetail } from './ActivityDetail';
import { Receive } from './Receive';
import { Send } from './Send';
import { Bridge } from './Bridge';
import { Home } from './Home';
import { IconActivity, IconBack, IconBridge, IconLock, IconSettings, IconWallet } from './icons';
import { ChainMark, Picker } from './Picker';
import { ResetVault } from './ResetVault';
import { Settings } from './Settings';
import { Transfers } from './Transfers';
import { BirdMark } from '../../ui/BirdMark';
import { ImportKey } from './ImportKey';
import { WalletDetail } from './WalletDetail';

type Tab = 'wallets' | 'activity' | 'bridge' | 'settings';
type Sub =
  | { name: 'detail'; id: string }
  | { name: 'import' }
  | { name: 'ticket'; id: string }
  | { name: 'send'; walletId: string | null }
  | { name: 'receive'; walletId: string | null }
  | { name: 'transfers'; mode: 'distribute' | 'collect' }
  | null;
type Gate = 'loading' | 'no-vault' | 'locked' | 'ready';

const CHAIN_KEY = 'celera.popup.chain';
const TAB_KEY = 'celera.popup.tab';

function remembered<T extends string | number>(
  key: string,
  fallback: T,
  valid: (v: string) => boolean,
): T {
  try {
    const v = localStorage.getItem(key);
    if (v !== null && valid(v)) return (typeof fallback === 'number' ? Number(v) : v) as T;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

function remember(key: string, v: string | number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* storage unavailable */
  }
}

const TABS: { id: Tab; label: string; Icon: typeof IconWallet }[] = [
  { id: 'wallets', label: 'Wallets', Icon: IconWallet },
  { id: 'activity', label: 'Activity', Icon: IconActivity },
  { id: 'bridge', label: 'Bridge', Icon: IconBridge },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
];

export function App() {
  const chains = [...CHAINS.values()];
  const [gate, setGate] = useState<Gate>('loading');
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [tab, setTab] = useState<Tab>(() =>
    remembered<Tab>(TAB_KEY, 'wallets', (v) => TABS.some((t) => t.id === v)),
  );
  const [sub, setSub] = useState<Sub>(null);
  const [chainId, setChainId] = useState<number>(() =>
    remembered(CHAIN_KEY, chains[0]?.id ?? 1, (v) => CHAINS.has(Number(v))),
  );
  const [activityChain, setActivityChain] = useState<number | 'all'>('all');
  const [pending, setPending] = useState(0);

  const refresh = useCallback(async () => {
    const status = await send({ type: 'vault.status' });
    if (!status.ok || !status.data.exists) return setGate('no-vault');
    if (!status.data.unlocked) return setGate('locked');
    const list = await send({ type: 'wallets.list' });
    if (!list.ok) return setGate('locked');
    setAccounts(list.data);
    setGate('ready');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pending badge on the Activity tab.
  useEffect(() => {
    if (gate !== 'ready') return;
    const count = () =>
      void send({ type: 'history.list' }).then(
        (r) => r.ok && setPending(r.data.filter((t) => t.status === 'working').length),
      );
    count();
    const onMsg = (m: unknown, sender: { id?: string }) => {
      if (sender.id === browser.runtime.id && (m as PushEvent)?.kind === 'celera.ticket') count();
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => browser.runtime.onMessage.removeListener(onMsg);
  }, [gate]);

  const lock = async () => {
    await send({ type: 'vault.lock' });
    setAccounts([]);
    setSub(null);
    setGate('locked');
  };

  const go = (t: Tab) => {
    setTab(t);
    setSub(null);
    remember(TAB_KEY, t);
  };

  const pickChain = (id: number) => {
    setChainId(id);
    remember(CHAIN_KEY, id);
  };

  const showChainPicker = gate === 'ready' && !sub && (tab === 'wallets' || tab === 'activity');

  return (
    <div class="popup">
      <header class="topbar">
        {sub && (
          <button type="button" class="icon-btn" aria-label="Back" onClick={() => setSub(null)}>
            <IconBack size={18} />
          </button>
        )}
        <h1 class="brand">
          <BirdMark size={20} />
          Celera
        </h1>
        <span class="spacer" />
        {showChainPicker &&
          (tab === 'wallets' ? (
            <Picker
              title="Select chain"
              variant="pill"
              value={chainId}
              onChange={pickChain}
              options={chains.map((c) => ({
                value: c.id,
                label: c.name,
                sub: c.nativeCurrency.symbol,
                mark: <ChainMark chainId={c.id} />,
              }))}
            />
          ) : (
            <Picker<number | 'all'>
              title="Show activity on"
              variant="pill"
              value={activityChain}
              onChange={setActivityChain}
              options={[
                { value: 'all', label: 'All chains', mark: <ChainMark chainId="all" /> },
                ...chains.map((c) => ({
                  value: c.id,
                  label: c.name,
                  mark: <ChainMark chainId={c.id} />,
                })),
              ]}
            />
          ))}
        {gate === 'ready' && (
          <button
            type="button"
            class="icon-btn"
            aria-label="Lock"
            title="Lock"
            onClick={() => void lock()}
          >
            <IconLock size={16} />
          </button>
        )}
      </header>

      <main class="content">
        {gate === 'loading' && <p class="muted">Loading…</p>}
        {gate === 'no-vault' && <NoVault />}
        {gate === 'locked' && <Unlock onUnlocked={() => void refresh()} />}
        {gate === 'ready' && sub?.name === 'detail' && (
          <WalletDetail
            account={accounts.find((a) => a.id === sub.id)}
            onChanged={refresh}
            onRemoved={() => void refresh().then(() => setSub(null))}
          />
        )}
        {gate === 'ready' && sub?.name === 'import' && (
          <ImportKey onDone={() => void refresh().then(() => setSub(null))} />
        )}
        {gate === 'ready' && sub?.name === 'transfers' && (
          <Transfers accounts={accounts} defaultChainId={chainId} initialMode={sub.mode} />
        )}
        {gate === 'ready' && !sub && tab === 'wallets' && (
          <Home
            chainId={chainId}
            accounts={accounts}
            onManage={(id) => setSub({ name: 'detail', id })}
            onImport={() => setSub({ name: 'import' })}
            onTransfers={(mode) => setSub({ name: 'transfers', mode })}
            onSend={(walletId) => setSub({ name: 'send', walletId })}
            onReceive={(walletId) => setSub({ name: 'receive', walletId })}
            onChanged={refresh}
          />
        )}
        {gate === 'ready' && sub?.name === 'ticket' && <ActivityDetail id={sub.id} />}
        {gate === 'ready' && sub?.name === 'send' && (
          <Send
            accounts={accounts}
            defaultChainId={chainId}
            initialWalletId={sub.walletId}
            onSent={(id) => {
              go('activity');
              setSub({ name: 'ticket', id });
            }}
          />
        )}
        {gate === 'ready' && sub?.name === 'receive' && (
          <Receive accounts={accounts} initialWalletId={sub.walletId} />
        )}
        {gate === 'ready' && !sub && tab === 'activity' && (
          <Activity chainFilter={activityChain} onOpen={(id) => setSub({ name: 'ticket', id })} />
        )}
        {gate === 'ready' && !sub && tab === 'bridge' && (
          <Bridge accounts={accounts} defaultChainId={chainId} />
        )}
        {gate === 'ready' && !sub && tab === 'settings' && (
          <Settings onReset={() => setGate('no-vault')} />
        )}
      </main>

      {gate === 'ready' && (
        <nav class="nav" aria-label="Sections">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              class="nav-item"
              aria-current={
                tab === id && (!sub || (sub.name === 'ticket' && id === 'activity'))
                  ? 'page'
                  : undefined
              }
              onClick={() => go(id)}
            >
              <Icon size={20} />
              {label}
              {id === 'activity' && pending > 0 && <span class="badge-dot">{pending}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function openOnboarding() {
  void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
  window.close();
}

function NoVault() {
  return (
    <div class="center">
      <h2>Welcome to Celera</h2>
      <p class="muted">One-click trading from your own wallet, right on the chart.</p>
      <Button variant="primary" block onClick={openOnboarding}>
        Set up wallet
      </Button>
    </div>
  );
}

function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  if (forgot) {
    return (
      <div class="stack" style={{ paddingTop: '24px' }}>
        <ResetVault onReset={onUnlocked} />
        <Button size="sm" variant="ghost" onClick={() => setForgot(false)}>
          Back to unlock
        </Button>
      </div>
    );
  }

  return (
    <form
      class="stack"
      style={{ paddingTop: '24px' }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await send({ type: 'vault.unlock', password });
        setBusy(false);
        setPassword('');
        if (res.ok) onUnlocked();
        else setError(errorText(res));
      }}
    >
      <h2>Unlock</h2>
      <PasswordField
        label="Password"
        value={password}
        onInput={(v) => (setPassword(v), setError(undefined))}
        autoFocus
        error={error}
      />
      <Button variant="primary" type="submit" block disabled={busy || !password}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
      <button type="button" class="link" onClick={() => setForgot(true)}>
        Forgot password?
      </button>
    </form>
  );
}
