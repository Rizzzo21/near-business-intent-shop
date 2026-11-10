#!/usr/bin/env bash
set -euo pipefail
node --test test/engine.test.mjs
out1="$(node scripts/demo.mjs)"
out2="$(node scripts/demo.mjs)"
if [ "$out1" != "$out2" ]; then
  echo "Determinism check failed"
  exit 1
fi
if [ -f docs/testnet-evidence.json ]; then
  node --input-type=module -e "
import fs from 'node:fs';
import { runScenario } from './src/engine.mjs';
const ev = JSON.parse(fs.readFileSync('docs/testnet-evidence.json', 'utf8'));
const s = runScenario();
if (ev.intent_hash !== s.intentHash) { console.error('evidence intent hash mismatch'); process.exit(1); }
for (const k of ['deploy', 'sale', 'procure', 'close_epoch']) {
  if (!ev.flow[k] || !ev.flow[k].tx) { console.error('evidence missing tx for ' + k); process.exit(1); }
}
for (const k of ['negative_refused', 'replay_refused']) {
  if (!ev.flow[k] || !ev.flow[k].tx) { console.error('evidence missing refusal tx for ' + k); process.exit(1); }
}
console.log('evidence sanity check passed (intent hash matches demo, all 6 tx hashes present)');
"
fi
echo "ALL CHECKS PASSED"
