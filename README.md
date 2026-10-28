# Celera

Chrome (Manifest V3) extension that holds your own EVM wallets and injects a one-click
buy/sell panel into DEX trading terminals. It reads the token from the page URL,
resolves it on-chain, routes across AMMs and bonding-curve launchpads, and signs
locally after a strict transaction validator.

> **Mainnet from day one.** There is no testnet stage. Start with a fresh wallet that
> holds a small amount. Defaults are conservative: $25 per transaction, $50 per click,
> confirmation above $20, simulation before every signature.

## What is supported

| Chain                  | AMMs                                                                | Launchpads                                                                        |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Ethereum (1)           | Uniswap v2 / v3 / v4, PancakeSwap v3                                | Clanker, Klik, Stockereum (v4 hook pools)                                         |
| Base (8453)            | Uniswap v2 / v3 / v4, PancakeSwap v3, Aerodrome (volatile + stable) | Flap curve, Clanker, Bankr (Doppler), Zora, Flaunch, Virtuals (curve + graduated) |
| BNB Smart Chain (56)   | Uniswap v2 / v3 / v4, PancakeSwap v2 / v3                           | four.meme, Flap curves                                                            |
| Robinhood Chain (4663) | Uniswap v3 / v4                                                     | Pons, Flap curves, Bankr (Doppler)                                                |
| Arbitrum One (42161)   | Uniswap v2 / v3 / v4                                                | – (added as config only, see below)                                               |

Tokens are routed against the chain's native asset (or its wrapped form), or against a
stablecoin (USDC, USDT, USD1, USDG, depending on the chain). A stablecoin pool is reached
in the same transaction: native → stable → token to buy, token → stable → native to sell,
both legs on the same DEX. For every amount Celera quotes all pools it finds and uses the
best output. Curve tokens are routed to the launchpad while they are on the curve and to
the DEX after graduation.

**Sites.** Built in: GMGN, DEX Screener, DEXTools, GeckoTerminal, Birdeye, Axiom,
BasedBot, four.meme, Flap. Any other site: open it, then Celera popup → Settings →
Sites → _Enable on this site_ (grants that one origin at runtime).

## Install and first use

```bash
pnpm install
```

```bash
pnpm build
```

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   `.output/chrome-mv3`.
2. The setup tab opens. Create a wallet (write down the 12 words, confirm 3 of them) or
   import a recovery phrase.
3. Fund _Wallet 1_ with a small amount on the chain you want to try.
4. Open a token page on a supported site. The panel appears on the right.
5. Unlock inside the panel (the password field is an extension frame the page cannot
   read), then click a quick-buy button. Hotkeys: `1`–`4` buy, `Q` `W` `E` `R` sell
   25/50/75/100 %.

In the panel, under the quick-buy buttons: slippage (10 / 20 / 40 % or custom), priority
fee (Low / Medium / High or custom gwei; hidden on first-come-first-served chains) and MEV
protection. The pencil next to "Buy" edits the four quick-buy amounts, the one next to
"Sell" the four quick-sell percentages (hotkeys Q W E R follow them). All of these are saved
per chain.

### Popup

Four tabs along the bottom:

- **Wallets.** Wallet pills (All, W1★, W2, …) at the top, the total in USD, then the
  tokens you hold on the selected chain with their logos. Tokens worth under $1 (or with
  no price) are folded into a "dust" row. Tap a token for _Open chart_, _Sell 50 %_ and
  _Sell 100 %_. Below: New, Import, Distribute, Collect.
- **Activity.** Every trade, transfer and bridge Celera sent (last 200), grouped by day,
  filterable, each with its transactions and explorer links. The tab badge counts
  pending ones.
- **Bridge.** Native → native between Celera's chains through [Relay](https://relay.link):
  quote as you type, MAX keeps gas back, live status until the funds arrive.
- **Settings.** Safety limits, confirmation threshold, simulation, auto-lock, multi-wallet
  mode and jitter, hotkeys, token logos; per chain: quick-buy amounts, default slippage,
  Low/Medium/High priority fees, max-fee multiplier, custom RPC, WebSocket RPC, MEV
  private RPC (Ethereum and BSC only).

**Which tokens show up.** Tokens you traded or transferred with Celera, tokens you add
with _Add token_, and tokens found by scanning `Transfer` logs to your wallets. Public
RPCs refuse that scan (Celera then retries after an hour), so a token bought outside Celera
only appears automatically with a custom RPC; otherwise add it once by address.

**WebSocket RPC (optional).** With a `wss://` URL set, Celera subscribes to new blocks:
confirmations are noticed in the block they land, and the panel's quotes and fee
estimates refresh every block. Quotes and sending still go over HTTPS, which also takes
over if the socket drops. The status line under the field shows the connection.

