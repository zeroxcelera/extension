import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { DUST_USD, PortfolioService } from '../../src/background/portfolio';
import { PriceService } from '../../src/background/trade/prices';
import { Routing } from '../../src/background/trade/routing';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues } from '../../src/background/trade/venues';
import type { KeyValueStore } from '../../src/background/vault/vault';
import { getChain } from '../../src/shared/chains';

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

// A public address that receives a lot of airdropped spam: good for the dust filter.
const VITALIK: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BRETT: Address = '0x532f27101965dd16442E59d40670FaF5eBB142E4';

describe('portfolio (Base, read-only)', () => {
  it('discovers tokens, prices them on-chain and flags dust', async () => {
    const chain = getChain(8453)!;
    const routing = new Routing([uniswapVenue, ...extraVenues]);
    const svc = new PortfolioService(new MemoryStore(), routing, new PriceService(routing));
    await svc.addTokens(8453, [BRETT]);
    const ctx = { chain, client: new ClientPool().get(chain), now: Date.now };
    const t0 = Date.now();
    const p = await svc.get(ctx, [{ id: 'w', address: VITALIK }]);
    const ms = Date.now() - t0;

    expect(p.nativeUsd).toBeGreaterThan(100);
    for (const t of p.tokens) {
      expect(BigInt(t.total)).toBeGreaterThan(0n);
      expect(t.dust).toBe(t.valueUsd === null || t.valueUsd < DUST_USD);
    }
    const values = p.tokens.map((t) => t.valueUsd ?? -1);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    // Report for the log: how much was discovered and hidden.
    const dust = p.tokens.filter((t) => t.dust).length;
    console.log(
      `tokens=${p.tokens.length} shown=${p.tokens.length - dust} dust=${dust} in ${ms} ms`,
    );
  }, 120_000);
});
