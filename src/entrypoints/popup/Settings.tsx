import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { CHAINS } from '../../shared/chains';
import { parseDecimalInput } from '../../shared/format';
import type { SiteStatus, WsStatusView } from '../../shared/messages';
import type { ChainSettings, GlobalSettings } from '../../shared/settings/defaults';
import { errorText, send } from '../../ui/api';
import { Button, Checkbox, Notice, TextField } from '../../ui/components';
import { ChainMark, Picker } from './Picker';
import { ResetVault } from './ResetVault';

type Tab = 'general' | 'chains' | 'sites';
const AUTOLOCK_OPTIONS = [5, 15, 30, 60, 240];

/** Shows "Saved" briefly after each auto-save. */
function useSaved(): [string | null, (ok: boolean, err?: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>();
  return [
    msg,
    (ok, err) => {
      setMsg(ok ? 'Saved' : (err ?? 'Not saved'));
      clearTimeout(t.current);
      t.current = setTimeout(() => setMsg(null), 1500);
    },
  ];
}

/** Numeric text field that saves on blur when the value is valid. */
function NumberSetting(props: {
  label: string;
  value: number | string;
  hint?: string;
  decimals?: boolean;
  /** true when saved, else the reason to show. */
  onSave: (v: string) => Promise<true | string>;
}) {
  const [v, setV] = useState(String(props.value));
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => setV(String(props.value)), [props.value]);
  return (
    <div
      onFocusOut={async () => {
        const parsed = parseDecimalInput(v);
        if (parsed === null || (!props.decimals && parsed.includes('.'))) {
          setErr('Enter a valid number');
          return;
        }
        setErr(undefined);
        if (parsed === String(props.value)) return;
        const saved = await props.onSave(parsed);
        if (saved !== true) setErr(saved);
      }}
    >
      <TextField label={props.label} value={v} onInput={setV} hint={props.hint} error={err} />
    </div>
  );
}

export function Settings({ onReset }: { onReset: () => void }) {
  const [tab, setTab] = useState<Tab>('general');
  return (
    <div class="stack">
      <div class="seg-tabs" role="tablist" aria-label="Settings sections">
        {(['general', 'chains', 'sites'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t === 'general' ? 'General' : t === 'chains' ? 'Chains' : 'Sites'}
          </button>
        ))}
      </div>
      {tab === 'general' && <General onReset={onReset} />}
      {tab === 'chains' && <Chains />}
      {tab === 'sites' && <Sites />}
    </div>
  );
}

