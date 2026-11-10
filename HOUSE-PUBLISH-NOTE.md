# House publish note — NEAR Business (INTENT-SHOP)

This tree is the house backstop polish for the NEAR Business entry. It was prepared by
the house (not by a bounty hunter) as a fallback in case no hunter claims the polish
bounty.

## Source
- Upstream: `duongynhi000005-oss/near-agent-economy-contest-builds` @ `5cb1e77`,
  subdirectory `intents-autonomous-shop/`
- Polish: house backstop, 2026-11-09 (evening PST) / 2026-11-10 UTC. No bounty claimed,
  nothing pushed before this staging.
- Polish bounty: **bnty_0566** — still OPEN, hunter None, listing expires Nov 11, 5:05 PM
  PST. This backstop is the fallback if no hunter lands by expiry; if a hunter claims
  and submits, judge theirs on merit.

## Verification (house, live, Nov 9)
- Source note: `BACKSTOP_SUMMARY.md` (house backstop bundle), testnet evidence verified
  live via testnet RPC `tx` queries.
- Re-verified in this staging: `npm test` 13/13 PASS, `bash docs/verify.sh` ALL CHECKS
  PASSED (2026-11-10, Node v24.22.1).
- `node_modules/` (regenerable tooling) was stripped from this tree before publishing.

## Testnet evidence (NEAR testnet)
- Contract: **ishop-backstop-1109.testnet**
  https://explorer.testnet.near.org/accounts/ishop-backstop-1109.testnet
- Intent hash (identical off-chain and on-chain):
  `439301c2f23a1d6e252e0ccb7b413213513b70c9bf1903916d19fb790443b020`
- Transactions (all six verified live):
  - Deploy: `F3t2USEAjTmUX9XweZicYmowixktuVoTYJPk7gguWiwp`
  - Sale (10 packs, 1,000.00 USDC): `2fSvebo2RpnQmQDExHKmjYo2KbBdG9hJ5HMShbhcg5bG`
  - Procurement (20 @ 18.00, COGS 360.00, 3,600 bps): `74JnTEMRajC96Viu981VK5DjrRcbSLdSTthqGThF7v6X`
  - Treasury split (640.00 → 448.00 / 128.00 / 64.00): `5whUGNBbkHYpAzFtQ9vWkRFRD3QyXKfvrmpE4GY1tG18`
  - Negative path (REFUSED, cogs_cap_exceeded): `B5RDxDt96DKdvHoHwQez1WjuzFdimYvwipnmNToKoT86`
  - Intent replay (REFUSED, intent_already_settled): `9QuQM2ckomJcjkCkH9Bj4CL8FNw1gtTHoyH5o4HdJ5NS`
- Final on-chain state: inventory 25 units, operating cash 1,000.00 USDC, owner vault
  448.00 USDC, growth pool 128.00 USDC, gas buffer 64.00 USDC, 1 settled intent.

## Honest caveats (from this tree's README §6, Plain Disclosure)
- **Stub solver, honestly:** the on-chain `sale()` verifies the gross math and records
  the intent hash so it cannot settle twice, but it does **not** call `intents.near`
  `execute_intents` — there is no public testnet deployment of the Intents verifier
  stack (it lives on mainnet), so a testnet demo cannot settle a real intent. A
  production solver would submit the signed intent + token diff to `intents.near`.
- **Base-to-NEAR USDC settlement is re-scoped to what was actually executed:** the intent
  hash is computed, recorded, and replay-protected on-chain, while the ledger amounts
  are micro-USDC accounting units and the on-chain value moved is testnet NEAR for
  gas/storage only.
