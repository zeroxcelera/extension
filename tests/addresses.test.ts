import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('hard-coded addresses', () => {
  // A mixed-case address with a bad checksum makes viem throw at call time, which the
  // venues swallow as "no route": catch typos here instead.
  it('every mixed-case address literal has a valid checksum', () => {
    const bad: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/'(0x[0-9a-fA-F]{40})'/g)) {
        const a = m[1] as string;
        const mixed = a !== a.toLowerCase() && a.slice(2) !== a.slice(2).toUpperCase();
        if (mixed && getAddress(a) !== a) bad.push(`${file}: ${a}`);
      }
    }
    expect(bad).toEqual([]);
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });
});