function General({ onReset }: { onReset: () => void }) {
  const [s, setS] = useState<GlobalSettings | null>(null);
  const [saved, flash] = useSaved();
  const [walletCount, setWalletCount] = useState<number | null>(null);
  const [repaired, setRepaired] = useState<string[]>([]);

  useEffect(() => {
    void send({ type: 'settings.get' }).then((r) => r.ok && setS(r.data));
    void send({ type: 'settings.repairs' }).then((r) => r.ok && setRepaired(r.data));
    void send({ type: 'wallets.list' }).then((r) => r.ok && setWalletCount(r.data.length));
  }, []);
  if (!s) return <p class="muted">Loading…</p>;

  const update = async (patch: Partial<GlobalSettings>): Promise<true | string> => {
    const r = await send({ type: 'settings.update', patch });
    if (r.ok) setS(r.data);
    flash(r.ok, r.ok ? undefined : errorText(r));
    return r.ok ? true : (r.detail ?? errorText(r));
  };

  return (
    <div class="stack">
      {repaired.length > 0 && (
        <Notice tone="warn">
          Some saved settings were invalid and were reset to their defaults: {repaired.join(', ')}.
          Check them below.
        </Notice>
      )}
      <div class="row">
        <span class="section-title">Safety limits</span>
        <span class="spacer" />
        {saved && (
          <span class="hint" role="status">
            {saved}
          </span>
        )}
      </div>
      <NumberSetting
        label="Max per transaction (USD)"
        value={s.maxUsdPerTx}
        decimals
        onSave={(v) => update({ maxUsdPerTx: Number(v) })}
      />
      <NumberSetting
        label="Max per click, all wallets (USD)"
        value={s.maxUsdPerClick}
        decimals
        onSave={(v) => update({ maxUsdPerClick: Number(v) })}
      />
      <NumberSetting
        label="Ask to confirm above (USD)"
        value={s.confirmAboveUsd}
        decimals
        hint="One-click trades above this ask first. Sells only use this threshold."
        onSave={(v) => update({ confirmAboveUsd: Number(v) })}
      />
      <NumberSetting
        label="Max gas fee per transaction (USD)"
        value={s.maxGasUsd}
        decimals
        hint="Nothing is signed when the expected network fee is higher (e.g. a mistyped priority fee)."
        onSave={(v) => update({ maxGasUsd: Number(v) })}
      />
      <Checkbox
        checked={s.simulateBeforeSign}
        onChange={(v) => void update({ simulateBeforeSign: v })}
      >
        Simulate before signing (safer, ~0.2 s slower)
      </Checkbox>

      <span class="section-title">Trading</span>
      <div class="field">
        <label for="mwmode">Multi-wallet amount</label>
        <Picker<'each' | 'split'>
          id="mwmode"
          title="Multi-wallet amount"
          value={s.multiWalletMode}
          onChange={(v) => void update({ multiWalletMode: v })}
          options={[
            {
              value: 'each',
              label: 'Same amount per wallet',
              sub: '0.01 with 3 wallets buys 0.01 in each (0.03 total)',
            },
            {
              value: 'split',
              label: 'Split the total across wallets',
              sub: '0.01 with 3 wallets buys about 0.0033 in each',
            },
          ]}
        />
      </div>
      <NumberSetting
        label="Random delay between wallets (ms, 0–300)"
        value={s.jitterMaxMs}
        onSave={(v) => update({ jitterMaxMs: Number(v) })}
      />
      <Checkbox
        checked={s.unlimitedApprovals}
        onChange={(v) => void update({ unlimitedApprovals: v })}
      >
        Approve each token once (unlimited)
      </Checkbox>
      <p class="hint">
        {s.unlimitedApprovals
          ? 'Faster: one approval per token, sent right after the first buy, and sells never wait for one. If the DEX or launchpad contract were ever exploited, every unit of that token in the wallet could be taken. Only known routers and launchpads can be approved.'
          : 'Each approval covers your holdings plus the margin below, topped up after every buy. Approvals you already granted as unlimited stay until revoked.'}
      </p>
      {!s.unlimitedApprovals && (
        <NumberSetting
          label="Approval headroom (%)"
          value={s.approvalBufferBps / 100}
          hint="Approvals cover your holdings plus this margin."
          decimals
          onSave={(v) => update({ approvalBufferBps: Math.round(Number(v) * 100) })}
        />
      )}
      <NumberSetting
        label="Price impact warning (%)"
        value={s.priceImpactWarnBps / 100}
        decimals
        onSave={(v) => update({ priceImpactWarnBps: Math.round(Number(v) * 100) })}
      />
      <NumberSetting
        label="Price impact danger (%)"
        value={s.priceImpactDangerBps / 100}
        decimals
        onSave={(v) => update({ priceImpactDangerBps: Math.round(Number(v) * 100) })}
      />
      <Checkbox checked={s.usePoolIndex} onChange={(v) => void update({ usePoolIndex: v })}>
        Use DEX Screener as a pool index (results are verified on-chain)
      </Checkbox>
      <Checkbox checked={s.useAggregator} onChange={(v) => void update({ useAggregator: v })}>
        Use KyberSwap when no listed pool trades a token (shares the token and amount with
        KyberSwap; its swaps are checked and simulated before signing)
      </Checkbox>
      <Checkbox checked={s.showTokenLogos} onChange={(v) => void update({ showTokenLogos: v })}>
        Show token logos (loaded from DEX Screener's image CDN, which then sees which tokens you
        hold)
      </Checkbox>

      <span class="section-title">Keyboard</span>
      <Checkbox checked={s.hotkeysEnabled} onChange={(v) => void update({ hotkeysEnabled: v })}>
        Hotkeys: 1–4 buy, Q W E R sell (ignored while typing)
      </Checkbox>

      <span class="section-title">Security</span>
      <div class="field">
        <label for="autolock">Auto-lock after inactivity</label>
        <Picker
          id="autolock"
          title="Auto-lock after inactivity"
          value={s.autoLockMinutes}
          onChange={(v) => void update({ autoLockMinutes: v })}
          options={AUTOLOCK_OPTIONS.map((m) => ({
            value: m,
            label: m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`,
          }))}
        />
        <span class="hint">Celera also locks when the browser closes.</span>
      </div>

      <ResetVault onReset={onReset} walletCount={walletCount} />
    </div>
  );
}

function Chains() {
  const chains = [...CHAINS.values()];
  const [chainId, setChainId] = useState(chains[0]?.id ?? 1);
  const [s, setS] = useState<ChainSettings | null>(null);
  const [saved, flash] = useSaved();
  const chain = chains.find((c) => c.id === chainId);

  useEffect(() => {
    setS(null);
    void send({ type: 'settings.getChain', chainId }).then((r) => r.ok && setS(r.data));
  }, [chainId]);

  const update = async (patch: Partial<ChainSettings>): Promise<true | string> => {
    const r = await send({ type: 'settings.updateChain', chainId, patch });
    if (r.ok) setS(r.data);
    flash(r.ok, r.ok ? undefined : errorText(r));
    return r.ok ? true : (r.detail ?? errorText(r));
  };

  return (
    <div class="stack">
      <div class="row">
        <Picker
          title="Chain settings for"
          value={chainId}
          onChange={setChainId}
          options={chains.map((c) => ({
            value: c.id,
            label: c.name,
            mark: <ChainMark chainId={c.id} />,
          }))}
        />
        {saved && (
          <span class="hint" role="status">
            {saved}
          </span>
        )}
      </div>
      {!s || !chain ? (
        <p class="muted">Loading…</p>
      ) : (
        <>
          <span class="section-title">Quick buy amounts ({chain.nativeCurrency.symbol})</span>
          <div class="grid2">
            {s.quickBuyAmounts.map((a, i) => (
              <NumberSetting
                key={`${chainId}-${i}`}
                label={`Button ${i + 1}`}
                value={a}
                decimals
                onSave={(v) => {
                  const next = [...s.quickBuyAmounts];
                  next[i] = v;
                  return update({ quickBuyAmounts: next });
                }}
              />
            ))}
          </div>

          <span class="section-title">Trading</span>
          <NumberSetting
            key={`slip-${chainId}`}
            label="Slippage (%)"
            value={s.slippageBps / 100}
            decimals
            hint="Also selectable in the panel (10 / 20 / 40 % or custom)."
            onSave={(v) => update({ slippageBps: Math.round(Number(v) * 100) })}
          />
          {chain.feeModel === 'arbitrum' ? (
            <p class="hint">
              Priority fee has no effect on this chain (first-come-first-served sequencer).
            </p>
          ) : (
            <div class="grid2">
              {(['low', 'medium', 'high'] as const).map((lvl) => (
                <NumberSetting
                  key={`${chainId}-${lvl}`}
                  label={`${lvl[0]?.toUpperCase()}${lvl.slice(1)} priority (gwei)`}
                  value={s.priorityGwei[lvl]}
                  decimals
                  onSave={(v) => update({ priorityGwei: { ...s.priorityGwei, [lvl]: v } })}
                />
              ))}
            </div>
          )}
          <NumberSetting
            key={`mult-${chainId}`}
            label="Max fee multiplier (× base fee)"
            value={s.maxFeeMultiplier}
            decimals
            hint="Headroom for base-fee spikes; you only pay the actual fee."
            onSave={(v) => update({ maxFeeMultiplier: Number(v) })}
          />

          <span class="section-title">Network</span>
          <RpcSetting
            key={`rpc-${chainId}`}
            label="Custom RPC (optional, https)"
            value={s.customRpc}
            hint={`Tried before the public RPC (${new URL(chain.rpcUrls[0] ?? 'https://x').host}).`}
            onSave={(v) => update({ customRpc: v })}
          />
          {s.customRpc && <RpcAccess key={`access-${s.customRpc}`} url={s.customRpc} />}
          <RpcSetting
            key={`ws-${chainId}`}
            label="WebSocket RPC (optional, wss)"
            value={s.wsRpc}
            scheme="wss"
            hint="Streams new blocks: instant confirmations and per-block quote / fee refresh. HTTPS still handles quotes and sending, and takes over if the socket drops."
            onSave={(v) => update({ wsRpc: v })}
          />
          {s.wsRpc && <WsStatusLine chainId={chainId} />}

          <span class="section-title">MEV protection</span>
          {chain.mev.supported ? (
            <>
              <Checkbox checked={s.mevEnabled} onChange={(v) => void update({ mevEnabled: v })}>
                Send transactions through a private RPC
              </Checkbox>
              <RpcSetting
                key={`mev-${chainId}`}
                label="Private RPC URL"
                value={s.mevRpc}
                hint={
                  chain.id === 1
                    ? 'Default: Flashbots Protect. Empty uses the default.'
                    : 'Default: PancakeSwap MEV Guard. Others: 48 Club, BlockRazor, bloXroute… Empty uses the default.'
                }
                onSave={(v) => update({ mevRpc: v })}
              />
              {s.mevEnabled && !s.mevRpc && (
                <Notice tone="warn">
                  MEV protection is on but no private RPC is set, so transactions use the public
                  RPC.
                </Notice>
              )}
            </>
          ) : (
            <Notice>{chain.mev.reason} MEV protection is not needed here.</Notice>
          )}
        </>
      )}
    </div>
  );
}

function WsStatusLine({ chainId }: { chainId: number }) {
  const [st, setSt] = useState<WsStatusView | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      void send({ type: 'ws.status', chainId }).then((r) => alive && r.ok && setSt(r.data));
    poll();
    const id = setInterval(poll, 2_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [chainId]);
  if (!st) return null;
  const text =
    st.state === 'connected'
      ? 'Connected · new blocks streaming'
      : st.state === 'connecting'
        ? 'Connecting…'
        : st.state === 'error'
          ? 'Connection error — using HTTPS polling'
          : 'Off';
  return (
    <span class={`ws-status ws-${st.state}`} role="status">
      <span class="ws-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function RpcSetting(props: {
  label: string;
  value: string;
  hint: string;
  scheme?: 'https' | 'wss';
  onSave: (v: string) => Promise<true | string>;
}) {
  const scheme = props.scheme ?? 'https';
  const [v, setV] = useState(props.value);
  const [err, setErr] = useState<string | undefined>();
  return (
    <div
      onFocusOut={async () => {
        const t = v.trim();
        if (t === props.value) return;
        if (t && !new RegExp(`^${scheme}://[^\\s]+$`).test(t)) {
          setErr(`Must start with ${scheme}://`);
          return;
        }
        setErr(undefined);
        if ((await props.onSave(t)) !== true) setErr('Invalid URL');
      }}
    >
      <TextField label={props.label} value={v} onInput={setV} hint={props.hint} error={err} mono />
    </div>
  );
}

/**
 * Without host access Chrome sends a CORS preflight before the first request on each
 * new connection (and again when its cache expires): a whole extra round trip.
 */
function RpcAccess({ url }: { url: string }) {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })();
  const [granted, setGranted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!origin) return;
    void browser.permissions.contains({ origins: [`${origin}/*`] }).then(setGranted);
  }, [origin]);

  if (!origin || granted === null) return null;
  if (granted) return <p class="hint">Direct connection allowed.</p>;
  return (
    <div class="stack">
      <p class="hint">
        Allow direct access to skip the extra check Chrome makes on each new connection to this RPC.
        That saves one round trip on the first trade after a pause.
      </p>
      <Button
        onClick={async () => {
          // Must run in the click handler (user gesture) for Chrome to show the prompt.
          setGranted(await browser.permissions.request({ origins: [`${origin}/*`] }));
        }}
      >
        Allow direct access
      </Button>
    </div>
  );
}

