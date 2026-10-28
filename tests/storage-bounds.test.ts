import type { Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../src/background/history';
import { LOGO_CACHE_MAX_CHARS, LOGO_CACHE_MAX_ENTRIES, LogoService } from '../src/background/logos';
import type { KeyValueStore } from '../src/background/vault/vault';
import type { TradeTicket } from '../src/shared/panel';
import { getChain } from '../src/shared/chains';

class Store implements KeyValueStore {
  data = new Map<string, unknown>();
  failNextSet = false;
  async get(k: string) {
    return this.data.get(k);
  }
  async set(k: string, v: unknown) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    this.data.set(k, structuredClone(v));
  }
  async remove(k: string) {
    this.data.delete(k);
  }
  async getAll() {
    return Object.fromEntries(this.data);
  }
}

const chain = getChain(8453)!;
const token = (i: number) => `0x${i.toString(16).padStart(40, '0')}` as Address;
const logoKeys = (s: Store) => [...s.data.keys()].filter((k) => k.startsWith('celera.logo.'));

/** The CDN answers every logo with a PNG of `bytes` bytes. */
function serveLogos(bytes: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    ),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ close() {} })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('logo cache', () => {
  it('keeps at most the newest entries', async () => {
    serveLogos(10);
    const store = new Store();
    const logos = new LogoService(store);
    for (let i = 0; i < LOGO_CACHE_MAX_ENTRIES + 5; i++) await logos.get(chain, token(i));
    const keys = logoKeys(store);
    expect(keys).toHaveLength(LOGO_CACHE_MAX_ENTRIES);
    expect(keys).not.toContain(`celera.logo.8453.${token(0)}`);
    expect(keys).toContain(`celera.logo.8453.${token(LOGO_CACHE_MAX_ENTRIES + 4)}`);
  });

  it('keeps the total size bounded', async () => {
    serveLogos(150_000); // ~200 000 characters as a data: URL
    const store = new Store();
    const logos = new LogoService(store);
    for (let i = 0; i < 40; i++) await logos.get(chain, token(i));
    const chars = logoKeys(store).reduce(
      (s, k) => s + ((store.data.get(k) as { url: string }).url.length ?? 0),
      0,
    );
    expect(chars).toBeLessThanOrEqual(LOGO_CACHE_MAX_CHARS);
    expect(logoKeys(store).length).toBeGreaterThan(10);
  });

  it('indexes and trims a cache written before it was bounded', async () => {
    serveLogos(10);
    const store = new Store();
    for (let i = 0; i < LOGO_CACHE_MAX_ENTRIES + 50; i++)
      store.data.set(`celera.logo.8453.${token(i)}`, { url: 'data:image/png;base64,AA==', at: i });
    store.data.set('celera.vault', { keep: true });
    await new LogoService(store).get(chain, token(10_000));
    expect(logoKeys(store)).toHaveLength(LOGO_CACHE_MAX_ENTRIES);
    // The oldest go first; nothing else is touched.
    expect(store.data.has(`celera.logo.8453.${token(0)}`)).toBe(false);
    expect(store.data.get('celera.vault')).toEqual({ keep: true });
  });
});

describe('history writes', () => {
  const ticket = (id: string) => ({ id, kind: 'buy', legs: [] }) as unknown as TradeTicket;

  it('keep working after one failed write (e.g. storage full)', async () => {
    const store = new Store();
    const history = new HistoryStore(store);
    store.failNextSet = true;
    await expect(history.upsert(ticket('a'))).rejects.toThrow(/quota/);
    await history.upsert(ticket('b'));
    const saved = store.data.get('celera.history') as TradeTicket[];
    expect(saved.map((t) => t.id)).toEqual(['b', 'a']);
  });
});
