import { describe, expect, it } from 'vitest';
import {
  formatCompact,
  formatDuration,
  formatPercent,
  formatToken,
  parseDecimalInput,
} from '../src/shared/format';

describe('formatCompact', () => {
  it.each([
    [1_280_000, '1.28M'],
    [2_500, '2.5K'],
    [3_400_000_000, '3.4B'],
    [0.000012345, '0.00001235'],
    [12.345, '12.35'],
    [0, '0'],
    [-1_500_000, '-1.5M'],
  ] as const)('%d → %s', (v, expected) => {
    expect(formatCompact(v)).toBe(expected);
  });

  it('handles non-finite values', () => {
    expect(formatCompact(Number.NaN)).toBe('–');
  });
});

describe('formatToken / formatPercent', () => {
  it('formats bigint amounts', () => {
    expect(formatToken(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatToken(123_456_789_000n, 6)).toBe('123K');
  });

  it('formats basis points', () => {
    expect(formatPercent(250)).toBe('2.5%');
    expect(formatPercent(37)).toBe('0.37%');
  });
});

describe('parseDecimalInput', () => {
  it.each([
    ['0.05', '0.05'],
    ['0,05', '0.05'],
    ['.5', '0.5'],
    ['1.', '1'],
    [' 2 ', '2'],
  ])('%s → %s', (input, out) => {
    expect(parseDecimalInput(input)).toBe(out);
  });

  it.each(['', 'abc', '1.2.3', '1,000.5', '-1', '1e5'])('rejects %s', (input) => {
    expect(parseDecimalInput(input)).toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [185, '185 ms'],
    [999.6, '1000 ms'],
    [1_000, '1 s'],
    [1_234, '1.23 s'],
  ])('%s → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
