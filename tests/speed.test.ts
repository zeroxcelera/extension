import { describe, expect, it } from 'vitest';
import { readyMs, type TicketLeg } from '../src/shared/panel';

const leg = (extra: Partial<TicketLeg>): TicketLeg => ({
  walletId: 'w1',
  walletName: 'Wallet 1',
  kind: 'swap',
  status: 'submitted',
  ...extra,
});

describe('speed split', () => {
  it("counts Celera's own part apart from the network accepting it", () => {
    // A Robinhood buy: 414 ms click to sent, 354 ms of it the network.
    const l = leg({
      sentMs: 414,
      phases: { prepMs: 4, checkMs: 45, signMs: 11, sendMs: 354 },
    });
    expect(readyMs(l)).toBe(60);
    expect((readyMs(l) ?? 0) + (l.phases?.sendMs ?? 0)).toBe(l.sentMs);
  });

  it('has no ready time for records from before the split', () => {
    expect(readyMs(leg({ sentMs: 300 }))).toBeUndefined();
  });
});
