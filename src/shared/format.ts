import { formatUnits } from 'viem';

// International number formatting everywhere: 1.28M, 0.00001235, 2.5%.
const LOCALE = 'en-US';

const SUFFIX: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/**
 * Compact human number: 1.28M. Small values keep enough significant digits to be
 * useful for meme-coin prices (0.0000123).
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  for (const [threshold, suffix] of SUFFIX) {
    if (abs >= threshold) {
      const n = value / threshold;
      return `${n.toLocaleString(LOCALE, { maximumFractionDigits: n >= 100 ? 0 : 2 })}${suffix}`;
    }
  }
  if (abs === 0) return '0';
  if (abs >= 1) return value.toLocaleString(LOCALE, { maximumFractionDigits: 2 });
  return value.toLocaleString(LOCALE, { maximumSignificantDigits: 4 });
}

/** Formats an on-chain amount (bigint + decimals) compactly. */
export function formatToken(amount: bigint, decimals: number): string {
  return formatCompact(Number(formatUnits(amount, decimals)));
}

export function formatUsd(value: number): string {
  return `$${formatCompact(value)}`;
}

export function formatPercent(bps: number): string {
  return `${(bps / 100).toLocaleString(LOCALE, { maximumFractionDigits: bps < 100 ? 2 : 1 })}%`;
}

/** 185 → "185 ms", 1234 → "1.23 s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toLocaleString(LOCALE, { maximumFractionDigits: 2 })} s`;
}

/**
 * Parses a user-typed decimal ("0.05"; a comma is accepted as the decimal separator
 * too, since some keyboards produce it). Returns null if invalid.
 */
export function parseDecimalInput(input: string): string | null {
  const s = input.trim().replace(/\s/g, '');
  if (!s) return null;
  // Accept a single decimal separator of either kind; reject thousands separators.
  const normalized = s.replace(',', '.');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(normalized)) return null;
  const out = normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
  return out.startsWith('.') ? `0${out}` : out;
}
