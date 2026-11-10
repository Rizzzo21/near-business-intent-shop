import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeterministicStateMachine, TRACK_CODE, BOUNTY_ID, runScenario } from '../src/engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const machine = new DeterministicStateMachine();
const snap = machine.runAllTryItSteps();
const scenario = runScenario();

const lines = [
  `=== ${TRACK_CODE} (${BOUNTY_ID}) DETERMINISTIC DEMO TRANSCRIPT ===`,
  `Chain Integrity Verified: ${snap.chainVerified}`,
  `Final State Merkle Head:  ${snap.headHash}`,
  `Intent Hash:              ${scenario.intentHash}`,
  '',
];

for (const ev of snap.events) {
  lines.push(`[STEP ${ev.index + 1}] ${ev.step}`);
  lines.push(`  Summary: ${ev.payload.summary}`);
  lines.push(`  Metrics: ${JSON.stringify(ev.payload.metrics)}`);
  lines.push(`  Hash:    ${ev.hash}`);
  lines.push('');
}

// On-chain evidence, when the testnet deploy has been run (see
// scripts/deploy-testnet.mjs). Figures above are computed off-chain by the
// model; the tx hashes below are the same flow executed on NEAR testnet.
const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
if (fs.existsSync(evidencePath)) {
  const ev = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  lines.push('=== ON-CHAIN EVIDENCE (NEAR testnet) ===');
  lines.push(`Contract: ${ev.contract_account}`);
  lines.push(`Intent hash: ${ev.intent_hash}`);
  lines.push(`Deploy:   ${ev.flow.deploy.tx}`);
  lines.push(`Sale:     ${ev.flow.sale.tx}`);
  lines.push(`Procure:  ${ev.flow.procure.tx}`);
  lines.push(`Split:    ${ev.flow.close_epoch.tx}`);
  lines.push(`Negative: ${ev.flow.negative_refused.tx || '(pending)'} (REFUSED: cogs_cap_exceeded)`);
  lines.push(`Replay:   ${ev.flow.replay_refused.tx || '(pending)'} (REFUSED: intent_already_settled)`);
  lines.push(`Final inventory on-chain: ${ev.final_state.inventory_units} units`);
  lines.push(`Final operating cash on-chain: ${ev.verified_figures.operating_cash_usdc} USDC`);
  lines.push(`Explorer: ${ev.contract_explorer}`);
  lines.push('');
}

const transcript = lines.join('\n');
fs.writeFileSync(path.join(rootDir, 'docs', 'demo-transcript.txt'), transcript, 'utf8');
fs.writeFileSync(path.join(rootDir, 'docs', 'demo-trace.json'), JSON.stringify(snap, null, 2) + '\n', 'utf8');
process.stdout.write(transcript);
