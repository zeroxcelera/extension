import { describe, expect, it } from 'vitest';
import { NonceManager } from '../src/background/trade/nonce';
import { bumpFees, computeFees, staticGas } from '../src/background/trade/fees';
import { priceImpactBps } from '../src/background/trade/routing';
import { getChain } from '../src/shared/chains';

const A = '0x1111111111111111111111111111111111111111';

describe('NonceManager', () => {
  it('hands out consecutive nonces for concurrent clicks', async () => {
    let fetches = 0;
    const nm = new NonceManager(async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 5));
      return 7;
    });
    const got = await Promise.all(
      Array.from({ length: 5 }, () => nm.withNonce(1, A, async (n) => n)),
    );
    expect(got).toEqual([7, 8, 9, 10, 11]);
    expect(fetches).toBe(1);
  });

  it('releases the nonce when sending fails', async () => {
    let remote = 3;
    const nm = new NonceManager(async () => remote);
    await expect(
      nm.withNonce(1, A, async () => Promise.reject(new Error('rpc down'))),
    ).rejects.toThrow();
    remote = 3;
    expect(await nm.withNonce(1, A, async (n) => n)).toBe(3);
  });

  it('never goes below the remote pending nonce after a resync', async () => {
    let t = 0;
    let remote = 1;
    const nm = new NonceManager(
      async () => remote,
      () => t,
    );
    expect(await nm.withNonce(1, A, async (n) => n)).toBe(1);
    remote = 10; // txs sent from elsewhere
    t = 60_000;
    expect(await nm.withNonce(1, A, async (n) => n)).toBe(10);
  });
});

describe('fees', () => {
  it('EIP-1559 fees from base fee and preset', () => {
    const f = computeFees(getChain(8453)!, 1_000_000_000n, {
      priorityFeeGwei: '0.01',
      maxFeeMultiplier: 2,
      slippageBps: 500,
    });
    expect(f.maxPriorityFeePerGas).toBe(10_000_000n);
    expect(f.maxFeePerGas).toBe(2_010_000_000n);
  });

  it('ignores priority fee on Arbitrum-style chains', () => {
    const f = computeFees(getChain(4663)!, 10_000_000n, {
      priorityFeeGwei: '5',
      maxFeeMultiplier: 1.5,
      slippageBps: 500,
    });
    expect(f.maxPriorityFeePerGas).toBe(0n);
    expect(f.maxFeePerGas).toBe(15_000_000n);
  });

  it('replacement bumps both fees by >10%', () => {
    const f = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
    const b = bumpFees(f, { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
    expect(b.maxFeePerGas).toBeGreaterThanOrEqual(1100n);
    expect(b.maxPriorityFeePerGas).toBeGreaterThanOrEqual(110n);
  });

  it('gives an ERC-20 transfer a token-sized gas limit, not a plain transfer one', () => {
    const base = getChain(8453)!;
    expect(staticGas(base, 'transfer')).toBe(21_000n);
    expect(staticGas(base, 'tokenTransfer')).toBeGreaterThan(staticGas(base, 'transfer'));
    expect(staticGas(base, 'tokenTransfer')).toBeLessThan(staticGas(base, 'swap'));
    const arb = getChain(4663)!;
    expect(staticGas(arb, 'tokenTransfer')).toBeGreaterThan(staticGas(arb, 'transfer'));
  });

  it('never gives a bridge deposit (a contract call) a plain-transfer gas limit', () => {
    for (const id of [8453, 4663]) {
      const chain = getChain(id)!;
      expect(staticGas(chain, 'deposit')).toBeGreaterThan(staticGas(chain, 'transfer'));
    }
    expect(staticGas(getChain(8453)!, 'deposit')).toBeGreaterThan(21_000n);
  });

  it('gives a Celera Router call more than one swap of gas', () => {
    // A funded router buy on BSC used 495k gas: more than one swap's limit.
    for (const chain of [getChain(56)!, getChain(8453)!])
      expect(staticGas(chain, 'routed')).toBeGreaterThan(2n * staticGas(chain, 'swap'));
  });
});

describe('priceImpactBps', () => {
  it('is 0 when the rate matches the reference', () => {
    expect(priceImpactBps(100n, 200n, 1n, 2n)).toBe(0);
  });
  it('measures the shortfall vs. the reference rate', () => {
    expect(priceImpactBps(100n, 190n, 1n, 2n)).toBe(500);
  });
});
