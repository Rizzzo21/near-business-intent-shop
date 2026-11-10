// Re-capture the two refusal tx hashes with returnError: true, so the
// outcome object (and its real transaction_outcome.id) is returned
// instead of thrown. Uses a fresh throwaway prover account — both
// refusals are caller-independent (the COGS check fires before the
// reorder check; the intent hash is already settled).
//
// Usage (from intents-autonomous-shop/):
//   node scripts/capture-refusals.mjs
//
// Writes the real hashes into docs/testnet-evidence.json and verifies
// each one live via RPC tx queries before writing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nearApi from 'near-api-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const CONTRACT_ID = 'ishop-backstop-1109.testnet';
const PROVER_ID = 'ishop-prover-1109.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const HELPER_URL = 'https://helper.testnet.near.org';
const EXPLORER_TX = 'https://explorer.testnet.near.org/transactions/';

const INTENT_HASH = '439301c2f23a1d6e252e0ccb7b413213513b70c9bf1903916d19fb790443b020';

async function txStatus(hash, senderId) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tx', method: 'tx', params: [hash, senderId] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`RPC tx query failed for ${hash}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
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

  const keyPair = nearApi.KeyPair.fromRandom('ed25519');
  await keyStore.setKey('testnet', PROVER_ID, keyPair);
  console.log(`creating ${PROVER_ID} via faucet helper...`);
  const res = await fetch(`${HELPER_URL}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: PROVER_ID, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet helper ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const prover = await near.account(PROVER_ID);
  console.log('prover funded.');

  async function refusalCall(methodName, args, expectRule) {
    const outcome = await prover.signAndSendTransaction({
      receiverId: CONTRACT_ID,
      actions: [
        nearApi.transactions.functionCall(
          methodName,
          args,
          100_000_000_000_000n,
          0n,
        ),
      ],
      returnError: true,
    });
    const txHash = outcome.transaction_outcome.id;
    const failureJson = JSON.stringify(outcome.status);
    console.log(`${methodName}: tx=${txHash}`);
    console.log(`  status: ${failureJson.slice(0, 220)}`);
    if (!failureJson.includes(expectRule)) {
      throw new Error(`${methodName} did not refuse with ${expectRule}: ${failureJson.slice(0, 300)}`);
    }
    // Verify the hash resolves live via RPC before trusting it.
    const live = await txStatus(txHash, PROVER_ID);
    const liveMethod = live.transaction?.actions?.[0]?.FunctionCall?.method_name;
    if (liveMethod !== methodName) {
      throw new Error(`${methodName} tx ${txHash} resolves live as ${liveMethod}`);
    }
    console.log(`  verified live via RPC (method=${liveMethod})`);
    return { tx: txHash, explorer: EXPLORER_TX + txHash, error: failureJson.slice(0, 300) };
  }

  const negative = await refusalCall(
    'procure',
    { units: 20, unit_cost_micro: '30000000' },
    'cogs_cap_exceeded',
  );
  const replay = await refusalCall(
    'sale',
    { intent_hash: INTENT_HASH, qty: 10, gross_micro: '1000000000' },
    'intent_already_settled',
  );

  const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.flow.negative_refused = {
    ...evidence.flow.negative_refused,
    tx: negative.tx,
    explorer: negative.explorer,
    error: negative.error,
    prover_account: PROVER_ID,
  };
  evidence.flow.replay_refused = {
    ...evidence.flow.replay_refused,
    tx: replay.tx,
    explorer: replay.explorer,
    error: replay.error,
    prover_account: PROVER_ID,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log('evidence updated:', evidencePath);
  console.log('DONE.');
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
