// Deploy the INTENT-SHOP contract to NEAR testnet and run the full
// sale -> procure -> close_epoch flow, recording real tx hashes —
// plus the negative-path refusal (over-cap procurement) and the
// intent-replay refusal.
//
// Usage (from intents-autonomous-shop/):
//   npm install            # installs near-api-js (dev tooling)
//   node scripts/deploy-testnet.mjs [account-id]
//   # default account id: ishop-backstop-1109.testnet
//
// The deployer keypair is generated in memory in this process and NEVER
// written to disk or printed. The faucet funds the account; no real money
// is involved (testnet only). Evidence is written to
// docs/testnet-evidence.json (contract account, intent hash, tx hashes,
// explorer links) — that file contains NO private key.
//
// The intent JSON below is byte-identical (same keys, same order) to the
// one built by src/engine.mjs, so the on-chain intent hash matches the
// demo's intent hash exactly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as nearApi from 'near-api-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const ACCOUNT_ID = process.argv[2] || 'ishop-backstop-1109.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const HELPER_URL = 'https://helper.testnet.near.org';
const EXPLORER_TX = 'https://explorer.testnet.near.org/transactions/';
const EXPLORER_ACCT = 'https://explorer.testnet.near.org/accounts/';

// Canonical demo figures, in integer micro-USDC (1 USDC = 1,000,000).
const SALE_QTY = 10;
const GROSS_MICRO = '1000000000'; // 1,000.00 USDC
const PROCURE_UNITS = 20;
const UNIT_COST_MICRO = '18000000'; // 18.00 USDC
const NEG_UNITS = 20;
const NEG_UNIT_COST_MICRO = '30000000'; // 30.00 USDC -> 600.00 COGS, 60% > 45%

const fmt = (micro) => (Number(micro) / 1e6).toFixed(2);

async function callRefusal(account, methodName, args) {
  // Attempt a call that must be refused on-chain; return the tx hash
  // (parsed from the failure message) and the refusal reason.
  try {
    const outcome = await account.functionCall({
      contractId: ACCOUNT_ID,
      methodName,
      args,
      gas: 100_000_000_000_000n,
    });
    return {
      tx: outcome.transaction.hash,
      error: 'UNEXPECTED SUCCESS — the call was accepted',
    };
  } catch (e) {
    const msg = String(e.message || e);
    const m = msg.match(/([A-Za-z0-9]{43,44})/);
    return { tx: m ? m[1] : null, error: msg.slice(0, 300) };
  }
}

