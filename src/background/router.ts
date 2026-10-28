import type { PublicClient } from 'viem';
import { CHAINS, getChain, type ChainConfig } from '../shared/chains';
import type { Detection } from '../shared/detection';
import {
  CONTENT_TYPES,
  FRAME_TYPES,
  RequestSchema,
  type ErrorCode,
  type Request,
  type RequestType,
  type ResponseMap,
  type Result,
} from '../shared/messages';
import type { ChainSettings } from '../shared/settings/defaults';
import { readBalances } from './balances';
import type { HistoryStore } from './history';
import type { LogoService } from './logos';
import { panelQuotes, panelState } from './panel';
import type { PortfolioService } from './portfolio';
import type { WsStatus } from './ws';
import { resolveTarget } from './resolve';
import type { SenderKind } from './sender';
import { SettingsError, type SettingsStore } from './settings';
import type { AggregatorCheck } from './trade/aggregator-check';
import { TradeError, chainContext, type TradeEngine } from './trade/engine';
import type { PriceService } from './trade/prices';
import type { Routing } from './trade/routing';
import type { TaxService } from './trade/tax';
import type { VenueCtx } from './trade/types';
import { poolKeyFromId } from './trade/uniswap/venue';
import { VaultError, type Vault } from './vault/vault';

export interface SiteControl {
  status(origin: string): Promise<{ builtin: boolean; enabled: boolean }>;
  enable(origin: string, tabId: number): Promise<{ builtin: boolean; enabled: boolean }>;
  disable(origin: string): Promise<{ builtin: boolean; enabled: boolean }>;
}

export interface RouterDeps {
  history: HistoryStore;
  portfolio: PortfolioService;
  logos: LogoService;
  wsStatus: (chainId: number) => WsStatus;
  /** Pings the chain's RPC endpoints so their connections stay open (throttled). */
  warmRpc: (chainId: number) => Promise<void>;
  /** Called after a chain's settings change (e.g. to (re)connect its WebSocket). */
  onChainSettings: (chainId: number) => void;
  vault: Vault;
  settings: SettingsStore;
  engine: TradeEngine;
  routing: Routing;
  tax: TaxService;
  aggregatorCheck?: Pick<AggregatorCheck, 'trusted'>;
  prices: PriceService;
  sites: SiteControl;
  client: (chain: ChainConfig, cs: ChainSettings) => PublicClient;
  fetchJson: (url: string) => Promise<unknown>;
  aggregator?: VenueCtx['aggregator'];
  version: string;
  now: () => number;
  /** Called after unlock and after any user-initiated action: restarts the auto-lock timer. */
  onActivity: () => Promise<void>;
  onLockChanged: (unlocked: boolean) => Promise<void>;
  scheduleClipboardClear: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
}

export interface MessageMeta {
  kind: SenderKind;
  tabId?: number | undefined;
  /** The sender's origin (for a content script: the trading site's). */
  origin?: string | undefined;
}

/** Read-only or background-housekeeping requests that do not count as user activity. */
const PASSIVE: ReadonlySet<RequestType> = new Set<RequestType>([
  'ping',
  'vault.status',
  'vault.lock',
  'vault.reset',
  'settings.get',
  'settings.repairs',
  'settings.getChain',
  'offscreen.done',
  'clipboard.scheduleClear',
  'panel.resolve',
  'panel.state',
  'panel.quotes',
  'panel.getPrefs',
  'panel.setPrefs',
  'rpc.warm',
  'sites.status',
  'wallets.balances',
  'history.list',
  'send.prepare',
  'send.checkRecipient',
  'portfolio.get',
  'logo.get',
  'bridge.quote',
  'ws.status',
]);

export function isAllowed(kind: SenderKind, type: RequestType): boolean {
  if (kind === 'extension-page') return true;
  if (kind === 'extension-frame') return FRAME_TYPES.has(type);
  return CONTENT_TYPES.has(type);
}

