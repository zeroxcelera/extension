import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { TicketLeg, TradeTicket } from '../src/shared/panel';
import { costBasis, unrealisedPnl } from '../src/shared/pnl';

const TOKEN = '0x02077a5C3E57Ef3f48B0756E310fcD803Fe67777' as Address;
const E18 = 10n ** 18n;
let n = 0;

const ticket = (
  kind: 'buy' | 'sell',
  legs: Partial<TicketLeg>[],
  extra: Partial<TradeTicket> = {},
) =>
  ({
    id: `t${n++}`,
    kind,
    chainId: 56,
    token: TOKEN,
    status: 'done',
    createdAt: n,
    explorer: '',
    legs: legs.map((l) => ({
      walletId: 'w1',
      walletName: 'Wallet 1',
      kind: 'swap',
      status: 'confirmed',
      ...l,
    })),
    ...extra,
  }) as TradeTicket;

/** Stored newest first, as the activity log keeps it. */
const log = (...oldestFirst: TradeTicket[]) => [...oldestFirst].reverse();

describe('cost basis', () => {
  it('averages buys and takes sells out at the average cost', () => {
    const basis = costBasis(
      log(
        ticket('buy', [
          { amountIn: parseEther('1').toString(), amountOut: (100n * E18).toString() },
        ]),
        ticket('buy', [
          { amountIn: parseEther('3').toString(), amountOut: (100n * E18).toString() },
        ]),
        ticket('sell', [
          { amountIn: (50n * E18).toString(), amountOut: parseEther('5').toString() },
        ]),
      ),
      56,
      TOKEN,
    );
    // 200 tokens for 4 native; selling 50 takes out a quarter of the cost.
    expect(basis.get('w1')).toEqual({ tokens: 150n * E18, costWei: parseEther('3') });
  });

  it('counts only confirmed trades of this token on this chain, per wallet', () => {
    const buy = { amountIn: parseEther('1').toString(), amountOut: (10n * E18).toString() };
    const basis = costBasis(
      log(
        ticket('buy', [buy, { ...buy, walletId: 'w2' }]),
        ticket('buy', [{ ...buy, status: 'failed' }]),
        ticket('buy', [buy], { chainId: 8453 }),
        ticket('buy', [buy], { token: '0x0000000000000000000000000000000000000001' }),
        ticket('buy', [{ ...buy, kind: 'approve' }]),
      ),
      56,
      TOKEN,
    );
    expect(basis.get('w1')).toEqual({ tokens: 10n * E18, costWei: parseEther('1') });
    expect(basis.get('w2')).toEqual({ tokens: 10n * E18, costWei: parseEther('1') });
  });

  it('takes the native paid from the first step of a two-transaction funded buy', () => {
    const basis = costBasis(
      log(
        ticket('buy', [
          { kind: 'step', amountIn: parseEther('0.5').toString() },
          // Paid in the curve's asset, not native.
          { amountIn: (900n * E18).toString(), amountOut: (40n * E18).toString() },
        ]),
      ),
      56,
      TOKEN,
    );
    expect(basis.get('w1')).toEqual({ tokens: 40n * E18, costWei: parseEther('0.5') });
  });
});

describe('unrealised PnL', () => {
  const cost = { tokens: (100n * E18).toString(), costWei: parseEther('1').toString() };

  it('values the held tokens against their cost', () => {
    // 100 tokens for 1 native ($600); now $7 each: $700.
    const up = unrealisedPnl([{ token: (100n * E18).toString(), cost }], 18, 7, 600);
    expect(up?.usd).toBeCloseTo(100);
    expect(up?.bps).toBe(1_667);
    const down = unrealisedPnl([{ token: (100n * E18).toString(), cost }], 18, 3, 600);
    expect(down?.usd).toBeCloseTo(-300);
    expect(down?.bps).toBe(-5_000);
  });

  it('counts only what is still held of what was bought through Celera', () => {
    // Half sent away: half the cost remains. Extra tokens from elsewhere carry no cost.
    const half = unrealisedPnl([{ token: (50n * E18).toString(), cost }], 18, 6, 600);
    expect(half?.usd).toBeCloseTo(0);
    const more = unrealisedPnl([{ token: (500n * E18).toString(), cost }], 18, 7, 600);
    expect(more?.usd).toBeCloseTo(100);
  });

  it('shows nothing without a cost basis or a price', () => {
    expect(unrealisedPnl([{ token: (5n * E18).toString() }], 18, 7, 600)).toBeNull();
    expect(unrealisedPnl([{ token: (100n * E18).toString(), cost }], 18, null, 600)).toBeNull();
  });
});
