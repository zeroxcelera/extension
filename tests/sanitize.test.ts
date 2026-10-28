import { describe, expect, it } from 'vitest';
import { sanitizeLabel } from '../src/shared/sanitize';

const c = (code: number) => String.fromCodePoint(code);

describe('sanitizeLabel', () => {
  it('strips bidi overrides and zero-width characters', () => {
    expect(sanitizeLabel(`US${c(0x202e)}DC${c(0x200b)}`)).toBe('USDC');
    expect(sanitizeLabel(`a${c(0x2066)}b${c(0xfeff)}c`)).toBe('abc');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeLabel(`  Pepe${c(0x0007)}\n\t Coin  `)).toBe('Pepe Coin');
  });

  it('keeps emoji and non-latin text, capped by code point', () => {
    expect(sanitizeLabel('🐸 币安人生')).toBe('🐸 币安人生');
    expect(sanitizeLabel('🐸'.repeat(40), 5)).toBe('🐸'.repeat(5));
  });

  it('rejects non-strings', () => {
    expect(sanitizeLabel(42)).toBe('');
    expect(sanitizeLabel(null)).toBe('');
  });
});
