# Celera Router

A stateless executor that runs, in one transaction, the steps the Celera extension builds
for a trade that no single venue can do: for example native → VIRTUAL on Uniswap, then
a buy on a Virtuals curve with all of that VIRTUAL. It is deployed once per chain and never changes; support for
new pairs and launchpads lives in the extension (which builds the steps and validates
them), not in the contract.

**Status: draft. Not audited. Do not use with real funds until a third-party audit.**

## Interface

```solidity
function execute(
    Call[] calldata calls,   // target, value, data, balance injection, spender
    Input calldata input,    // Permit2 SignatureTransfer pull from msg.sender (sells)
    address tokenOut,        // token the caller receives (NATIVE for ether)
    uint256 minOut,          // measured as the caller's balance change
    address[] calldata sweep,// other tokens returned in full at the end
    uint256 deadline
) external payable returns (uint256 out);
```

- **Input.** Native input is `msg.value`. Token input is pulled from `msg.sender` only, with
  a Permit2 _SignatureTransfer_ (one-time, exact amount, spender = this router). The router
  never relies on allowances granted to itself.
- **Steps.** Each `Call` is executed in order. `value = type(uint256).max` sends the
  router's whole ether balance. A call may ask for the router's current balance of a
  token (or ether) to be written into its calldata at a given offset just before it runs
  (_balance injection_), so a step can spend exactly what the previous one produced.
- **Approvals.** A step whose venue pulls the injected token names it as `spender`: the
  router approves it for exactly the injected amount just before the call and resets the
  allowance to zero right after. Steps cannot call `approve` or `increaseAllowance`
  themselves, so no allowance on the router ever outlives the step that needed it.
- **Output.** At the end the router sends its whole balance of `tokenOut`, of every
  `sweep` token and of ether to `msg.sender`, then requires the caller's `tokenOut`
  balance to have grown by at least `minOut`. Measuring the caller's balance (not the
  router's) makes the check hold for fee-on-transfer tokens too.

## Threat model

| Threat                                                                 | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Using someone else's allowance (the classic executor exploit)          | Nobody approves the router. Calls whose selector is ERC-20 `transferFrom` are refused, and Permit2 cannot be called as a step. Token input comes only from `msg.sender` through a signature bound to this router. The selector block is a second line only: tokens with other allowance-spending functions (e.g. DAI's `move` / `pull`) are not covered, so an approval to the router must never be given (the extension never asks for one). |
| Re-entering the router from a step (token callbacks, malicious target) | Reentrancy lock around `execute`, held until the final transfers are done. Calls to the router itself are refused.                                                                                                                                                                                                                                                                                                                            |
| Funds left in the router after a transaction                           | Every execution ends by sending `tokenOut`, the `sweep` tokens and all ether to the caller. Anything still held (e.g. a token the extension forgot to sweep, or a donation) is not owned by anyone; no function can move it except a later `execute`, so the extension always sweeps every asset a route touches.                                                                                                                             |
| Allowances left on the router                                          | None can exist: steps may not call `approve` / `increaseAllowance`; the router itself approves a step's `spender` for exactly the injected amount, only for that call, and resets it to zero after. (An allowance left behind would let its holder take a later user's funds while they pass through the router, up to that user's slippage, as soon as any contract in that user's route called it.)                                         |
| Owner / upgrade abuse                                                  | None: no owner, no admin, no upgrade, no pause, no fee. Constructor only fixes the Permit2 address.                                                                                                                                                                                                                                                                                                                                           |
| Bad output (sandwich, wrong route, honeypot)                           | `minOut` checked on the caller's balance; `deadline`; the extension simulates the whole transaction and validates every step with its per-venue rules before signing.                                                                                                                                                                                                                                                                         |
| Malformed balance injection                                            | Offsets must fall inside the calldata after the 4-byte selector; otherwise the call reverts.                                                                                                                                                                                                                                                                                                                                                  |
| Ether sent to the router by others                                     | Ends up with the next caller; it is never at risk of being taken by a third party mid-transaction.                                                                                                                                                                                                                                                                                                                                            |

