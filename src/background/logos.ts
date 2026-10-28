import type { Address } from 'viem';
import { toBase64 } from '../shared/base64';
import type { ChainConfig } from '../shared/chains';
import type { KeyValueStore } from './vault/vault';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BYTES = 200_000;
const RETRY_MISSING_MS = 24 * 60 * 60_000;
const PREFIX = 'celera.logo.';
const KEY = (chainId: number, token: string) => `${PREFIX}${chainId}.${token.toLowerCase()}`;
const INDEX_KEY = 'celera.logoIndex';
/**
 * The cache shares storage.local (10 MB, with the vault, settings and history), so it is
 * bounded: oldest entries go first once either limit is reached.
 */
export const LOGO_CACHE_MAX_ENTRIES = 300;
export const LOGO_CACHE_MAX_CHARS = 3_000_000;

interface CachedLogo {
  /** data: URL, or null when the CDN has no logo. */
  url: string | null;
  at: number;
}

/** Cache entries in write order (oldest first) with their size, to evict without reading them. */
interface IndexEntry {
  k: string;
  n: number;
}

/**
 * Token logos from DEX Screener's image CDN, fetched by the background (never by a
 * page), restricted to raster formats and a small size, decoded once to make sure the
 * bytes are really an image, then cached as a data: URL. SVG is refused on purpose.
 */
export class LogoService {
  private readonly inflight = new Map<string, Promise<string | null>>();
  private index: IndexEntry[] | null = null;
  /** Index updates are serialised; a failed one does not block the next. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly local: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** `token` = 'native' uses the wrapped-native token's logo. */
  async get(chain: ChainConfig, token: Address | 'native'): Promise<string | null> {
    const addr = token === 'native' ? chain.wrappedNative : token;
    const key = KEY(chain.id, addr);
    const cached = (await this.local.get(key)) as CachedLogo | undefined;
    if (cached && (cached.url || this.now() - cached.at < RETRY_MISSING_MS)) return cached.url;

    let job = this.inflight.get(key);
    if (!job) {
      job = this.fetchLogo(chain, addr)
        .then(async (url) => {
          // Only definite answers are cached ("no logo" included); network errors are not.
          await this.store(key, { url, at: this.now() });
          return url;
        })
        .catch(() => null)
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return job;
  }

  private store(key: string, entry: CachedLogo): Promise<void> {
    const run = this.queue.then(async () => {
      const index = await this.loadIndex();
      const at = index.findIndex((e) => e.k === key);
      if (at >= 0) index.splice(at, 1);
      index.push({ k: key, n: entry.url?.length ?? 0 });
      await this.evict(index);
      await this.local.set(key, entry);
      await this.local.set(INDEX_KEY, index);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Drops the oldest entries until both limits hold. */
  private async evict(index: IndexEntry[]): Promise<void> {
    let chars = index.reduce((s, e) => s + e.n, 0);
    while (index.length > LOGO_CACHE_MAX_ENTRIES || chars > LOGO_CACHE_MAX_CHARS) {
      const old = index.shift();
      if (!old) break;
      chars -= old.n;
      await this.local.remove(old.k);
    }
  }

  private async loadIndex(): Promise<IndexEntry[]> {
    if (this.index) return this.index;
    const stored = await this.local.get(INDEX_KEY);
    if (Array.isArray(stored)) {
      this.index = stored.filter(
        (e): e is IndexEntry => typeof e?.k === 'string' && typeof e?.n === 'number',
      );
      return this.index;
    }
    // First run with a bounded cache: index what earlier versions stored, oldest first.
    const all = (await this.local.getAll?.()) ?? {};
    this.index = Object.entries(all)
      .filter(([k]) => k.startsWith(PREFIX))
      .map(([k, v]) => {
        const c = v as Partial<CachedLogo> | undefined;
        return { k, n: typeof c?.url === 'string' ? c.url.length : 0, at: c?.at ?? 0 };
      })
      .sort((a, b) => a.at - b.at)
      .map(({ k, n }) => ({ k, n }));
    await this.evict(this.index);
    await this.local.set(INDEX_KEY, this.index);
    return this.index;
  }

  private async fetchLogo(chain: ChainConfig, token: Address): Promise<string | null> {
    const url = `https://dd.dexscreener.com/ds-data/tokens/${chain.dexscreenerSlug}/${token.toLowerCase()}.png`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`logo http ${res.status}`); // transient: retry next time
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!ALLOWED_TYPES.has(type)) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
      // Must decode as an image (rejects HTML/JSON served with an image type).
      const bitmap = await createImageBitmap(new Blob([buf], { type }));
      bitmap.close();
      return `data:${type};base64,${toBase64(buf)}`;
    } finally {
      clearTimeout(timer);
    }
  }
}
