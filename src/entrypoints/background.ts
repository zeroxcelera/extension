import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { ClientPool, toViemChain } from '../background/chain/client';
import { handleMessage, type RouterDeps, type SiteControl } from '../background/router';
import { classifySender } from '../background/sender';
import { SettingsStore } from '../background/settings';
import { broadcastRaw } from '../background/trade/broadcast';
import { AggregatorCheck } from '../background/trade/aggregator-check';
import { TradeEngine } from '../background/trade/engine';
import { FeeCache } from '../background/trade/fees';
import { kyberVenue } from '../background/trade/kyber';
import { TaxService } from '../background/trade/tax';
import { launchpadRules, launchpadVenues } from '../background/trade/launchpads';
import { NonceManager } from '../background/trade/nonce';
import { PriceService } from '../background/trade/prices';
import { Routing } from '../background/trade/routing';
import { uniswapVenue } from '../background/trade/uniswap/venue';
import { extraVenues, venueRules } from '../background/trade/venues';
import { Vault, type KeyValueStore } from '../background/vault/vault';
import { HistoryStore } from '../background/history';
import { LogoService } from '../background/logos';
import { PortfolioService } from '../background/portfolio';
import { createRelayClient } from '../background/trade/relay';
import { WsHub } from '../background/ws';
import { CHAINS } from '../shared/chains';
import { getChain, type ChainConfig } from '../shared/chains';
import type { PushEvent } from '../shared/messages';
import type { ChainSettings } from '../shared/settings/defaults';
import { isBuiltinOrigin, siteScriptId } from '../shared/sites';

const AUTOLOCK_ALARM = 'celera.autolock';
const OFFSCREEN_PATH = '/offscreen.html';
const CLIPBOARD_CLEAR_MS = 30_000;
/** Minimum gap between connection keep-alive pings per chain. */
const RPC_WARM_MS = 15_000;
const CONTENT_SCRIPT = '/content-scripts/content.js' as const;

function area(storage: typeof browser.storage.local): KeyValueStore {
  return {
    get: async (key) => (await storage.get(key))[key],
    set: (key, value) => storage.set({ [key]: value }),
    remove: (key) => storage.remove(key),
    getAll: () => storage.get(null),
  };
}

