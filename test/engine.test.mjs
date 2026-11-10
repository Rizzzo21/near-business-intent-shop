import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeterministicStateMachine,
  STEPS_SPEC,
  sha256Hex,
  ShopLedger,
  POLICY,
  SCENARIO,
  runScenario,
  parseUsdcToMicro,
  computeCogsBps,
} from '../src/engine.mjs';

test('deterministic state machine executes all 4 try-it steps identically across runs', () => {
  const m1 = new DeterministicStateMachine().runAllTryItSteps();
  const m2 = new DeterministicStateMachine().runAllTryItSteps();
  assert.equal(m1.eventCount, 4);
  assert.equal(m1.chainVerified, true);
  assert.equal(m1.headHash, m2.headHash);
  assert.deepEqual(m1.events, m2.events);
});

test('tampering with any event payload invalidates hash chain verification', () => {
  const m = new DeterministicStateMachine();
  m.runAllTryItSteps();
  assert.equal(m.verifyChain(), true);
  m.events[1].payload = { summary: 'tampered', metrics: {} };
  assert.equal(m.verifyChain(), false);
});

test('rejects empty step names', () => {
  const m = new DeterministicStateMachine();
  assert.throws(() => m.applyStep('', {}), /stepName must be a non-empty string/);
});

test('each try-it step produces non-empty metrics and valid 64-hex SHA-256 digest', () => {
  const snap = new DeterministicStateMachine().runAllTryItSteps();
  for (let i = 0; i < STEPS_SPEC.length; i++) {
    assert.equal(snap.events[i].step, STEPS_SPEC[i].step);
    assert.match(snap.events[i].hash, /^[0-9a-f]{64}$/);
    assert.ok(Object.keys(snap.events[i].payload.metrics).length > 0);
  }
});

test('computed sale figures: 10 packs at 100 USDC = 1,000.00 gross, inventory 15 -> 5', () => {
  const s = runScenario();
  assert.equal(s.settlement.qty, 10);
  assert.equal(s.settlement.grossMicro, '1000000000');
  assert.equal(s.inventoryAfterSale, 5);
  assert.equal(s.cashAfterSale, 2000000000n); // 1,000 starting + 1,000 gross
  assert.equal(s.replay.attempt, 'REFUSED');
  assert.equal(s.replay.reason, 'intent_already_settled');
});

test('computed procurement figures: 20 units at 18 USDC = 360.00 COGS, 36.00% <= 45% max', () => {
  const s = runScenario();
  assert.equal(s.procurement.totalCogsMicro, 360000000n);
  assert.equal(s.procurement.cogsBps, 3600);
  assert.equal(s.inventoryAfterProcurement, 25);
  assert.equal(s.cashAfterProcurement, 1640000000n);
});

test('computed treasury split: 640.00 distributable -> 448.00 / 128.00 / 64.00, cash back to floor', () => {
  const s = runScenario();
  assert.equal(s.split.distributableMicro, 640000000n);
  assert.equal(s.split.ownerVaultMicro, 448000000n);
  assert.equal(s.split.growthPoolMicro, 128000000n);
  assert.equal(s.split.gasBufferMicro, 64000000n);
  assert.equal(s.shop.operatingCashMicro, 1000000000n);
});

test('negative path: 20 units at 30 USDC = 600.00 COGS, 60.00% > 45% max -> REFUSED, state unchanged', () => {
  const s = runScenario();
  assert.equal(s.negCogsBps, 6000);
  assert.equal(s.negative.attempt, 'REFUSED');
  assert.equal(s.negative.reason, 'cogs_cap_exceeded');
  assert.deepEqual(s.stateAfterNegative, s.stateBeforeNegative);
});

test('policy sensitivity control: a 30% max-COGS policy would refuse the real procurement too', () => {
  // The real procurement is 3,600 bps; under a 3,000 bps cap it must fail.
  assert.ok(computeCogsBps(360000000n, 1000000000n) > 3000n);
  assert.ok(computeCogsBps(360000000n, 1000000000n) <= POLICY.maxCogsBps);
});

test('wrong-gross control: a sale whose gross does not equal qty x price is refused', () => {
  const shop = new ShopLedger();
  assert.throws(
    () => shop.sale('hash-1', 10, 999000000n),
    /gross_mismatch/,
  );
});

test('insufficient inventory: selling 16 packs when only 15 are stocked is refused', () => {
  const shop = new ShopLedger();
  assert.throws(
    () => shop.sale('hash-2', 16, 1600000000n),
    /insufficient_inventory/,
  );
});

test('reserve floor: closing an epoch with cash at the floor is refused', () => {
  const shop = new ShopLedger();
  assert.throws(() => shop.closeEpoch(), /reserve_floor_not_met/);
});

test('reorder trigger: procurement above the reorder point is refused', () => {
  const shop = new ShopLedger();
  shop.sale('hash-3', 5, 500000000n); // inventory 15 -> 10, gross 500.00
  // 10 units at 18 USDC = 180.00 COGS against 500.00 gross = 36% <= 45%,
  // so the COGS gate passes and the refusal must come from the trigger.
  assert.throws(
    () => shop.procure(10, parseUsdcToMicro('18')),
    /reorder_not_triggered/,
  );
});
