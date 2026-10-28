import { describe, expect, it } from 'vitest';
import { PortfolioService } from '../src/background/portfolio';
import { PriceService } from '../src/background/trade/prices';
import { Routing } from '../src/background/trade/routing';
import type { KeyValueStore } from '../src/background/vault/vault';

class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

const BOUGHT = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const AIRDROP = '0x1111111111111111111111111111111111111111';

function service() {
  const routing = new Routing([]);
  return new PortfolioService(new MemoryStore(), routing, new PriceService(routing));
}

describe('portfolio trust', () => {
  it('trusts tokens added by trades or by hand, not ones found in transfers', async () => {
    const p = service();
    await p.addTokens(8453, [BOUGHT]);
    await p.addTokens(8453, [AIRDROP], false);
    expect(await p.knownTokens(8453)).toHaveLength(2);
    const trusted = await p.trustedTokens(8453);
    expect(trusted.has(BOUGHT.toLowerCase())).toBe(true);
    expect(trusted.has(AIRDROP.toLowerCase())).toBe(false);
  });

  it('buying an airdropped token later makes it trusted', async () => {
    const p = service();
    await p.addTokens(8453, [AIRDROP], false);
    await p.addTokens(8453, [AIRDROP]);
    expect((await p.trustedTokens(8453)).has(AIRDROP.toLowerCase())).toBe(true);
  });

  it('with many holdings, still shows a fresh buy and leaves airdrops for last', async () => {
    const p = service();
    const addr = (i: number) => `0x${(i + 0x1000).toString(16).padStart(40, '0')}` as const;
    for (let i = 0; i < 40; i++) await p.addTokens(8453, [addr(i)]);
    for (let i = 40; i < 45; i++) await p.addTokens(8453, [addr(i)], false);
    await p.addTokens(8453, [BOUGHT]); // the newest buy
    const client = {
      getBlockNumber: async () => {
        throw new Error('no logs here');
      },
      multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
        contracts.map((c) => ({
          status: 'success',
          result:
            c.functionName === 'symbol' || c.functionName === 'name'
              ? 'TOK'
              : c.functionName === 'decimals'
                ? 18
                : c.functionName === 'getEthBalance'
                  ? 0n
                  : 1n,
        })),
    };
    const { getChain } = await import('../src/shared/chains');
    const portfolio = await p.get(
      { chain: getChain(8453)!, client: client as never, now: Date.now },
      [{ id: 'w1', address: '0x2222222222222222222222222222222222222222' }],
    );
    const shown = portfolio.tokens.map((t) => t.address.toLowerCase());
    expect(shown).toHaveLength(30);
    expect(shown).toContain(BOUGHT.toLowerCase());
    expect(shown).not.toContain(addr(40).toLowerCase()); // an airdrop
    expect(portfolio.tokens.every((t) => !t.unsolicited)).toBe(true);
  });

  it('can be marked and unmarked by the user, per chain', async () => {
    const p = service();
    await p.addTokens(8453, [AIRDROP], false);
    await p.setTrusted(8453, AIRDROP, true);
    expect((await p.trustedTokens(8453)).has(AIRDROP.toLowerCase())).toBe(true);
    expect((await p.trustedTokens(56)).has(AIRDROP.toLowerCase())).toBe(false);
    await p.setTrusted(8453, AIRDROP, false);
    expect((await p.trustedTokens(8453)).has(AIRDROP.toLowerCase())).toBe(false);
  });
});