export async function handleMessage(
  raw: unknown,
  meta: MessageMeta,
  deps: RouterDeps,
): Promise<Result<unknown>> {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return fail('invalid_request');
  const req = parsed.data;
  if (!isAllowed(meta.kind, req.type)) return fail('forbidden');

  try {
    const data = await dispatch(req, meta, deps);
    if (!PASSIVE.has(req.type) && (await deps.vault.isUnlocked())) await deps.onActivity();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof VaultError) {
      return err.retryAfterMs !== undefined
        ? { ok: false, error: err.code, retryAfterMs: err.retryAfterMs }
        : fail(err.code);
    }
    if (err instanceof TradeError) {
      return err.detail ? { ok: false, error: err.code, detail: err.detail } : fail(err.code);
    }
    if (err instanceof SettingsError)
      return { ok: false, error: 'invalid_settings', detail: err.message };
    if (err instanceof Error && err.message === 'unsupported_chain')
      return fail('unsupported_chain');
    if (err instanceof Error && err.message === 'permission_denied')
      return fail('permission_denied');
    // Deliberately no logging: errors here may be derived from wallet state.
    return fail('internal');
  }
}

async function dispatch(
  req: Request,
  meta: MessageMeta,
  d: RouterDeps,
): Promise<ResponseMap[RequestType]> {
  switch (req.type) {
    case 'ping':
      return { version: d.version, locked: !(await d.vault.isUnlocked()) };
    case 'vault.status':
      return { exists: await d.vault.exists(), unlocked: await d.vault.isUnlocked() };
    case 'vault.create': {
      const r = await d.vault.create(req.mnemonic, req.password);
      await d.onLockChanged(true);
      return r;
    }
    case 'vault.unlock': {
      const r = await d.vault.unlock(req.password);
      await d.onLockChanged(true);
      return r;
    }
    case 'vault.lock':
      await d.vault.lock();
      await d.onLockChanged(false);
      return null;
    case 'vault.reset':
      await d.vault.reset();
      await d.onLockChanged(false);
      return null;
    case 'wallets.list':
      return d.vault.listAccounts();
    case 'wallets.add':
      return d.vault.addDerived(req.name);
    case 'wallets.importKey':
      return d.vault.importPrivateKey(req.privateKey, req.name);
    case 'wallets.rename':
      await d.vault.rename(req.id, req.name);
      return null;
    case 'wallets.setHidden':
      await d.vault.setHidden(req.id, req.hidden);
      return null;
    case 'wallets.setPrimary':
      await d.vault.setPrimary(req.id);
      return null;
    case 'wallets.remove':
      await d.vault.remove(req.id);
      return null;
    case 'wallets.exportKey':
      return { privateKey: await d.vault.exportPrivateKey(req.id, req.password) };
    case 'wallets.balances': {
      const { ctx } = await chainContext(d, req.chainId);
      const accounts = await d.vault.listAccounts();
      const b = await readBalances(
        ctx.client,
        null,
        accounts.map((a) => a.address),
      );
      return accounts.map((a, i) => ({ id: a.id, native: (b[i]?.native ?? 0n).toString() }));
    }
    case 'wallets.distribute':
      return d.engine.distribute(req);
    case 'wallets.collect':
      return d.engine.collect(req);
    case 'send.prepare':
      return d.engine.sendPrep(req);
    case 'send.checkRecipient':
      return d.engine.checkRecipient(req, await d.history.list());
    case 'send.execute':
      return d.engine.send(req);
    case 'clipboard.scheduleClear':
      await d.scheduleClipboardClear();
      return null;
    case 'offscreen.done':
      await d.closeOffscreen();
      return null;
    case 'settings.get':
      return d.settings.get();
    case 'settings.repairs':
      return d.settings.repairs();
    case 'settings.update':
      return d.settings.update(stripUndefined(req.patch));
    case 'settings.getChain':
      return d.settings.getChain(req.chainId);
    case 'settings.updateChain': {
      const next = await d.settings.updateChain(req.chainId, stripUndefined(req.patch));
      d.onChainSettings(req.chainId);
      return next;
    }
    case 'history.list':
      return d.history.list();
    case 'portfolio.get': {
      const { ctx } = await chainContext(d, req.chainId);
      const accounts = await d.vault.listAccounts();
      const wallets = accounts.filter((a) => req.walletIds.includes(a.id));
      // Valuing holdings must not send every held token to the aggregator.
      return d.portfolio.get({ ...ctx, aggregator: undefined }, wallets);
    }
    case 'portfolio.addToken':
      await d.portfolio.addTokens(req.chainId, [req.token]);
      return null;
    case 'portfolio.setTrusted':
      await d.portfolio.setTrusted(req.chainId, req.token, req.trusted);
      return null;
    case 'logo.get': {
      if (!(await d.settings.get()).showTokenLogos) return null;
      const chain = getChain(req.chainId);
      return chain ? d.logos.get(chain, req.token) : null;
    }
    case 'bridge.quote':
      return d.engine.bridgeQuote(req);
    case 'bridge.execute':
      return d.engine.bridge(req);
    case 'ws.status':
      return d.wsStatus(req.chainId);
    case 'sites.status':
      return d.sites.status(req.origin);
    case 'sites.enable':
      return d.sites.enable(req.origin, req.tabId);
    case 'sites.disable':
      return d.sites.disable(req.origin);
    case 'panel.resolve': {
      const gs = await d.settings.get();
      const detection = stripUndefined(req.detection) as Detection;
      // Per-chain settings up front so the user's custom RPCs are used here too.
      const chainSettings = new Map(
        await Promise.all(
          [...CHAINS.values()].map(async (c) => [c.id, await d.settings.getChain(c.id)] as const),
        ),
      );
      const clientFor = (chain: ChainConfig) =>
        d.client(chain, chainSettings.get(chain.id) as ChainSettings);
      return resolveTarget(detection, {
        client: clientFor,
        ...(gs.usePoolIndex ? { fetchJson: d.fetchJson } : {}),
        poolIdResolvers: [
          async (chain, poolId) => {
            const key = await poolKeyFromId(
              { chain, client: clientFor(chain), now: d.now },
              poolId,
            );
            if (!key) return null;
            const native = chain.wrappedNative.toLowerCase();
            const c0 = key.currency0.toLowerCase();
            // The traded token is the side that is not native/wrapped native.
            return c0 === '0x0000000000000000000000000000000000000000' || c0 === native
              ? key.currency1
              : key.currency0;
          },
        ],
      });
    }
    case 'panel.state':
      return panelState(d, req.chainId, req.token);
    case 'panel.quotes':
      return panelQuotes(d, req);
    case 'rpc.warm':
      await d.warmRpc(req.chainId);
      return null;
    case 'panel.selectWallets': {
      const accounts = await d.vault.listAccounts();
      const ids = req.walletIds.filter((id) => accounts.some((a) => a.id === id));
      await d.settings.update({ selectedWalletIds: ids });
      return null;
    }
    case 'panel.setTrade':
      await d.settings.updateChain(req.chainId, stripUndefined(req.patch));
      return null;
    case 'panel.getPrefs':
      return d.settings.panelPrefs(meta.origin);
    case 'panel.setPrefs':
      await d.settings.setPanelPrefs(meta.origin, req.prefs);
      return null;
    case 'trade.buy':
      return d.engine.buy(req, meta.tabId);
    case 'trade.sell':
      return d.engine.sell(req, meta.tabId);
    case 'trade.speedUp':
      return d.engine.replace(req.ticketId, req.walletId, 'speedUp');
    case 'trade.cancel':
      return d.engine.replace(req.ticketId, req.walletId, 'cancel');
  }
}

function fail(error: ErrorCode): Result<never> {
  return { ok: false, error };
}

function stripUndefined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
