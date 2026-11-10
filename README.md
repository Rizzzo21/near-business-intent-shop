# INTENT-SHOP - AI-native autonomous merchant with NEAR Intents cross-chain checkout, auto-procurement, and policy-constrained treasury split

## 1. Problem Solved
AI merchant agents need to sell services across chains via NEAR Intents, automatically restock upstream compute/data inventory when stock drops below a threshold, and split net profit under strict human-configured safety rails (max COGS ratio and reserve floor). The human sets the policy once; the agent executes inside it — and any purchase that would break the policy is refused on-chain, with the rule named.

## 2. Try It ('Do X -> See Y' Deterministic Steps)
Prerequisite: **Node.js 20+** (tested on Node v24.22.1). No install needed for the demo and tests — they use the Node.js standard library only.
```bash
npm test
node scripts/demo.mjs
bash docs/verify.sh
```
1. **`sale`**: Customer settles cross-chain NEAR Intent (`eip155:8453:USDC -> near:USDC`, 1,000 USDC) for 10 API-Audit packs -> order fulfilled, gross revenue = 1,000 USDC, inventory 15 -> 5 units. A replay of the same intent is REFUSED (`intent_already_settled`).
2. **`procurement`**: Inventory (5) <= reorder point (6) triggers autonomous procurement of 20 upstream units at 18 USDC/unit (360 USDC total, COGS ratio 36% <= human max 45%) -> inventory = 25 units, operating cash = 1,640 USDC
3. **`treasury_split`**: closeEpoch() enforces 1,000 USDC reserve floor and splits 640 USDC distributable profit -> 70% (448 USDC) to human owner vault, 20% (128 USDC) to growth pool, 10% (64 USDC) to agent compute gas buffer
4. **`negative_path`**: Agent attempts procurement of 20 units at 30 USDC/unit (600 USDC COGS against 1,000 USDC epoch gross = 60% > human max 45%) -> REFUSED on-chain (`cogs_cap_exceeded`); inventory and cash unchanged (25 units, 1,000 USDC)

Final Merkle State Head: `3c95832ed89c18420b17c3099faba4436a55a2cd7e0c4785fb5f8b7206d32294`

Every figure above is computed from the scenario inputs in `src/engine.mjs` (integer micro-USDC, BigInt math) — change an input and every downstream number changes with it. The tests in `test/engine.test.mjs` pin all of them.

## 3. Mechanical Mapping to NEAR Protocol Contracts
Maps 1:1 to a NEAR Intents (`verifier.near`) receiver contract implementing `mt_on_transfer`, automated solver procurement intents, and human-governed constraint checks (`assert!(cogs_bps <= policy.max_cogs_bps)`). The on-chain contract in `contract/src/index.js` is that receiver in miniature: `sale()` verifies gross = qty x SKU price and records the intent hash; `procure()` enforces the COGS cap, the reorder trigger, and the cash check; `close_epoch()` enforces the reserve floor and the 70/20/10 split.

