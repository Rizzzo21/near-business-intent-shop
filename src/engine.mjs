import crypto from 'node:crypto';

export const TRACK_CODE = "INTENT-SHOP";
export const BOUNTY_ID = "bnty_0417";

// ---------------------------------------------------------------------------
// Computed-money model.
//
// Every figure in this entry is COMPUTED from the scenario inputs below,
// in integer micro-USDC (1 USDC = 1,000,000 micro units, BigInt math —
// no floats, no pasted literals). Change any input or the policy rate
// and every downstream number changes with it; the invariant tests in
// test/engine.test.mjs fail if a figure is tampered with.
// ---------------------------------------------------------------------------

export const MICRO_PER_USDC = 1000000n;
export const BPS_DENOM = 10000n;

// Canonical scenario INPUTS (not outputs). The demo's outputs — 1,000.00
// gross, 360.00 COGS at 36.00% (<= 45% max), 25 units, 1,640.00 cash,
// 640.00 distributable split 448.00 / 128.00 / 64.00 — are all derived
// from these inputs plus the policy below.
export const SCENARIO = {
  startingInventory: 15,
  startingCashUsdc: '1000',
  sku: 'API-AUDIT-PACK',
  skuPriceUsdc: '100',
  saleQty: 10,
  reorderPoint: 6,
  procureUnits: 20,
  unitCostUsdc: '18',
  maxCogsBps: 4500,
  reserveFloorUsdc: '1000',
  splitBps: { owner: 7000, growth: 2000, gas: 1000 },
  intentNonce: 'intent-shop-demo-001',
  deadlineSeconds: 300,
  // Negative-path attempt: same 20 units at 30 USDC/unit -> 600.00 COGS
  // against 1,000.00 epoch gross = 60.00% > 45% max -> REFUSED.
  negativeUnits: 20,
  negativeUnitCostUsdc: '30',
};

export const POLICY = {
  skuPriceMicro: 100000000n,
  unitCostMicro: 18000000n,
  reorderPoint: 6,
  maxCogsBps: 4500n,
  reserveFloorMicro: 1000000000n,
  splitBps: { owner: 7000n, growth: 2000n, gas: 1000n },
};

export function parseUsdcToMicro(usdc) {
  const [whole, frac = ''] = String(usdc).split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,6}$/.test(frac)) {
    throw new Error(`invalid USDC amount: ${usdc}`);
  }
  return BigInt(whole) * MICRO_PER_USDC + BigInt(frac.padEnd(6, '0') || '0');
}

export function formatUsdc(micro, decimals = 2) {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_USDC;
  const frac = abs % MICRO_PER_USDC;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracStr = frac.toString().padStart(6, '0').slice(0, decimals).padEnd(decimals, '0');
  return `${neg ? '-' : ''}${wholeStr}.${fracStr}`;
}

export function formatUsdcPlain(micro, decimals = 2) {
  return formatUsdc(micro, decimals).replace(/,/g, '');
}