function Sites() {
  const [tab, setTab] = useState<{ id: number; origin: string } | null>(null);
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(async ([t]) => {
      if (!t?.id || !t.url) return;
      let origin: string;
      try {
        const u = new URL(t.url);
        if (u.protocol !== 'https:') return;
        origin = u.origin;
      } catch {
        return;
      }
      setTab({ id: t.id, origin });
      const r = await send({ type: 'sites.status', origin });
      if (r.ok) setStatus(r.data);
    });
  }, []);

  const enable = async () => {
    if (!tab) return;
    setError(null);
    // Must run in the click handler (user gesture) for Chrome to show the prompt.
    const granted = await browser.permissions.request({ origins: [`${tab.origin}/*`] });
    if (!granted) {
      setError('Permission was not granted.');
      return;
    }
    const r = await send({ type: 'sites.enable', origin: tab.origin, tabId: tab.id });
    if (r.ok) setStatus(r.data);
    else setError(errorText(r));
  };

  const disable = async () => {
    if (!tab) return;
    const r = await send({ type: 'sites.disable', origin: tab.origin });
    if (r.ok) setStatus(r.data);
    else setError(errorText(r));
  };

  return (
    <div class="stack">
      <p class="muted">
        Celera runs on GMGN, DEX Screener, DEXTools, GeckoTerminal, Birdeye, Axiom, BasedBot,
        four.meme and Flap out of the box. You can enable it on any other trading site here; the
        token is read from the page URL.
      </p>
      {!tab ? (
        <Notice>Open a trading site in this tab, then come back here.</Notice>
      ) : (
        <div class="card" style={{ padding: '12px', display: 'grid', gap: '8px' }}>
          <span class="mono" style={{ wordBreak: 'break-all' }}>
            {tab.origin}
          </span>
          {status?.builtin ? (
            <span class="hint">Built-in site — always enabled.</span>
          ) : status?.enabled ? (
            <Button size="sm" onClick={() => void disable()} style={{ justifySelf: 'start' }}>
              Disable on this site
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void enable()}
              style={{ justifySelf: 'start' }}
            >
              Enable on this site
            </Button>
          )}
        </div>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
