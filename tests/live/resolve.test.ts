import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { resolveTarget, type ResolveDeps } from '../../src/background/resolve';
import { detect } from '../../src/content/adapters';

const pool = new ClientPool();
const deps: ResolveDeps = {
  client: (c) => pool.get(c),
  fetchJson: async (url) => (await fetch(url)).json(),
};

async function resolveUrl(url: string) {
  const d = detect(url);
  if (!d) throw new Error(`not detected: ${url}`);
  return resolveTarget(d, deps);
}

describe('resolveTarget (mainnet, read-only)', () => {
  it('resolves a GMGN token URL on BSC', async () => {
    const r = await resolveUrl(
      'https://gmgn.ai/bsc/token/0x988635ef13f78daf7022f6109dbf6b02f35c7777',
    );
    expect(r).toMatchObject({ chainId: 56, source: 'url' });
    expect(r?.decimals).toBeGreaterThan(0);
  });

  it('resolves well-known tokens on each chain', async () => {
    const cases = [
      ['https://gmgn.ai/eth/token/0x6982508145454Ce325dDbE47a25d4ec3d2311933', 1, 'PEPE'],
      ['https://gmgn.ai/base/token/0x532f27101965dd16442E59d40670FaF5eBB142E4', 8453, 'BRETT'],
    ] as const;
    for (const [url, chainId, symbol] of cases) {
      const r = await resolveUrl(url);
      expect(r).toMatchObject({ chainId, symbol });
    }
  });

  it('resolves a DEX Screener pair to its base token (Robinhood)', async () => {
    const r = await resolveUrl(
      'https://dexscreener.com/robinhood/0x43b9d97ac89d1dac6678fe52087cddb7a3ed56d6',
    );
    expect(r?.chainId).toBe(4663);
    expect(r?.source).toBe('pair');
    expect(r?.symbol).not.toBe('WETH');
  });

  it('finds the chain when the URL has none', async () => {
    const r = await resolveUrl(
      'https://example.trade/t/0x532f27101965dd16442E59d40670FaF5eBB142E4',
    );
    expect(r).toMatchObject({ chainId: 8453, symbol: 'BRETT' });
  });

  it('returns null for an EOA', async () => {
    const r = await resolveUrl(
      'https://gmgn.ai/base/token/0x000000000000000000000000000000000000dEaD',
    );
    expect(r).toBeNull();
  });
});
