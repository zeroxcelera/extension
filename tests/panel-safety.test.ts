import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { PANEL_GAP, PANEL_WIDTH, TOASTS_WIDTH, toastPlacement } from '../src/content/panel/layout';
import { gasFeeRefusal } from '../src/background/trade/engine';
import { UNKNOWN_TAX, taxGate, type TaxInfo } from '../src/background/trade/tax';

describe('gas fee limit', () => {
  it('passes normal fees and refuses ones above the USD limit', () => {
    // 250k gas at 12 gwei = 0.003 ETH ≈ $9 at $3,000.
    expect(gasFeeRefusal(250_000n * 12_000_000_000n, 3000, 10, 'ETH')).toBeNull();
    // A mistyped 1,000 gwei priority fee on the same swap.
    const r = gasFeeRefusal(250_000n * 1_000_000_000_000n, 3000, 10, 'ETH');
    expect(r).toMatch(/Gas fee about \$750\.00/);
    expect(r).toMatch(/above your gas limit of \$10/);
  });

  it('leaves unknown prices to the trade limits', () => {
    expect(gasFeeRefusal(parseEther('1'), null, 10, 'ETH')).toBeNull();
  });
});

describe('toast placement', () => {
  const W = 1400;

  it('keeps the default corner when the panel is elsewhere', () => {
    expect(toastPlacement(200, W)).toEqual({});
  });

  it('moves the toasts beside a panel in the default spot, never over it', () => {
    const panelX = W - PANEL_WIDTH - PANEL_GAP; // the default position
    const p = toastPlacement(panelX, W);
    expect(p.right).toBe(`${W - panelX + PANEL_GAP}px`);
    // The stack's right edge sits left of the panel, with the stack fully on screen.
    const stackRight = W - parseInt(p.right as string, 10);
    expect(stackRight).toBeLessThanOrEqual(panelX);
    expect(stackRight - TOASTS_WIDTH).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the top when the window is too narrow for both side by side', () => {
    // A panel dragged into the toast column on a mid-size window still gets them beside it.
    expect(toastPlacement(700, 1040)).toEqual({ right: `${1040 - 700 + PANEL_GAP}px` });
    const narrow = 600;
    expect(toastPlacement(narrow - PANEL_WIDTH - PANEL_GAP, narrow)).toEqual({
      top: `${PANEL_GAP}px`,
      bottom: 'auto',
    });
    // Panel on the left of a wide window: toasts keep their corner.
    expect(toastPlacement(300, 1000)).toEqual({});
  });
});

describe('max tax with an unknown tax', () => {
  const info: TaxInfo = {
    transfer: { buyBps: 0, sellBps: 0 },
    venue: { buyBps: 0, sellBps: 0 },
    sellFails: false,
  };

  it('fails closed when the filter is on and the token could be measured', () => {
    expect(taxGate(null, 500, true)).toBe(UNKNOWN_TAX);
    expect(taxGate(info, 500, true)).toBeNull();
  });

  it('stays out of the way when the filter is off or measuring is impossible by design', () => {
    expect(taxGate(null, 10_000, true)).toBeNull();
    expect(taxGate(null, 500, false)).toBeNull();
  });
});

describe('quick-sell percentages', () => {
  it('accept whole basis points between 0 and 100%', async () => {
    const { isSellPercent } = await import('../src/content/panel/TradeSettings');
    expect([25, 33.33, 100, 0.01].every(isSellPercent)).toBe(true);
    expect([0, 100.01, 12.345, -5].some(isSellPercent)).toBe(false);
  });
});

describe('site script ids', () => {
  it('never collide for different origins', async () => {
    const { siteScriptId } = await import('../src/shared/sites');
    expect(siteScriptId('https://a-b.com')).not.toBe(siteScriptId('https://a_b.com'));
    expect(siteScriptId('https://ab.com')).not.toBe(siteScriptId('https://a.bcom'));
    expect(siteScriptId('https://axiom.trade')).toMatch(/^site-[a-z0-9_]+$/);
  });
});
