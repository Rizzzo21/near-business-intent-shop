// INTENT-SHOP on-chain contract (NEAR testnet).
// Minimal autonomous-merchant shop: cross-chain intent sale, policy-gated
// autonomous procurement, and reserve-floored treasury split.
// All money math is integer micro-USDC (1 USDC = 1,000,000 micro units),
// computed with BigInt and stored as decimal strings — no floats, no literals.
//
// Honest scope: this is a MINIMAL shop, not a production NEAR Intents
// merchant. The sale settles a signed intent hash: sale() verifies the
// gross equals qty x SKU price, the intent hash is unseen, and stock
// covers the order. It does NOT call intents.near execute_intents —
// there is no public testnet deployment of the Intents verifier stack
// (it lives on mainnet), so a testnet demo cannot settle a real intent.
// Procurement and the treasury split are the shop's own policy logic,
// executed and enforced on-chain (COGS cap, reorder trigger, reserve
// floor); the README says so.
import { NearBindgen, near, call, view } from 'near-sdk-js';

const SKU_PRICE_MICRO = 100000000n; // 100.00 USDC per API-AUDIT-PACK
const UNIT_COST_MICRO = 18000000n; // 18.00 USDC per upstream unit
const REORDER_POINT = 6; // procure only when inventory <= 6
const MAX_COGS_BPS = 4500n; // 45% human max COGS ratio
const RESERVE_FLOOR_MICRO = 1000000000n; // 1,000.00 USDC
const OWNER_SPLIT_BPS = 7000n; // 70% to human owner vault
const GROWTH_SPLIT_BPS = 2000n; // 20% to growth pool
const BPS_DENOM = 10000n;

@NearBindgen({})
class IntentShop {
  constructor() {
    this.inventory_units = 15;
    this.operating_cash_micro = '1000000000'; // 1,000.00 USDC starting cash
    this.owner_vault_micro = '0';
    this.growth_pool_micro = '0';
    this.gas_buffer_micro = '0';
    this.epoch_gross_micro = '0'; // gross revenue of the current epoch
    this.settled_intents = {}; // intent_hash -> settlement record
    this.flow_events = []; // append-only log of flow steps, capped at 50
  }

  _log(step, detail) {
    this.flow_events.push({ step, ...detail });
    if (this.flow_events.length > 50) this.flow_events.shift();
  }

  // ---- views ----

  @view({})
  get_policy({}) {
    return {
      sku_price_micro: SKU_PRICE_MICRO.toString(),
      unit_cost_micro: UNIT_COST_MICRO.toString(),
      reorder_point: REORDER_POINT,
      max_cogs_bps: Number(MAX_COGS_BPS),
      reserve_floor_micro: RESERVE_FLOOR_MICRO.toString(),
      split_bps: {
        owner: Number(OWNER_SPLIT_BPS),
        growth: Number(GROWTH_SPLIT_BPS),
        gas: Number(BPS_DENOM - OWNER_SPLIT_BPS - GROWTH_SPLIT_BPS),
      },
    };
  }

  @view({})
  get_state({}) {
    return {
      inventory_units: this.inventory_units,
      operating_cash_micro: this.operating_cash_micro,
      owner_vault_micro: this.owner_vault_micro,
      growth_pool_micro: this.growth_pool_micro,
      gas_buffer_micro: this.gas_buffer_micro,
      epoch_gross_micro: this.epoch_gross_micro,
      settled_intent_count: Object.keys(this.settled_intents).length,
    };
  }

  @view({})
  get_intent({ intent_hash }) {
    return this.settled_intents[intent_hash] || null;
  }

  @view({})
  get_events({}) {
    return this.flow_events;
  }

  // ---- calls ----

