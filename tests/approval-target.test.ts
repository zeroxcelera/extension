import { maxUint256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { approvalTarget } from '../src/background/trade/engine';
import { DEFAULT_GLOBAL_SETTINGS } from '../src/shared/settings/defaults';

describe('approvalTarget', () => {
  it('is unlimited by default', () => {
    expect(approvalTarget(DEFAULT_GLOBAL_SETTINGS, 1_000n)).toBe(maxUint256);
  });

  it('covers holdings plus the headroom when bounded', () => {
    const gs = { ...DEFAULT_GLOBAL_SETTINGS, unlimitedApprovals: false, approvalBufferBps: 1_000 };
    expect(approvalTarget(gs, 1_000n)).toBe(1_100n);
  });
});