## Architecture

```
 Trading terminal tab
 ┌────────────────────────────────────────────────────────────────────┐
 │ page JS (untrusted)   ╳ cannot reach the panel (closed shadow root, │
 │                         isTrusted checks on clicks and keys)        │
 │ ┌──────────── content script (isolated world) ───────────────────┐  │
 │ │ URL adapter → Detection { chain?, token | pair | v4 pool id }  │  │
 │ │ Panel (Preact) · iframe: unlock.html (extension origin)        │  │
 │ │ no keys, no signing                                            │  │
 │ └────────────────────────────┬───────────────────────────────────┘  │
 └──────────────────────────────┼──────────────────────────────────────┘
                                │ runtime messages: zod-parsed, sender id +
                                │ origin + top frame checked, per-sender allowlist
 ┌──────────────────────────────▼──────────────────────────────────────┐
 │ background service worker — the only place keys exist               │
 │  resolve (on-chain) → routing (venues) → engine:                    │
 │    quote → build → VALIDATOR → simulate → sign → nonce → send → watch│
 │  vault: Argon2id → AES-256-GCM (storage.local = ciphertext only)    │
 │         AES key in storage.session (trusted contexts only)          │
 └──────────────────────────────▲──────────────────────────────────────┘
                                │
 ┌──────────────────────────────┴──────────────────────────────────────┐
 │ popup: wallets + holdings, activity, bridge (Relay), settings        │
 └─────────────────────────────────────────────────────────────────────┘
```

### A buy, step by step

1. The adapter reads `gmgn.ai/base/token/0x…` → `{ chainId: 8453, token }`. Pair URLs
   (DEX Screener, DEXTools, GeckoTerminal) are resolved via `token0/token1`; v4 pool ids
   via Uniswap's PositionManager (re-hashed to verify). Nothing is read from the DOM.
2. The background reads name/symbol/decimals on-chain (sanitised) and discovers pools:
   Uniswap v2/v3/v4 (standard tiers, Zora `getPoolKey()`, and the DEX Screener index
   verified on-chain), PancakeSwap, Aerodrome, four.meme / Flap / Pons curves.
3. Quotes for all quick amounts plus a tiny reference amount are fetched in one round
   trip per pool; price impact is measured against the reference on the same pool.
4. On click: USD limits and the confirmation threshold are checked (USD price comes
   from native → stablecoin liquidity on-chain), the chosen pool is re-quoted, minimum
   output = quote × (1 − preset slippage).
5. The transaction is built, **validated**, simulated (`eth_estimateGas`), signed with
   EIP-1559 fees from the preset (priority fee ignored on Arbitrum-stack chains), given
   a locally tracked nonce and sent (private RPC when MEV protection is on).
6. An approval follows so the next sell is one click (Permit2 for Uniswap; the
   router/curve itself for the others). By default it is unlimited and sent once per
   token; with "Approve each token once" off it is bounded and topped up after each buy. Sells through Uniswap sign a Permit2 permit for
   exactly the amount sold.

| Path                                    | What                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `src/content/adapters.ts`               | URL adapters (add a site here)                            |
| `src/content/panel/`                    | Panel UI, hotkeys, drag, toasts                           |
| `src/background/resolve.ts`             | On-chain token resolution                                 |
| `src/background/trade/uniswap/`         | Universal Router codec + Uniswap venue + addresses        |
| `src/background/trade/venues/`          | Generic v2-router and v3-router venues                    |
| `src/background/trade/venues.ts`        | PancakeSwap / Aerodrome instances (add an AMM here)       |
| `src/background/trade/launchpads.ts`    | four.meme, Flap, Pons curves                              |
| `src/background/trade/legs.ts`          | Native ↔ quote-asset pools for curves quoted in an ERC-20 |
| `src/background/trade/celera-router.ts` | Celera Router steps, encoding, Permit2 transfer, rule     |
| `src/background/trade/validator.ts`     | Pre-signature validator                                   |
| `src/background/trade/engine/`          | Engine: core (validate, sign, send, receipts) + flows     |
| `src/background/panel.ts`               | Panel state and live quotes                               |
| `src/background/vault/`                 | Key storage                                               |
| `src/shared/chains/definitions.ts`      | Chain config (add a chain here)                           |

### Adding things

- **Chain:** one entry in `src/shared/chains/definitions.ts` (schema-validated at load)
  plus its Uniswap addresses in `src/background/trade/uniswap/addresses.ts`. Arbitrum was
  added exactly this way, with no code changes, and passes the live round-trip test.
- **AMM:** one `v2RouterVenue(...)` / `v3RouterVenue(...)` entry in `venues.ts`.
- **Launchpad:** a `Venue` with `discover` (only while on the curve), `quote`, `build*`,
  `sellApproval` and `poolRules` (validator rule for its contract).