/** KyberSwap aggregator API (fallback routes). Asks for a JSON answer within 6 s. */
const aggregator = {
  get: (url: string) => fetchJson(url, { headers: { 'x-client-id': 'celera' } }),
  post: (url: string, body: unknown) =>
    fetchJson(url, {
      method: 'POST',
      headers: { 'x-client-id': 'celera', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(t);
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export default defineBackground({
  type: 'module',
  main() {
    // Decrypted key material lives in storage.session. Content scripts must never read it.
    void browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    // Nor storage.local: the encrypted vault, RPC URLs (often with API keys) and history.
    // A compromised page renderer could otherwise copy the vault for offline guessing.
    try {
      void browser.storage.local
        .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
        .catch(() => undefined);
    } catch {
      // A browser without access levels for storage.local.
    }

    const local = area(browser.storage.local);
    const vault = new Vault({ local, session: area(browser.storage.session) });
    const settings = new SettingsStore(local);
    const pool = new ClientPool();
    const sendClients = new Map<string, PublicClient>();

    const client = (chain: ChainConfig, cs: ChainSettings) =>
      pool.get(chain, cs.customRpc ? [cs.customRpc] : []);
    /** One client per exact endpoint, for sends that must not fall back elsewhere. */
    const single = (chain: ChainConfig, url: string) => {
      const key = `${chain.id}|${url}`;
      let c = sendClients.get(key);
      if (!c) {
        c = createPublicClient({
          chain: toViemChain(chain),
          transport: http(url, { timeout: 8_000 }),
        });
        sendClients.set(key, c);
      }
      return c;
    };
    /**
     * Where a signed transaction goes: the MEV RPC alone, or (sequencer chains) every
     * endpoint at once since acceptance time varies a lot by provider. Null means a public
     * mempool: keep to the user's RPC order (a custom RPC may be private).
     */
    const sendUrls = (chain: ChainConfig, cs: ChainSettings): string[] | null => {
      if (chain.mev.supported && cs.mevEnabled && cs.mevRpc) return [cs.mevRpc];
      if (chain.mev.supported) return null;
      return [...new Set([...(cs.customRpc ? [cs.customRpc] : []), ...chain.rpcUrls])];
    };
    const broadcast = (chain: ChainConfig, cs: ChainSettings, raw: Hex) => {
      const urls = sendUrls(chain, cs);
      if (!urls) return client(chain, cs).sendRawTransaction({ serializedTransaction: raw });
      return broadcastRaw(
        urls.map((u) => single(chain, u)),
        raw,
      );
    };

    /**
     * Keeps the connections a click will use open (TLS and CORS preflight already done),
     * so the first trade after a pause does not pay for a new handshake.
     */
    const warmedAt = new Map<number, number>();
    const warmRpc = async (chainId: number) => {
      const chain = getChain(chainId);
      if (!chain) return;
      const now = Date.now();
      if (now - (warmedAt.get(chainId) ?? 0) < RPC_WARM_MS) return;
      warmedAt.set(chainId, now);
      const cs = await settings.getChain(chainId);
      const targets = [
        client(chain, cs),
        ...(sendUrls(chain, cs) ?? []).map((u) => single(chain, u)),
      ];
      // eth_blockNumber directly: getBlockNumber() may answer from viem's cache.
      await Promise.allSettled(targets.map((c) => c.request({ method: 'eth_blockNumber' })));
    };

    const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues], [kyberVenue]);
    const prices = new PriceService(routing);
    const tax = new TaxService(routing);
    const aggregatorCheck = new AggregatorCheck(routing, tax);
    const nonces = new NonceManager(async (chainId, address) => {
      const chain = getChain(chainId);
      if (!chain) throw new Error('unsupported_chain');
      const cs = await settings.getChain(chainId);
      return client(chain, cs).getTransactionCount({ address, blockTag: 'pending' });
    });

    /** Tabs whose panel has messaged this worker: broadcasts go there, not to every tab. */
    const panelTabs = new Set<number>();
    browser.tabs.onRemoved.addListener((id) => panelTabs.delete(id));

    const push = async (event: PushEvent, tabId?: number) => {
      // Extension pages (popup) listen too; nobody listening is fine.
      void browser.runtime.sendMessage(event).catch(() => undefined);
      if (tabId !== undefined) {
        await browser.tabs.sendMessage(tabId, event).catch(() => undefined);
        return;
      }
      await Promise.all(
        [...panelTabs].map((id) =>
          // No panel there any more (navigated away): stop sending to it.
          browser.tabs.sendMessage(id, event).catch(() => panelTabs.delete(id)),
        ),
      );
    };

    const history = new HistoryStore(local);
    const portfolio = new PortfolioService(local, routing, prices);
    const logos = new LogoService(local);
    // Seed the token list from past trades (tokens bought before portfolio existed). They
    // are the user's own choices, so this also marks them trusted (shown).
    void history.list().then(async (list) => {
      const byChain = new Map<number, Address[]>();
      for (const t of list) {
        if (t.token && (t.kind === 'buy' || t.kind === 'sell')) {
          byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t.token]);
        }
      }
      for (const [chainId, tokens] of byChain) await portfolio.addTokens(chainId, tokens);
    });
    const fees = new FeeCache();

    // New blocks over WebSocket (optional, per chain): fresh base fee, faster
    // confirmations, and a nudge for open panels to refresh quotes (≤ 1/s per chain).
    const lastBlockPush = new Map<number, number>();
    const ws = new WsHub((chainId, baseFee) => {
      if (baseFee !== null) fees.setBaseFee(chainId, baseFee, Date.now());
      const now = Date.now();
      if (now - (lastBlockPush.get(chainId) ?? 0) >= 1_000) {
        lastBlockPush.set(chainId, now);
        void push({ kind: 'celera.block', chainId });
      }
    });
    const syncWs = async (chainId: number) => {
      const chain = getChain(chainId);
      if (chain) ws.ensure(chain, (await settings.getChain(chainId)).wsRpc);
    };
    for (const c of CHAINS.values()) void syncWs(c.id);

    const engine = new TradeEngine({
      vault,
      settings,
      routing,
      tax,
      aggregatorCheck,
      fees,
      nonces,
      prices,
      client,
      broadcast,
      fetchJson,
      aggregator,
      extraContracts: (chainId) => new Map([...venueRules(chainId), ...launchpadRules(chainId)]),
      notify: (ticket, tabId) => {
        // Save first so views that re-read history on this event see the new state.
        const saved = history.upsert(ticket);
        if (ticket.token && (ticket.kind === 'buy' || ticket.kind === 'sell')) {
          void portfolio.addTokens(ticket.chainId, [ticket.token]);
        }
        // Pushed even when saving failed: the panel must still see the trade's progress.
        const send = () => push({ kind: 'celera.ticket', ticket }, tabId);
        void saved.then(send, send);
      },
      relay: createRelayClient(),
      nextBlock: (chainId, timeoutMs) => ws.nextBlock(chainId, timeoutMs),
      now: Date.now,
    });

    // Runtime-enabled sites (on top of the built-in list).
    let enabled = new Set<string>();
    const loadSites = async () => {
      enabled = new Set(await settings.enabledSites());
    };
    /** Senders are classified only once this has run (see the message listener). */
    const sitesLoaded = loadSites().catch(() => undefined);
    const isAllowedOrigin = (origin: string) => isBuiltinOrigin(origin) || enabled.has(origin);

    /**
     * Exactly one registered script per runtime-enabled site that still has its host
     * permission: ids from older versions, or of sites since disabled, are removed.
     */
    const syncSiteScripts = async () => {
      const want = new Map<string, string>();
      for (const origin of enabled) {
        if (await browser.permissions.contains({ origins: [`${origin}/*`] }))
          want.set(siteScriptId(origin), origin);
      }
      const have = await browser.scripting.getRegisteredContentScripts();
      const stale = have
        .filter((s) => s.id.startsWith('site-') && !want.has(s.id))
        .map((s) => s.id);
      if (stale.length) await browser.scripting.unregisterContentScripts({ ids: stale });
      const missing = [...want].filter(([id]) => !have.some((s) => s.id === id));
      if (missing.length)
        await browser.scripting.registerContentScripts(
          missing.map(([id, origin]) => ({
            id,
            matches: [`${origin}/*`],
            js: [CONTENT_SCRIPT],
            runAt: 'document_idle' as const,
            allFrames: false,
          })),
        );
    };
    void sitesLoaded.then(syncSiteScripts).catch(() => undefined);

    const sites: SiteControl = {
      async status(origin) {
        return { builtin: isBuiltinOrigin(origin), enabled: isAllowedOrigin(origin) };
      },
      async enable(origin, tabId) {
        if (isBuiltinOrigin(origin)) return { builtin: true, enabled: true };
        // The popup asked for the permission (user gesture); we only proceed if it was granted.
        const granted = await browser.permissions.contains({ origins: [`${origin}/*`] });
        if (!granted) throw Object.assign(new Error('permission_denied'));
        const id = siteScriptId(origin);
        const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
        if (existing.length === 0) {
          await browser.scripting.registerContentScripts([
            {
              id,
              matches: [`${origin}/*`],
              js: [CONTENT_SCRIPT],
              runAt: 'document_idle',
              allFrames: false,
            },
          ]);
        }
        await settings.setEnabledSites([...enabled, origin]);
        await loadSites();
        await browser.scripting
          .executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] })
          .catch(() => undefined);
        return { builtin: false, enabled: true };
      },
      async disable(origin) {
        if (isBuiltinOrigin(origin)) return { builtin: true, enabled: true };
        await browser.scripting
          .unregisterContentScripts({ ids: [siteScriptId(origin)] })
          .catch(() => undefined);
        await browser.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
        await settings.setEnabledSites([...enabled].filter((o) => o !== origin));
        await loadSites();
        return { builtin: false, enabled: false };
      },
    };

    const deps: RouterDeps = {
      history,
      portfolio,
      logos,
      wsStatus: (chainId) => ws.status(chainId),
      warmRpc,
      onChainSettings: (chainId) => void syncWs(chainId),
      vault,
      settings,
      engine,
      routing,
      tax,
      aggregatorCheck,
      prices,
      sites,
      client,
      fetchJson,
      aggregator,
      version: browser.runtime.getManifest().version,
      now: Date.now,
      async onActivity() {
        const { autoLockMinutes } = await settings.get();
        await browser.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: autoLockMinutes });
      },
      async onLockChanged(unlocked) {
        if (unlocked) await deps.onActivity();
        else await browser.alarms.clear(AUTOLOCK_ALARM);
        await push({ kind: 'celera.vault', unlocked });
      },
      async scheduleClipboardClear() {
        await closeOffscreen();
        await browser.offscreen.createDocument({
          url: `${OFFSCREEN_PATH}?clearAfter=${CLIPBOARD_CLEAR_MS}`,
          reasons: ['CLIPBOARD'],
          justification: 'Clear an exported private key from the clipboard after 30 seconds.',
        });
      },
      closeOffscreen,
    };

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === AUTOLOCK_ALARM)
        void vault.lock().then(() => push({ kind: 'celera.vault', unlocked: false }));
    });

    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === 'install')
        void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    });

    browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      // A message from a panel may be what wakes the worker: wait for the runtime-enabled
      // sites to load, or a panel on such a site would be turned away on that first click.
      void sitesLoaded.then(() => {
        const kind = classifySender(sender, browser.runtime.id, isAllowedOrigin);
        if (!kind) return sendResponse(undefined);
        if (kind === 'content-script' && sender.tab?.id !== undefined) panelTabs.add(sender.tab.id);
        const meta = { kind, tabId: sender.tab?.id, origin: sender.origin ?? originOf(sender.url) };
        void handleMessage(raw, meta, deps).then(sendResponse);
      });
      return true;
    });
  },
});

async function closeOffscreen(): Promise<void> {
  if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument();
}
