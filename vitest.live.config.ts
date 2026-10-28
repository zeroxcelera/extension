import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Read-only tests against public mainnet RPCs (no keys, no transactions).
// Slower and network-dependent, so kept out of `pnpm test`.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
