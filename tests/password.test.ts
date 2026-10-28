import { describe, expect, it } from 'vitest';
import { CONTENT_TYPES, RequestSchema } from '../src/shared/messages';
import { passwordStrength } from '../src/shared/password';

describe('password strength', () => {
  it('rates short or one-kind passwords weak', () => {
    expect(passwordStrength('password')).toBe('weak');
    expect(passwordStrength('12345678')).toBe('weak');
    expect(passwordStrength('Tr0ub4d!')).toBe('weak');
  });

  it('rates long or varied passwords higher', () => {
    expect(passwordStrength('Tr0ub4dor&3x')).toBe('strong');
    expect(passwordStrength('lowercaseonly1')).toBe('fair');
    expect(passwordStrength('correct horse battery staple')).toBe('strong');
  });
});

describe('panel position messages', () => {
  it('are open to content scripts and carry no site field', () => {
    expect(CONTENT_TYPES.has('panel.getPrefs')).toBe(true);
    expect(CONTENT_TYPES.has('panel.setPrefs')).toBe(true);
    const prefs = { x: 12.5, y: 80, minimized: false, hidden: true };
    expect(RequestSchema.safeParse({ type: 'panel.setPrefs', prefs }).success).toBe(true);
    // The site is the sender's origin: a field naming another one is refused.
    expect(
      RequestSchema.safeParse({ type: 'panel.setPrefs', prefs, host: 'gmgn.ai' }).success,
    ).toBe(false);
    expect(
      RequestSchema.safeParse({ type: 'panel.setPrefs', prefs: { ...prefs, x: Infinity } }).success,
    ).toBe(false);
  });
});
