import type { Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import { broadcastRaw, type RawSender } from '../src/background/trade/broadcast';

const HASH = `0x${'ab'.repeat(32)}` as Hash;
const ok = (ms: number): RawSender => ({
  sendRawTransaction: () => new Promise((r) => setTimeout(() => r(HASH), ms)),
});
const fail = (ms: number, msg: string): RawSender => ({
  sendRawTransaction: () => new Promise((_, j) => setTimeout(() => j(new Error(msg)), ms)),
});

describe('broadcastRaw', () => {
  it('resolves with the first endpoint to accept', async () => {
    const t0 = Date.now();
    await expect(broadcastRaw([ok(200), ok(10)], '0x01')).resolves.toBe(HASH);
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('ignores a fast refusal when another endpoint accepts', async () => {
    await expect(broadcastRaw([fail(1, 'already known'), ok(20)], '0x01')).resolves.toBe(HASH);
  });

  it("reports the first endpoint's reason when all refuse", async () => {
    await expect(
      broadcastRaw([fail(20, 'insufficient funds'), fail(1, 'nonce too low')], '0x01'),
    ).rejects.toThrow('insufficient funds');
  });

  it('refuses an empty endpoint list', async () => {
    await expect(broadcastRaw([], '0x01')).rejects.toThrow('No RPC');
  });
});