## 4. On-Chain Evidence (NEAR testnet)
The same flow was executed against a minimal shop contract deployed to NEAR testnet. Contract: [`ishop-backstop-1109.testnet`](https://explorer.testnet.near.org/accounts/ishop-backstop-1109.testnet) (WASM sha256 `60980cc141e8476bb943184eeed9de07a49495b832509c6cbbecba2ec2ab6b15`).

| Step | Tx hash | Explorer |
|---|---|---|
| Deploy | `F3t2USEAjTmUX9XweZicYmowixktuVoTYJPk7gguWiwp` | https://explorer.testnet.near.org/transactions/F3t2USEAjTmUX9XweZicYmowixktuVoTYJPk7gguWiwp |
| Sale | `2fSvebo2RpnQmQDExHKmjYo2KbBdG9hJ5HMShbhcg5bG` | https://explorer.testnet.near.org/transactions/2fSvebo2RpnQmQDExHKmjYo2KbBdG9hJ5HMShbhcg5bG |
| Procurement | `74JnTEMRajC96Viu981VK5DjrRcbSLdSTthqGThF7v6X` | https://explorer.testnet.near.org/transactions/74JnTEMRajC96Viu981VK5DjrRcbSLdSTthqGThF7v6X |
| Treasury split | `5whUGNBbkHYpAzFtQ9vWkRFRD3QyXKfvrmpE4GY1tG18` | https://explorer.testnet.near.org/transactions/5whUGNBbkHYpAzFtQ9vWkRFRD3QyXKfvrmpE4GY1tG18 |
| Negative path (REFUSED: `cogs_cap_exceeded`) | `B5RDxDt96DKdvHoHwQez1WjuzFdimYvwipnmNToKoT86` | https://explorer.testnet.near.org/transactions/B5RDxDt96DKdvHoHwQez1WjuzFdimYvwipnmNToKoT86 |
| Intent replay (REFUSED: `intent_already_settled`) | `9QuQM2ckomJcjkCkH9Bj4CL8FNw1gtTHoyH5o4HdJ5NS` | https://explorer.testnet.near.org/transactions/9QuQM2ckomJcjkCkH9Bj4CL8FNw1gtTHoyH5o4HdJ5NS |

Intent hash (identical off-chain and on-chain): `439301c2f23a1d6e252e0ccb7b413213513b70c9bf1903916d19fb790443b020`

Final on-chain state: inventory 25 units, operating cash 1,000.00 USDC, owner vault 448.00 USDC, growth pool 128.00 USDC, gas buffer 64.00 USDC, 1 settled intent. Full evidence (including the refusal receipts): `docs/testnet-evidence.json`. All six tx hashes were verified live via testnet RPC `tx` queries. The refusal txs were captured from a prover account (`ishop-prover-1109.testnet`) because the deployer key is intentionally never stored — both refusals are caller-independent.

## 5. Deploy to Testnet (reproduce the on-chain evidence)
```bash
# 1. Build the contract (near-sdk-js; needs its postinstall deps — if the
#    sandbox postinstall fails, extract the three release archives into
#    node_modules/near-sdk-js/lib/cli/deps/ as in the DeFi backstop).
#    NOTE: build from the contract/ directory (the CLI resolves deps
#    relative to CWD):
cd contract && ln -s ../node_modules node_modules
../node_modules/.bin/near-sdk-js build src/index.js build/contract.wasm
cd .. && rm contract/node_modules

# 2. Deploy + run the flow (needs near-api-js; the deployer key is
#    generated in memory and never written to disk; the free testnet
#    faucet funds the throwaway account — no real money, testnet only).
node scripts/deploy-testnet.mjs [your-account.testnet]

# 3. Re-capture the refusal tx hashes from a prover account (the deploy
#    script's refusal capture relies on the thrown error carrying the
#    hash; near-api-js v5 throws a parsed error without it, so this
#    script replays both refusals with returnError: true and verifies
#    each hash live via RPC before writing it to the evidence file).
node scripts/capture-refusals.mjs
```

## 6. Plain Disclosure
- **Zero External Dependencies** for the demo and tests: Node.js standard library (`node:crypto`, `node:test`, `node:assert`, `node:fs`) only. The contract build and deploy scripts use `near-sdk-js` / `near-api-js` as dev tooling.
- **No Secrets or Network Calls** in the demo and tests: deterministic offline verification (`bash docs/verify.sh` -> `ALL CHECKS PASSED`).
- **Stub solver, honestly**: the on-chain `sale()` verifies the gross math and records the intent hash so it cannot settle twice, but it does **not** call `intents.near` `execute_intents` — there is no public testnet deployment of the Intents verifier stack (it lives on mainnet), so a testnet demo cannot settle a real intent. A production solver would submit the signed intent + token diff to `intents.near`. The Base-to-NEAR USDC settlement claim is therefore re-scoped to what was actually executed: the intent hash is computed, recorded, and replay-protected on-chain, while the ledger amounts are micro-USDC accounting units and the on-chain value moved is testnet NEAR for gas/storage only.
- **Shared Utility Harness Disclosure**: The SHA-256 hash-chain verification harness (`DeterministicStateMachine`) and `docs/verify.sh` layout are shared across our 7 NEAR Contest Build track entries (`bnty_0422`, `bnty_0420`, `bnty_0419`, `bnty_0417`, `bnty_0416`, `bnty_0412`, `bnty_0411`), while each track's step specifications, domain invariants, and state transitions are tailored to that track.

## Links
- NEAR Intents docs: https://docs.near.org/chain-abstraction/intents
- NEAR testnet explorer: https://explorer.testnet.near.org
- NEAR testnet faucet / wallet: https://wallet.testnet.near.org
- NEP-141 (fungible tokens): https://nomicon.io/Standards/Tokens/FungibleToken
- NEAR docs (contracts): https://docs.near.org/build/smart-contracts/what-is
- Demo screenshot (real `node scripts/demo.mjs` output): `docs/demo-screenshot.png`
- Architecture diagram: `docs/architecture.svg`