async function main() {
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const near = await nearApi.connect({
    networkId: 'testnet',
    nodeUrl: RPC_URL,
    walletUrl: 'https://wallet.testnet.near.org',
    helperUrl: HELPER_URL,
    keyStore,
  });

  // 1. Fresh throwaway testnet account, funded by the free faucet helper.
  const keyPair = nearApi.KeyPair.fromRandom('ed25519');
  await keyStore.setKey('testnet', ACCOUNT_ID, keyPair);
  console.log(`[1/8] creating ${ACCOUNT_ID} via faucet helper...`);
  const res = await fetch(`${HELPER_URL}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newAccountId: ACCOUNT_ID,
      newAccountPublicKey: keyPair.getPublicKey().toString(),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`faucet helper ${res.status}: ${body.slice(0, 500)}`);
  }
  const account = await near.account(ACCOUNT_ID);
  const state = await account.state();
  const balanceNear = Number(nearApi.utils.format.formatNearAmount(state.amount));
  console.log(`      funded. balance: ${balanceNear.toFixed(4)} NEAR`);
  if (balanceNear < 6) {
    throw new Error(
      `INSUFFICIENT FAUCET FUNDING: ${balanceNear} NEAR < ~6 NEAR needed to store the 535KB contract. ` +
        `Re-run with a different faucet or a pre-funded testnet account.`,
    );
  }

  // 2. Deploy the contract.
  const wasm = fs.readFileSync(path.join(rootDir, 'contract', 'build', 'contract.wasm'));
  console.log(`[2/8] deploying ${wasm.length} bytes to ${ACCOUNT_ID}...`);
  const deployOutcome = await account.deployContract(wasm);
  const deployTx = deployOutcome.transaction.hash;
  console.log(`      deploy tx: ${deployTx}`);

  // 3. Sale: settle the cross-chain checkout intent on-chain.
  const intent = {
    from_asset: 'eip155:8453:USDC',
    to_asset: 'near:mainnet:USDC',
    sku: 'API-AUDIT-PACK',
    qty: SALE_QTY,
    amount_in_micro: GROSS_MICRO,
    solver: 'stub-solver',
    nonce: 'intent-shop-demo-001',
    deadline_seconds: 300,
  };
  const intentHash = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  console.log(`[3/8] intent hash: ${intentHash}`);
  const saleOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'sale',
    args: { intent_hash: intentHash, qty: SALE_QTY, gross_micro: GROSS_MICRO },
    gas: 100_000_000_000_000n,
  });
  const saleTx = saleOutcome.transaction.hash;
  console.log(`      sale tx: ${saleTx} (inventory 15 -> 5, cash 1,000.00 -> 2,000.00)`);

  // 4. Procurement: inventory 5 <= reorder point 6, COGS 360.00 / 1,000.00
  // gross = 3,600 bps <= 4,500 bps max -> accepted.
  console.log('[4/8] procure 20 units at 18.00 USDC...');
  const procOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'procure',
    args: { units: PROCURE_UNITS, unit_cost_micro: UNIT_COST_MICRO },
    gas: 100_000_000_000_000n,
  });
  const procTx = procOutcome.transaction.hash;
  console.log(`      procure tx: ${procTx}`);
  const afterProcure = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'get_state',
    args: {},
  });
  console.log(`      state after procure: inventory=${afterProcure.inventory_units} cash=${fmt(afterProcure.operating_cash_micro)}`);
  if (afterProcure.inventory_units !== 25 || afterProcure.operating_cash_micro !== '1640000000') {
    throw new Error(`procure state mismatch: ${JSON.stringify(afterProcure)}`);
  }

  // 5. Treasury split: 1,640.00 - 1,000.00 floor = 640.00 distributable
  // -> 448.00 owner / 128.00 growth / 64.00 gas.
  console.log('[5/8] close_epoch (treasury split)...');
  const splitOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'close_epoch',
    args: {},
    gas: 100_000_000_000_000n,
  });
  const splitTx = splitOutcome.transaction.hash;
  console.log(`      split tx: ${splitTx}`);
  const afterSplit = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'get_state',
    args: {},
  });
  console.log(`      state after split: owner=${fmt(afterSplit.owner_vault_micro)} growth=${fmt(afterSplit.growth_pool_micro)} gas=${fmt(afterSplit.gas_buffer_micro)} cash=${fmt(afterSplit.operating_cash_micro)}`);
  if (
    afterSplit.owner_vault_micro !== '448000000' ||
    afterSplit.growth_pool_micro !== '128000000' ||
    afterSplit.gas_buffer_micro !== '64000000' ||
    afterSplit.operating_cash_micro !== '1000000000'
  ) {
    throw new Error(`split state mismatch: ${JSON.stringify(afterSplit)}`);
  }

  // 6. Negative path: 20 units at 30.00 USDC = 600.00 COGS against
  // 1,000.00 epoch gross = 6,000 bps > 4,500 bps max -> REFUSED.
  console.log('[6/8] negative path: procure 20 units at 30.00 USDC (must be REFUSED)...');
  const negative = await callRefusal(account, 'procure', {
    units: NEG_UNITS,
    unit_cost_micro: NEG_UNIT_COST_MICRO,
  });
  console.log(`      refused: ${negative.error.slice(0, 120)}`);
  if (!/cogs_cap_exceeded/.test(negative.error)) {
    throw new Error(`negative path refused with wrong reason: ${negative.error}`);
  }

  // 7. Replay the same intent -> REFUSED (intent_already_settled).
  console.log('[7/8] replay the same intent (must be REFUSED)...');
  const replay = await callRefusal(account, 'sale', {
    intent_hash: intentHash,
    qty: SALE_QTY,
    gross_micro: GROSS_MICRO,
  });
  console.log(`      refused: ${replay.error.slice(0, 120)}`);
  if (!/intent_already_settled/.test(replay.error)) {
    throw new Error(`replay refused with wrong reason: ${replay.error}`);
  }

  // 8. Final on-chain state + evidence file.
  const finalState = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'get_state',
    args: {},
  });
  console.log('[8/8] final state:', JSON.stringify(finalState));
  if (
    finalState.inventory_units !== 25 ||
    finalState.operating_cash_micro !== '1000000000' ||
    finalState.owner_vault_micro !== '448000000' ||
    finalState.growth_pool_micro !== '128000000' ||
    finalState.gas_buffer_micro !== '64000000' ||
    finalState.settled_intent_count !== 1
  ) {
    throw new Error(`final state mismatch: ${JSON.stringify(finalState)}`);
  }

  const evidence = {
    network: 'testnet',
    contract_account: ACCOUNT_ID,
    contract_explorer: EXPLORER_ACCT + ACCOUNT_ID,
    contract_wasm_sha256: crypto.createHash('sha256').update(wasm).digest('hex'),
    deployed_at_utc: new Date().toISOString(),
    intent,
    intent_hash: intentHash,
    flow: {
      deploy: { tx: deployTx, explorer: EXPLORER_TX + deployTx },
      sale: { tx: saleTx, explorer: EXPLORER_TX + saleTx, qty: SALE_QTY, gross_usdc: '1000.00' },
      procure: { tx: procTx, explorer: EXPLORER_TX + procTx, units: PROCURE_UNITS, unit_cost_usdc: '18.00', total_cogs_usdc: '360.00', cogs_bps: 3600 },
      close_epoch: { tx: splitTx, explorer: EXPLORER_TX + splitTx, distributable_usdc: '640.00', owner_vault_usdc: '448.00', growth_pool_usdc: '128.00', gas_buffer_usdc: '64.00' },
      negative_refused: { tx: negative.tx, explorer: negative.tx ? EXPLORER_TX + negative.tx : null, error: negative.error, attempted_units: NEG_UNITS, attempted_unit_cost_usdc: '30.00', attempted_cogs_bps: 6000, rule: 'cogs_cap_exceeded' },
      replay_refused: { tx: replay.tx, explorer: replay.tx ? EXPLORER_TX + replay.tx : null, error: replay.error },
    },
    final_state: finalState,
    verified_figures: {
      inventory_units: 25,
      operating_cash_usdc: fmt(finalState.operating_cash_micro),
      owner_vault_usdc: fmt(finalState.owner_vault_micro),
      growth_pool_usdc: fmt(finalState.growth_pool_micro),
      gas_buffer_usdc: fmt(finalState.gas_buffer_micro),
    },
    disclosure:
      'Stub solver: sale() verifies gross = qty x SKU price on-chain and records the intent hash so it cannot settle twice; it does not call intents.near execute_intents. Procurement and the treasury split are the shop policy logic executed on-chain. Ledger amounts are micro-USDC accounting units; on-chain value moved is testnet NEAR for gas/storage only.',
  };
  const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`evidence written: ${evidencePath}`);
  console.log('DONE. Contract:', ACCOUNT_ID);
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