- **Site:** an adapter in `adapters.ts`, and its match pattern in `src/shared/sites.ts`.

## Transaction validator

Runs before every signature (transactions and Permit2 typed data), synchronously,
without RPC; well under 5 ms (tested). Anything not understood is rejected and shown in
the panel as _Transaction blocked_ with each decoded action.

- Sender must be one of your wallets; native value ≤ per-transaction USD limit.
- Allowed targets: the chain's Universal Router, the traded token, allowlisted AMM
  routers / launchpad contracts, and your own wallets (plain transfers only).
- Universal Router: only `WRAP_ETH`, `UNWRAP_WETH`, `SWEEP`, `V2/V3_SWAP_EXACT_IN`,
  `V4_SWAP` (swap-exact-in-single, settle, settle-all, take, take-all) and
  `PERMIT2_PERMIT`; the allow-revert flag is rejected. Assets limited to the traded
  token, native, wrapped native and the chain's listed stablecoins; a stablecoin may only
  sit between native and the token, and any stablecoin a step leaves in the router must
  be used up by a later step (whole balance swapped on, or swept to you). Every output
  recipient must be the router itself or your wallet, and at least one step must pay you.
  Non-zero minimum output required. Deadline within 30 minutes.
- Permit2 permits: the traded token, spender = router, amount ≤ the amount being sold,
  expiry ≤ 2 hours.
- ERC-20: `approve` only to Permit2 or an allowlisted router/curve, and never above the
  amount the engine asked for (unlimited only when that setting is on); `transfer` only
  to your wallets; everything else rejected.
- Router/launchpad rules: direct swap or one stablecoin hop (native on one end, the
  traded token on the other), own recipient, slippage, deadline, value checks.
- Celera Router (only where a chain has `celeraRouter` set): `execute` must buy the
  traded token with native, or sell it for native through a Permit2 transfer of at most
  the amount sold to this router; every asset the route touches is returned to you.
  Each step is decoded: the Universal Router and venue rules above apply to it as if
  the router were your wallet; a step's `spender` (allowed to pull its amount for that
  call only) must be an allowlisted venue; token steps may only hand the router's exact
  balance to the next step's contract, never approve; Permit2 and the router itself are
  never targets; injected amounts must sit inside the call.

Tests: every legitimate plan from every venue passes; 19 named malicious payloads and a
2,000-case fuzz run never let value or tokens reach a foreign address.

## Threat model

| Threat                                       | Mitigation                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page reads keys or password                  | Keys only in the background. No message returns key material to content scripts. `storage.session` and `storage.local` (encrypted vault, RPC URLs, history) restricted to trusted contexts; the panel keeps its position through the background. Unlock is an extension-origin iframe. |
| Page drives the panel                        | Closed shadow root; clicks and hotkeys require `isTrusted`; hotkeys ignored while typing anywhere.                                                                                                                                                                                     |
| Page fakes the token (UI says A, URL says B) | The panel shows the on-chain symbol and the contract address with an explorer link; validator restricts every trade to that address.                                                                                                                                                   |
| Forged messages                              | zod schema per message; `sender.id`, top frame, https origin allowlist; content scripts limited to panel/trade requests (no unlock, no export, no settings).                                                                                                                           |
| Malicious token metadata                     | Labels stripped of control/bidi/zero-width characters and capped; rendered as text only (ESLint bans `innerHTML` & co.).                                                                                                                                                               |
| Bad calldata (bug or tampering)              | Validator above; simulation before signing (default on).                                                                                                                                                                                                                               |
| Sandwich attacks (Ethereum, BSC)             | Sends go through a private RPC by default (Flashbots Protect, PancakeSwap MEV Guard); the panel shows "MEV: unprotected" whenever they would reach the public mempool.                                                                                                                 |
| Fee mistakes and spikes                      | Gas is outside the USD trade limits, so the expected fee (simulated gas × base fee + tip) is checked against a separate gas limit (default $10) before anything is signed.                                                                                                             |
| Unlimited approvals                          | Spender limited to Permit2 or allowlisted routers/curves. Unlimited by default (one approval per token, for speed); can be switched to holdings × (1 + headroom). Permit2 permits exactly per sell.                                                                                    |
| Lost/stolen device, idle browser             | Argon2id (~500 ms, params bound in AES-GCM AAD); auto-lock; lock on browser close; unlock throttling.                                                                                                                                                                                  |
| Exported key lingering                       | Export only in the popup, password re-entry, clipboard blanked after 30 s by an offscreen document.                                                                                                                                                                                    |
| Telemetry / logs                             | None. `no-console` is an ESLint error.                                                                                                                                                                                                                                                 |
| Supply chain                                 | Exact-pinned deps, pnpm minimum release age respected, unminified build, MV3 CSP without remote code (`wasm-unsafe-eval` only for Argon2id).                                                                                                                                           |
| Privacy                                      | The DEX Screener pool index sees token lookups and its image CDN sees which logos you load (both toggles in Settings). Public RPCs see your addresses; use your own RPC to avoid that.                                                                                                 |
| Malicious logo images                        | Fetched by the background only, PNG/JPEG/WebP only (no SVG), ≤ 200 KB, must decode as an image, shown as a `data:` URL in an `<img>`.                                                                                                                                                  |
| Bridge (Relay) returns a bad transaction     | Only Relay's depository contract (same address on all chains) and only `depositNative(depositor, id)` are accepted; depositor must be you, value must equal your amount, the quoted recipient must be your chosen wallet. Then the normal validator and simulation run.                |