  // Settle a cross-chain checkout intent: customer paid gross_micro on
  // Base (eip155:8453:USDC) for qty packs; the shop fulfills from stock.
  @call({})
  sale({ intent_hash, qty, gross_micro }) {
    if (!intent_hash || typeof intent_hash !== 'string') {
      throw new Error('intent_hash required');
    }
    if (this.settled_intents[intent_hash]) {
      throw new Error('intent_already_settled');
    }
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('qty must be a positive integer');
    }
    const gross = BigInt(gross_micro);
    if (gross !== BigInt(quantity) * SKU_PRICE_MICRO) {
      throw new Error('gross_mismatch: gross must equal qty x sku price');
    }
    if (this.inventory_units < quantity) {
      throw new Error('insufficient_inventory');
    }
    this.settled_intents[intent_hash] = {
      qty: quantity,
      gross_micro: gross.toString(),
      settled_by: near.predecessorAccountId(),
    };
    this.inventory_units -= quantity;
    this.operating_cash_micro = (BigInt(this.operating_cash_micro) + gross).toString();
    this.epoch_gross_micro = (BigInt(this.epoch_gross_micro) + gross).toString();
    this._log('sale', { intent_hash, qty: quantity, gross_micro: gross.toString() });
    return {
      intent_hash,
      inventory_units: this.inventory_units,
      operating_cash_micro: this.operating_cash_micro,
    };
  }

  // Autonomous procurement: restock when inventory is at/below the
  // reorder point, gated by the human max-COGS policy. The COGS ratio is
  // checked FIRST, so an over-cap proposal is refused with the policy
  // rule named even when stock is high.
  @call({})
  procure({ units, unit_cost_micro }) {
    const quantity = Number(units);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('units must be a positive integer');
    }
    const unitCost = BigInt(unit_cost_micro);
    if (unitCost <= 0n) throw new Error('unit_cost_micro must be positive');
    const totalCogs = BigInt(quantity) * unitCost;
    const epochGross = BigInt(this.epoch_gross_micro);
    if (epochGross === 0n) {
      throw new Error('no_epoch_revenue: cannot check COGS ratio before a sale');
    }
    const cogsBps = (totalCogs * BPS_DENOM) / epochGross;
    if (cogsBps > MAX_COGS_BPS) {
      throw new Error('cogs_cap_exceeded');
    }
    if (this.inventory_units > REORDER_POINT) {
      throw new Error('reorder_not_triggered');
    }
    if (BigInt(this.operating_cash_micro) < totalCogs) {
      throw new Error('insufficient_cash');
    }
    this.inventory_units += quantity;
    this.operating_cash_micro = (BigInt(this.operating_cash_micro) - totalCogs).toString();
    this._log('procurement', {
      units: quantity,
      unit_cost_micro: unitCost.toString(),
      total_cogs_micro: totalCogs.toString(),
      cogs_bps: Number(cogsBps),
    });
    return {
      inventory_units: this.inventory_units,
      operating_cash_micro: this.operating_cash_micro,
      total_cogs_micro: totalCogs.toString(),
      cogs_bps: Number(cogsBps),
    };
  }

  // Close the epoch: enforce the reserve floor, then split the
  // distributable profit 70/20/10 (owner vault / growth pool / gas buffer).
  @call({})
  close_epoch({}) {
    const cash = BigInt(this.operating_cash_micro);
    const distributable = cash - RESERVE_FLOOR_MICRO;
    if (distributable <= 0n) {
      throw new Error('reserve_floor_not_met');
    }
    const owner = (distributable * OWNER_SPLIT_BPS) / BPS_DENOM;
    const growth = (distributable * GROWTH_SPLIT_BPS) / BPS_DENOM;
    const gas = distributable - owner - growth; // remainder to gas buffer
    this.operating_cash_micro = RESERVE_FLOOR_MICRO.toString();
    this.owner_vault_micro = (BigInt(this.owner_vault_micro) + owner).toString();
    this.growth_pool_micro = (BigInt(this.growth_pool_micro) + growth).toString();
    this.gas_buffer_micro = (BigInt(this.gas_buffer_micro) + gas).toString();
    this._log('treasury_split', {
      distributable_micro: distributable.toString(),
      owner_vault_micro: owner.toString(),
      growth_pool_micro: growth.toString(),
      gas_buffer_micro: gas.toString(),
    });
    return {
      distributable_micro: distributable.toString(),
      owner_vault_micro: owner.toString(),
      growth_pool_micro: growth.toString(),
      gas_buffer_micro: gas.toString(),
      operating_cash_micro: this.operating_cash_micro,
    };
  }
}
