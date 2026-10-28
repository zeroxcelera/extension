import { describe, expect, it } from 'vitest';
import { minOutAfter } from '../src/background/trade/engine';
import { taxRefusal, totalBuyBps, totalSellBps, type TaxInfo } from '../src/background/trade/tax';

const info = (buy: number, sell: number | null, venue = 0, sellFails = false): TaxInfo => ({
  transfer: { buyBps: buy, sellBps: sell },
  venue: { buyBps: venue, sellBps: venue },
  sellFails,
});

describe('tax totals', () => {
  it('adds the venue tax to the transfer tax', () => {
    expect(totalBuyBps(info(300, 500, 150))).toBe(450);
    expect(totalSellBps(info(300, 500, 150))).toBe(650);
    expect(totalSellBps(info(300, null, 150))).toBeNull();
  });
});

describe('declared rates', () => {
  it('count when higher than what the simulation measured', () => {
    const t = { ...info(0, null, 100), declared: { buyBps: 900, sellBps: 900 } };
    expect(totalBuyBps(t)).toBe(1000);
    expect(totalSellBps(t)).toBe(1000);
  });

  it('never lower a measured tax', () => {
    const t = { ...info(500, 500), declared: { buyBps: 200, sellBps: 200 } };
    expect(totalBuyBps(t)).toBe(500);
    expect(totalSellBps(t)).toBe(500);
  });
});

describe('taxRefusal', () => {
  it('allows everything when the filter is off', () => {
    expect(taxRefusal(info(9000, 9000, 0, true), 10_000)).toBeNull();
  });

  it('allows unknown taxes (the probe could not run)', () => {
    expect(taxRefusal(null, 500)).toBeNull();
  });

  it('refuses when buy or sell tax is above the max', () => {
    expect(taxRefusal(info(200, 200), 500)).toBeNull();
    expect(taxRefusal(info(200, 800), 500)).toBe('Tax 2% buy / 8% sell, max 5%.');
    expect(taxRefusal(info(0, 0, 600), 500)).toMatch(/6% buy/);
  });

  it('refuses a token whose simulated sell reverts', () => {
    expect(taxRefusal(info(0, null, 0, true), 2000)).toMatch(/Selling this token failed/);
  });
});

describe('minOutAfter', () => {
  it('applies the transfer tax, then the slippage', () => {
    // 1000 → 5% tax → 950 → 10% slippage → 855
    expect(minOutAfter(1000n, 500, 1000)).toBe(855n);
    expect(minOutAfter(1000n, 0, 1000)).toBe(900n);
  });

  it('never returns zero', () => {
    expect(minOutAfter(1n, 9_999, 5000)).toBe(1n);
    expect(minOutAfter(1000n, 10_000, 1000)).toBeGreaterThan(0n);
  });
});
