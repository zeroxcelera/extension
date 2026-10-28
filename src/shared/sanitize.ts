// Token names/symbols are attacker-controlled. Strip anything that can spoof layout or
// hide text (control chars, bidi overrides, zero-width chars) and cap the length.
// Rendering still uses text nodes only; this is about what the user *sees*.
const UNSAFE_RANGES: [number, number][] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width chars, LRM/RLM
  [0x202a, 0x202e], // bidi embeddings / overrides
  [0x2060, 0x2069], // word joiner, bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isUnsafe(code: number): boolean {
  return UNSAFE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

export function sanitizeLabel(value: unknown, max = 32): string {
  if (typeof value !== 'string') return '';
  const clean = [...value]
    .filter((ch) => !isUnsafe(ch.codePointAt(0) ?? 0))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, max).join('');
}
