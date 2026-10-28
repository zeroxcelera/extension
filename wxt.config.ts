import { defineConfig } from 'wxt';
import { API_HOSTS, BUILTIN_SITES } from './src/shared/sites';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  manifestVersion: 3,
  // Explicit imports only: every dependency of security-sensitive code is visible.
  imports: false,
  manifest: {
    name: 'Celera',
    description: 'Fast buy/sell panel for EVM DEX trading terminals.',
    minimum_chrome_version: '116',
    // storage: vault + settings; alarms: auto-lock timer;
    // offscreen + clipboardWrite: blank the clipboard 30 s after a key export;
    // scripting + activeTab: inject the panel on sites the user enables at runtime.
    permissions: ['storage', 'alarms', 'offscreen', 'clipboardWrite', 'scripting', 'activeTab'],
    // Only the built-in terminals (and the pool-index API) are granted at install time.
    // Any other site is granted per-origin at runtime from the popup.
    host_permissions: [...BUILTIN_SITES.flatMap((s) => s.matches), ...API_HOSTS],
    optional_host_permissions: ['https://*/*'],
    web_accessible_resources: [
      {
        // The unlock field is an extension-origin iframe so the page cannot read keystrokes.
        resources: ['unlock.html'],
        matches: ['https://*/*'],
        use_dynamic_url: true,
      },
    ],
    content_security_policy: {
      // 'wasm-unsafe-eval' is required by hash-wasm (Argon2id). No remote code.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  // JSX → Preact comes from tsconfig (jsx: react-jsx, jsxImportSource: preact).
  vite: () => ({
    build: {
      // Readable output makes reviewing the shipped bundle possible.
      minify: false,
      sourcemap: false,
    },
  }),
});