Out of scope (the caller's own instructions): steps the caller builds can send the
caller's own funds anywhere; that is what `minOut` and the extension's validator guard.

## Mainnet-fork tests

Each runs a real buy and sell through the router against mainnet state (public RPCs by
default; set `BASE_RPC_URL`, `BSC_RPC_URL`, `ROBINHOOD_RPC_URL` to use your own):

| Test                       | Route (one transaction each way)                                         |
| -------------------------- | ------------------------------------------------------------------------ |
| `VirtualsFork` (Base)      | ether ↔ VIRTUAL (Uniswap v3) + Virtuals curve; Permit2 replay is refused |
| `FlapForkTest` (BSC)       | BNB ↔ PEPE (PancakeSwap v2) + a Flap curve quoted in PEPE                |
| `PonsForkTest` (Robinhood) | ether ↔ USDG (Universal Router, v3) + a Pons curve quoted in USDG        |
| `FourMemeForkTest` (BSC)   | no router needed: four.meme's helper (USDT, USD1, tokenised stock)       |

What they showed:

- Flap curves whose portal swaps native into the quote itself (`nativeToQuoteSwapEnabled`)
  need no router; the others (e.g. PEPE quotes) do.
- four.meme's helper sells pull the tokens from `tx.origin`, so they must be sent by the
  wallet itself and can never run inside a router. Its BNB ↔ quote swaps are built in.
- The Universal Router can be a step without balance injection (`CONTRACT_BALANCE`
  amounts); selling into it means first handing it the asset with a `transfer`, since
  the router cannot sign Permit2.
- Venues use transient storage, so the fork tests execute as Cancun; the router itself
  is compiled for Shanghai and uses no newer opcodes.

The extension's own transactions are also simulated against mainnet with this compiled
router placed by a state override (`tests/live/celera-router.test.ts`, after
`forge build`).

## Static analysis

Slither 0.11.6 (`slither . --filter-paths "lib/|test/"`) and Aderyn 0.6.8
(`aderyn . --src src`; Linux/macOS only, run in a container on Windows). Neither reports
anything that needs a change; each finding and why:

| Finding                                                                                          | Why it is expected                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reentrancy-eth`, `reentrancy-events` (Slither); H-1 "state change after external call" (Aderyn) | The flagged write is `_lock = 1`, the lock being released at the end of `execute`. The lock is taken before the first external call and nothing else in the contract writes state; re-entering reverts (`test_cannotReenter`). |
| `reentrancy-balance` (Slither)                                                                   | Balances read before external calls on purpose: `before` / `out` measure the caller's balance change, and `_sendAll` sends what it just read.                                                                                  |
| `arbitrary-send-eth` (Slither)                                                                   | `_run` sends ether where the caller's own step says (the caller's own funds); `_sendAll` always pays `msg.sender`.                                                                                                             |
| `incorrect-equality` (Slither)                                                                   | `balance == 0` / `amount == 0` only skip an empty transfer; a donation just gets paid out.                                                                                                                                     |
| `calls-loop` (Slither); L-1 "loop contains revert" (Aderyn)                                      | Steps run in a loop and one failed step must revert the whole trade.                                                                                                                                                           |
| `timestamp`, `assembly`, `low-level-calls`, `naming-convention` (Slither)                        | Deadline check; bounds-checked injection write; low-level calls for steps and for tokens without return values; `PERMIT2` is an immutable named like a constant.                                                               |

These tools found no issue; a manual review did: the first draft let a step leave an
allowance behind on the router (see _Allowances left on the router_ above), fixed before
any deployment.

## Deploy (same address on every chain)

`script/DeployRouter.s.sol` deploys through the deterministic CREATE2 deployer
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with a fixed salt (`celera.router.v1`)
and Permit2 as the only constructor argument. The address depends on nothing else, so
it is the same on every chain:

| Item           | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| Router address | `0xfdf24705a48f08558a6eed9B72d24cF3Bbce07e5`                         |
| Init code hash | `0xc3fcef2ccfca158f60971ac264448068f0f9dd51e3eb03a44d95f80c988211e4` |

These hold only for the current source and `foundry.toml` settings. Any change (an audit
fix included) gives a new address: rerun `predict()` and use that one. The deployer and
Permit2 were checked present on Base, BSC and Robinhood Chain (dry runs, 2026-10-28;
about 1.46M gas per deploy).

```sh
cd contracts
forge script script/DeployRouter.s.sol --sig "predict()"    # address, no RPC
forge script script/DeployRouter.s.sol --rpc-url base       # dry run: checks + simulation
forge script script/DeployRouter.s.sol --rpc-url base --broadcast --interactives 1 --verify
```

`--rpc-url` takes the names in `foundry.toml` (`ethereum`, `base`, `bsc`, `robinhood`,
read from `ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `BSC_RPC_URL`, `ROBINHOOD_RPC_URL`). `--interactives 1` asks for the
deploying key in the terminal, so it never lands in a file or the shell history; use a
fresh wallet holding only gas. `--verify` needs the explorer's API key
(`ETHERSCAN_API_KEY`); Robinhood Chain's Blockscout takes `--verifier blockscout
--verifier-url https://robinhoodchain.blockscout.com/api/`. Running it again on a chain
where the router already exists does nothing. Afterwards, set `celeraRouter` to the
address for that chain in `src/shared/chains/definitions.ts`.

Deployed (2026-10-28, from the current source; **not audited, not enabled in the
extension**):

| Chain           | Deploy transaction                                                   |
| --------------- | -------------------------------------------------------------------- |
| Ethereum        | `0x9630e70efa99a81e216574b7bc9c58894d7da0b2af7ace8b2bd36ed0a90e632c` |
| Base            | `0x6841787e5989bc27131242149a2f9ac4e11d059745bae8182402b890ae365de0` |
| BNB Smart Chain | `0x60cf5314e46ae66ee20d2c9ce21bdc7c7c3a1e164d92cf7faf18342a14869312` |
| Robinhood Chain | `0xcf79007c8a05bea3268bc866c02c1e2101c39ea1f6e1a9d5aaa582f8d9551b2d` |

## Develop

```sh
cd contracts
forge install foundry-rs/forge-std@v1.17.0 --no-git
forge test --no-match-path "test/fork/*"   # unit and attack tests
forge test --match-path "test/fork/*"      # mainnet forks (Base, BSC, Robinhood)
```
