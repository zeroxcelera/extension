import type { z } from 'zod';
import { getChain } from '../shared/chains';
import {
  ChainSettingsSchema,
  DEFAULT_GLOBAL_SETTINGS,
  GlobalSettingsSchema,
  QUICK_VALUES_DIFFER,
  defaultChainSettings,
  type ChainSettings,
  type GlobalSettings,
} from '../shared/settings/defaults';
import { PanelPrefsSchema, type PanelPrefs } from '../shared/messages';
import type { KeyValueStore } from './vault/vault';

const SETTINGS_KEY = 'celera.settings';
const CHAIN_KEY = (id: number) => `celera.chain.${id}`;
const SITES_KEY = 'celera.sites';
/** Per hostname, the key the content script itself used before storage was locked down. */
const PANEL_KEY = (host: string) => `celera.panel.${host}`;
const DEFAULT_PANEL_PREFS: PanelPrefs = { x: -1, y: -1, minimized: false, hidden: false };

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/** A change the user cannot save as given; `message` is shown to them as is. */
export class SettingsError extends Error {}

/**
 * Stored settings, field by field: a field that no longer validates (saved by an older
 * version, or damaged) falls back to its own default instead of resetting everything,
 * and is reported so the popup can say which ones.
 */
function repair<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  defaults: z.output<z.ZodObject<S>>,
  stored: unknown,
): { value: z.output<z.ZodObject<S>>; reset: string[] } {
  const source = isObject(stored) ? stored : {};
  const out: Record<string, unknown> = { ...defaults };
  const reset: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    if (!(key in source)) continue;
    const r = (field as z.ZodType).safeParse(source[key]);
    if (r.success) out[key] = r.data;
    else reset.push(key);
  }
  return { value: out as z.output<z.ZodObject<S>>, reset };
}

/** Parses a change, turning a validation failure into a message for the user. */
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const own = r.error.issues.find((i) => i.message === QUICK_VALUES_DIFFER);
  throw new SettingsError(own ? QUICK_VALUES_DIFFER : 'Value out of range.');
}

/** Limits that contradict each other (the stricter one would silently win). */
function limitConflict(s: GlobalSettings): string | null {
  if (s.maxUsdPerTx > s.maxUsdPerClick)
    return `Max per transaction ($${s.maxUsdPerTx}) can't be above max per click ($${s.maxUsdPerClick}). Raise max per click first.`;
  if (s.priceImpactWarnBps > s.priceImpactDangerBps)
    return "The price impact warning can't be above the danger level.";
  return null;
}

export class SettingsStore {
  /** Fields reset to their default when read, e.g. "Max per transaction" or "BSC: Slippage". */
  private readonly resetFields = new Set<string>();

  constructor(private readonly local: KeyValueStore) {}

  /** Settings found invalid and reset to their defaults since the worker started. */
  repairs(): string[] {
    return [...this.resetFields];
  }

  async get(): Promise<GlobalSettings> {
    const { value, reset } = repair(
      GlobalSettingsSchema,
      DEFAULT_GLOBAL_SETTINGS,
      await this.local.get(SETTINGS_KEY),
    );
    for (const k of reset) this.resetFields.add(k);
    return value;
  }

  async update(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const next = checked(GlobalSettingsSchema, { ...(await this.get()), ...patch });
    const conflict = limitConflict(next);
    if (conflict) throw new SettingsError(conflict);
    await this.local.set(SETTINGS_KEY, next);
    return next;
  }

  async getChain(chainId: number): Promise<ChainSettings> {
    const chain = getChain(chainId);
    if (!chain) throw new Error('unsupported_chain');
    const { value, reset } = repair(
      ChainSettingsSchema,
      defaultChainSettings(chain),
      await this.local.get(CHAIN_KEY(chainId)),
    );
    for (const k of reset) this.resetFields.add(`${chain.shortName}: ${k}`);
    // MEV can never be on for a chain that does not support it.
    if (!chain.mev.supported) value.mevEnabled = false;
    // An empty private RPC means "the chain's default" (protection is turned off with
    // mevEnabled, not by clearing the URL). Covers settings saved before a default existed.
    else if (!value.mevRpc && chain.mev.defaultRpc) value.mevRpc = chain.mev.defaultRpc;
    return value;
  }

  async updateChain(chainId: number, patch: Partial<ChainSettings>): Promise<ChainSettings> {
    const chain = getChain(chainId);
    if (!chain) throw new Error('unsupported_chain');
    const next = checked(ChainSettingsSchema, { ...(await this.getChain(chainId)), ...patch });
    if (!chain.mev.supported) next.mevEnabled = false;
    await this.local.set(CHAIN_KEY(chainId), next);
    return next;
  }

  /** Origins the user enabled at runtime (on top of the built-in sites). */
  async enabledSites(): Promise<string[]> {
    const v = await this.local.get(SITES_KEY);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  }

  async setEnabledSites(origins: string[]): Promise<void> {
    await this.local.set(SITES_KEY, [...new Set(origins)].sort());
  }

  /** The panel's place on the site `origin` (the requesting content script's own origin). */
  async panelPrefs(origin: string | undefined): Promise<PanelPrefs> {
    const host = hostOf(origin);
    if (!host) return DEFAULT_PANEL_PREFS;
    const stored = await this.local.get(PANEL_KEY(host));
    const parsed = PanelPrefsSchema.safeParse({
      ...DEFAULT_PANEL_PREFS,
      ...(isObject(stored) ? stored : {}),
    });
    return parsed.success ? parsed.data : DEFAULT_PANEL_PREFS;
  }

  async setPanelPrefs(origin: string | undefined, prefs: PanelPrefs): Promise<void> {
    const host = hostOf(origin);
    if (host) await this.local.set(PANEL_KEY(host), PanelPrefsSchema.parse(prefs));
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