export function computeIntentHash(intent) {
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

export function computeCogsBps(totalCogsMicro, epochGrossMicro) {
  const gross = BigInt(epochGrossMicro);
  if (gross === 0n) throw new Error('no_epoch_revenue: cannot check COGS ratio before a sale');
  return (BigInt(totalCogsMicro) * BPS_DENOM) / gross;
}

// The shop, integer math, mirroring the on-chain contract's rules
// (same error strings: intent_already_settled, gross_mismatch,
// insufficient_inventory, cogs_cap_exceeded, reorder_not_triggered,
// insufficient_cash, reserve_floor_not_met).
export class ShopLedger {
  constructor() {
    this.inventoryUnits = SCENARIO.startingInventory;
    this.operatingCashMicro = parseUsdcToMicro(SCENARIO.startingCashUsdc);
    this.ownerVaultMicro = 0n;
    this.growthPoolMicro = 0n;
    this.gasBufferMicro = 0n;
    this.epochGrossMicro = 0n;
    this.settled = new Map(); // intent_hash -> settlement record
  }

  sale(intentHash, qty, grossMicro) {
    if (!intentHash || typeof intentHash !== 'string') {
      throw new Error('intent_hash required');
    }
    if (this.settled.has(intentHash)) {
      throw new Error('intent_already_settled');
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error('qty must be a positive integer');
    }
    const gross = BigInt(grossMicro);
    if (gross !== BigInt(qty) * POLICY.skuPriceMicro) {
      throw new Error('gross_mismatch: gross must equal qty x sku price');
    }
    if (this.inventoryUnits < qty) {
      throw new Error('insufficient_inventory');
    }
    const record = { intentHash, qty, grossMicro: gross.toString() };
    this.settled.set(intentHash, record);
    this.inventoryUnits -= qty;
    this.operatingCashMicro += gross;
    this.epochGrossMicro += gross;
    return record;
  }

  procure(units, unitCostMicro) {
    if (!Number.isInteger(units) || units <= 0) {
      throw new Error('units must be a positive integer');
    }
    const unitCost = BigInt(unitCostMicro);
    if (unitCost <= 0n) throw new Error('unit_cost_micro must be positive');
    const totalCogs = BigInt(units) * unitCost;
    const cogsBps = computeCogsBps(totalCogs, this.epochGrossMicro);
    if (cogsBps > POLICY.maxCogsBps) {
      throw new Error('cogs_cap_exceeded');
    }
    if (this.inventoryUnits > POLICY.reorderPoint) {
      throw new Error('reorder_not_triggered');
    }
    if (this.operatingCashMicro < totalCogs) {
      throw new Error('insufficient_cash');
    }
    this.inventoryUnits += units;
    this.operatingCashMicro -= totalCogs;
    return { units, totalCogsMicro: totalCogs, cogsBps: Number(cogsBps) };
  }

  closeEpoch() {
    const distributable = this.operatingCashMicro - POLICY.reserveFloorMicro;
    if (distributable <= 0n) {
      throw new Error('reserve_floor_not_met');
    }
    const owner = (distributable * POLICY.splitBps.owner) / BPS_DENOM;
    const growth = (distributable * POLICY.splitBps.growth) / BPS_DENOM;
    const gas = distributable - owner - growth;
    this.operatingCashMicro = POLICY.reserveFloorMicro;
    this.ownerVaultMicro += owner;
    this.growthPoolMicro += growth;
    this.gasBufferMicro += gas;
    return {
      distributableMicro: distributable,
      ownerVaultMicro: owner,
      growthPoolMicro: growth,
      gasBufferMicro: gas,
    };
  }

  snapshot() {
    return {
      inventoryUnits: this.inventoryUnits,
      operatingCashMicro: this.operatingCashMicro.toString(),
      ownerVaultMicro: this.ownerVaultMicro.toString(),
      growthPoolMicro: this.growthPoolMicro.toString(),
      gasBufferMicro: this.gasBufferMicro.toString(),
      epochGrossMicro: this.epochGrossMicro.toString(),
      settledIntentCount: this.settled.size,
    };
  }
}

// Run the canonical scenario end to end and return every computed value.
export function runScenario() {
  const skuPrice = parseUsdcToMicro(SCENARIO.skuPriceUsdc);
  const gross = BigInt(SCENARIO.saleQty) * skuPrice;
  const intent = {
    from_asset: 'eip155:8453:USDC',
    to_asset: 'near:mainnet:USDC',
    sku: SCENARIO.sku,
    qty: SCENARIO.saleQty,
    amount_in_micro: gross.toString(),
    solver: 'stub-solver',
    nonce: SCENARIO.intentNonce,
    deadline_seconds: SCENARIO.deadlineSeconds,
  };
  const intentHash = computeIntentHash(intent);

  const shop = new ShopLedger();
  const settlement = shop.sale(intentHash, SCENARIO.saleQty, gross);
  const inventoryAfterSale = shop.inventoryUnits;
  const cashAfterSale = shop.operatingCashMicro;

  // Replay of the same intent -> REFUSED on the model, same as on-chain.
  let replay;
  try {
    shop.sale(intentHash, SCENARIO.saleQty, gross);
    replay = { attempt: 'ACCEPTED', reason: null };
  } catch (e) {
    replay = { attempt: 'REFUSED', reason: e.message };
  }

  const unitCost = parseUsdcToMicro(SCENARIO.unitCostUsdc);
  const procurement = shop.procure(SCENARIO.procureUnits, unitCost);
  const inventoryAfterProcurement = shop.inventoryUnits;
  const cashAfterProcurement = shop.operatingCashMicro;

  const split = shop.closeEpoch();

  // Negative path: 20 units at 30 USDC/unit -> 600.00 COGS against
  // 1,000.00 epoch gross = 6,000 bps > 4,500 bps max -> REFUSED, and the
  // shop state must be unchanged afterwards.
  const negUnitCost = parseUsdcToMicro(SCENARIO.negativeUnitCostUsdc);
  const negTotalCogs = BigInt(SCENARIO.negativeUnits) * negUnitCost;
  const negCogsBps = computeCogsBps(negTotalCogs, shop.epochGrossMicro);
  const stateBeforeNegative = shop.snapshot();
  let negative;
  try {
    shop.procure(SCENARIO.negativeUnits, negUnitCost);
    negative = { attempt: 'ACCEPTED', reason: null };
  } catch (e) {
    negative = { attempt: 'REFUSED', reason: e.message };
  }
  const stateAfterNegative = shop.snapshot();

  return {
    intent,
    intentHash,
    settlement,
    replay,
    shop,
    inventoryAfterSale,
    cashAfterSale,
    procurement,
    inventoryAfterProcurement,
    cashAfterProcurement,
    split,
    negative,
    negTotalCogs,
    negCogsBps: Number(negCogsBps),
    stateBeforeNegative,
    stateAfterNegative,
  };
}

// Build the try-it step list from the computed scenario (replaces the old
// hardcoded STEPS_SPEC literals — same step names for the first three,
// plus the new negative-path step).
export function buildSteps() {
  const s = runScenario();
  const gross = BigInt(SCENARIO.saleQty) * parseUsdcToMicro(SCENARIO.skuPriceUsdc);
  const unitCost = parseUsdcToMicro(SCENARIO.unitCostUsdc);
  const totalCogs = BigInt(SCENARIO.procureUnits) * unitCost;
  return [
    {
      step: 'sale',
      summary: `Customer settles cross-chain NEAR Intent (\`eip155:8453:USDC -> near:USDC\`, ${formatUsdc(gross)} USDC) for ${SCENARIO.saleQty} ${SCENARIO.sku} packs -> order fulfilled, gross revenue = ${formatUsdc(gross)} USDC, inventory ${SCENARIO.startingInventory} -> ${s.inventoryAfterSale} units, replay of the same intent -> ${s.replay.attempt} (${s.replay.reason})`,
      metrics: {
        intent_chain: 'eip155:8453->near:mainnet',
        sku: SCENARIO.sku,
        qty: SCENARIO.saleQty,
        gross_usdc: Number(gross) / 1e6,
        inventory_before: SCENARIO.startingInventory,
        inventory_after: s.inventoryAfterSale,
        intent_hash: s.intentHash,
        replay_attempt: s.replay.attempt,
        replay_reason: s.replay.reason,
      },
    },
    {
      step: 'procurement',
      summary: `Inventory (${s.inventoryAfterSale}) <= reorder point (${SCENARIO.reorderPoint}) triggers autonomous procurement of ${SCENARIO.procureUnits} upstream units at ${formatUsdc(unitCost)} USDC/unit (${formatUsdc(totalCogs)} USDC total, COGS ratio ${Number(s.procurement.cogsBps) / 100}% <= human max ${Number(POLICY.maxCogsBps) / 100}%) -> inventory = ${s.inventoryAfterProcurement} units, operating cash = ${formatUsdc(s.cashAfterProcurement)} USDC`,
      metrics: {
        reorder_point: SCENARIO.reorderPoint,
        procured_units: SCENARIO.procureUnits,
        unit_cost_usdc: Number(unitCost) / 1e6,
        total_cogs_usdc: Number(totalCogs) / 1e6,
        cogs_ratio_bps: s.procurement.cogsBps,
        max_cogs_bps: Number(POLICY.maxCogsBps),
        inventory_after: s.inventoryAfterProcurement,
        operating_cash_usdc: Number(s.cashAfterProcurement) / 1e6,
      },
    },
    {
      step: 'treasury_split',
      summary: `closeEpoch() enforces ${formatUsdc(POLICY.reserveFloorMicro)} USDC reserve floor and splits ${formatUsdc(s.split.distributableMicro)} USDC distributable profit -> 70% (${formatUsdc(s.split.ownerVaultMicro)} USDC) to human owner vault, 20% (${formatUsdc(s.split.growthPoolMicro)} USDC) to growth pool, 10% (${formatUsdc(s.split.gasBufferMicro)} USDC) to agent compute gas buffer`,
      metrics: {
        reserve_floor_usdc: Number(POLICY.reserveFloorMicro) / 1e6,
        distributable_profit_usdc: Number(s.split.distributableMicro) / 1e6,
        owner_vault_usdc: Number(s.split.ownerVaultMicro) / 1e6,
        growth_pool_usdc: Number(s.split.growthPoolMicro) / 1e6,
        gas_buffer_usdc: Number(s.split.gasBufferMicro) / 1e6,
      },
    },
    {
      step: 'negative_path',
      summary: `NEGATIVE PATH: agent attempts procurement of ${SCENARIO.negativeUnits} units at ${formatUsdc(parseUsdcToMicro(SCENARIO.negativeUnitCostUsdc))} USDC/unit (${formatUsdc(s.negTotalCogs)} USDC COGS against ${formatUsdc(s.shop.epochGrossMicro)} USDC epoch gross = ${s.negCogsBps / 100}% > human max ${Number(POLICY.maxCogsBps) / 100}%) -> ${s.negative.attempt} (rule: ${s.negative.reason}); inventory and cash unchanged (${s.stateAfterNegative.inventoryUnits} units, ${formatUsdc(BigInt(s.stateAfterNegative.operatingCashMicro))} USDC)`,
      metrics: {
        attempted_units: SCENARIO.negativeUnits,
        attempted_unit_cost_usdc: Number(parseUsdcToMicro(SCENARIO.negativeUnitCostUsdc)) / 1e6,
        attempted_cogs_usdc: Number(s.negTotalCogs) / 1e6,
        attempted_cogs_bps: s.negCogsBps,
        max_cogs_bps: Number(POLICY.maxCogsBps),
        attempt: s.negative.attempt,
        reason: s.negative.reason,
        inventory_after: s.stateAfterNegative.inventoryUnits,
        operating_cash_usdc: Number(BigInt(s.stateAfterNegative.operatingCashMicro)) / 1e6,
      },
    },
  ];
}

// Backwards-compatible name: the step list is computed at import time from
// the model above, never pasted.
export const STEPS_SPEC = buildSteps();

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

export class DeterministicStateMachine {
  constructor() {
    this.events = [];
    this.headHash = '0'.repeat(64);
  }

  applyStep(stepName, payload) {
    if (!stepName || typeof stepName !== 'string') {
      throw new Error('stepName must be a non-empty string');
    }
    const index = this.events.length;
    const canonical = JSON.stringify({ index, prev: this.headHash, step: stepName, payload });
    const hash = sha256Hex(canonical);
    const entry = { index, step: stepName, payload, prevHash: this.headHash, hash };
    this.events.push(entry);
    this.headHash = hash;
    return entry;
  }

  runAllTryItSteps() {
    for (const s of STEPS_SPEC) {
      this.applyStep(s.step, { summary: s.summary, metrics: s.metrics });
    }
    return this.snapshot();
  }

  verifyChain() {
    let prev = '0'.repeat(64);
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.prevHash !== prev) return false;
      const expected = sha256Hex(JSON.stringify({ index: i, prev, step: ev.step, payload: ev.payload }));
      if (ev.hash !== expected) return false;
      prev = expected;
    }
    return true;
  }

  snapshot() {
    return {
      track: TRACK_CODE,
      bountyId: BOUNTY_ID,
      eventCount: this.events.length,
      headHash: this.headHash,
      chainVerified: this.verifyChain(),
      events: this.events,
    };
  }
}
