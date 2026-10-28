import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { createRelayClient } from '../../src/background/trade/relay';
import { getChain } from '../../src/shared/chains';

/** Real Relay quotes, checked by checkQuote(), and the deposit simulated (no funds). */
const relay = createRelayClient();
const pool = new ClientPool();

describe('Relay bridge (live quote + simulated deposit)', () => {
  const routes: [number, number, string][] = [
    [8453, 56, '0.005'],
    [56, 8453, '0.02'],
    [4663, 8453, '0.003'],
    [1, 42161, '0.005'],
    [42161, 4663, '0.003'],
  ];
  for (const [from, to, amount] of routes) {
    it(`${from} → ${to}`, async () => {
      const me = privateKeyToAccount(generatePrivateKey()).address;
      const other = privateKeyToAccount(generatePrivateKey()).address;
      const q = await relay.quote({
        user: me,
        recipient: other,
        fromChainId: from,
        toChainId: to,
        amount: parseEther(amount),
      });
      expect(q.amountOut).toBeGreaterThan(0n);
      const client = pool.get(getChain(from)!);
      const sim = await client.simulateCalls({
        account: me,
        stateOverrides: [{ address: me, balance: parseEther('1') }],
        calls: [q.tx],
      });
      expect(sim.results[0]?.status, JSON.stringify(sim.results[0]?.error?.message ?? '')).toBe(
        'success',
      );
    });
  }
});