**Residual risks.** A page can overlay its own UI to trick you into clicking the
panel (clickjacking); limits cap the damage. Pool-derived USD prices could be skewed in
very thin markets. Receipt tracking stops if the browser closes; check the explorer.

## Known limitations

- KyberSwap (all five chains) is quoted alongside Celera's own routes and used when no
  listed pool can trade a token (other quote tokens, tokenised stocks, unlisted DEXes) or
  when it pays at least 0.5% more. In the second case its buy is first simulated: if it
  delivers less than Celera's own pool would (the API can misjudge a pool on its route),
  KyberSwap is dropped for that token for 10 minutes. Token tax is always measured on
  Celera's own pools, never on a KyberSwap route. Its swap description is decoded and checked (output to
  your wallet, a minimum, no extra fees, no embedded permits), sells approve exactly the
  amount sold, and it adds one API round trip at click time. It can be turned off in
  Settings; holdings are never valued through it. Both legs of a stablecoin route use the same DEX, so a token
  whose only stable pool is on a DEX without a native/stable pool there is not reached.
  On Uniswap the native/stable leg is a v3 pool.
- Curves quoted in an ERC-20 the launchpad cannot buy with native (Virtuals in VIRTUAL,
  Flap curves without native swap such as PEPE quotes, Pons curves in USDG) are funded
  through the best native ↔ asset pool. Until the Celera Router (`contracts/`) is
  audited and deployed on a chain, a buy is three transactions (native → asset,
  approval once, curve buy) and a sell ends with asset → native; with it, each is one
  transaction. four.meme tokens quoted in BEP-20 use four.meme's own helper and are
  always one transaction. Flaunch coins (paired with flETH) are one transaction through
  Uniswap v4.
- Not yet supported: Trench (unverified contracts), Printr, Livo, long.xyz pools before migration,
  o1.exchange, stonks, Pools.trade auctions, Aerodrome Slipstream, PancakeSwap Infinity,
  other Robinhood DEXes (Metric, Ramses, …).
- Tax tokens: quotes ignore the tax; raise slippage (20 % or 40 % in the panel) for them. Universal Router
  v3/v4 paths may fail for fee-on-transfer tokens; PancakeSwap v2 / Aerodrome handle them.
- Speed-up / cancel only for transactions sent in the current browser session.
- Bridge: native assets only. Delivery on the destination chain is done by Relay's
  solver; Celera can check the deposit, not the fill, so you trust Relay for that leg
  (its status is tracked, and Relay refunds failed fills).
- Token logos load only for tokens DEX Screener has an image for; others get a letter.

## Development

| Command          | What                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`     | typecheck, lint, unit tests, production build                                                                                                                                                         |
| `pnpm test`      | unit tests (vault, validator incl. fuzz, adapters, codec helpers, fees, nonces, format)                                                                                                               |
| `pnpm test:live` | read-only mainnet tests: token resolution, and buy → approve → sell simulations via `eth_simulateV1` for every venue and launchpad on every chain, with a throwaway key and a fake balance (no funds) |
| `pnpm dev`       | WXT dev mode with reload                                                                                                                                                                              |

## Dependencies

| Package                                                                               | Why                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `wxt` (dev)                                                                           | MV3 build: entrypoints, manifest, Vite                           |
| `preact`, `@preact/signals`                                                           | Small UI runtime                                                 |
| `viem`                                                                                | ABI encode/decode, RPC, signing, HD keys                         |
| `@scure/bip39`                                                                        | Mnemonic validation and seed derivation (same version viem uses) |
| `hash-wasm`                                                                           | Argon2id                                                         |
| `zod`                                                                                 | Runtime validation of messages, config and storage               |
| `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `vitest` (dev) | Tooling                                                          |

Out of scope: Solana, limit/DCA/TP-SL, Chrome Web Store publishing.
