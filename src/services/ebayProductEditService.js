'use strict';

/**
 * ebayProductEditService.js — Phase 1 Commit 4
 * ---------------------------------------------------------------------------
 * Owns the PUT /api/products/ebay/:itemId mutation. Extracted from the route
 * so it can be unit-tested and so a static grep audit can prove no direct
 * marketplace bypass survives.
 *
 * Semantics (owner directive 2026-08-10):
 *   - User types an arbitrary price and/or quantity into the edit UI.
 *     No system computation — human decides. Context = MANUAL_DIRECT.
 *   - MANUAL_DIRECT can waive auto_apply_enabled but NEVER waives
 *     kill_switch, valid itemId/SKU, finite/positive price, USD,
 *     idempotency, or marketplace-integrity.
 *   - PRICE mutations MUST go through PriceExecutionGate.
 *   - QUANTITY (stock) mutations stay on the legacy path — this phase is
 *     scoped to eBay PRICE safety only. Owner will refactor stock in a
 *     later phase.
 *   - When both are supplied and the price gate returns BLOCKED / FAILED,
 *     the quantity mutation is skipped too (edit intent failed as a whole).
 *   - RequestId is a UUID per request (client can override for retries).
 *     Owner-explicit rationale: two independent manual edits within one
 *     second must NOT be conflated as the same request.
 */

const crypto = require('node:crypto');
const priceExecutionGate = require('./priceExecutionGate');

/**
 * @param {object} req
 * @param {string} req.itemId          eBay listing item_id (URL param)
 * @param {number|string} [req.price]  new price (USD) — undefined = do not touch price
 * @param {number|string} [req.quantity] new stock — undefined = do not touch quantity
 * @param {string} [req.sku]           SKU passthrough for legacy products sync
 * @param {string} [req.requestId]     client-supplied idempotency key (optional)
 *
 * @param {object} ctx                 execution context — { userId, actor }
 *
 * @param {object} [deps]              dependency injection
 * @param {object} [deps.db]           Supabase client
 * @param {object} [deps.ebay]         eBay client with updateItem({itemId, opts})
 * @param {function} [deps.gateExecute] override for gate.executePriceWrite
 * @param {object} [deps.gateDeps]     deps forwarded to gate
 * @param {object} [deps.dataSource]   legacy products updater (updateProduct)
 * @param {function} [deps.uuid]       override crypto.randomUUID (tests)
 *
 * @returns {Promise<{
 *   ok: boolean, httpStatus: number, body: object,
 *   marketplaceCalls: number,        // total eBay API calls made
 *   priceMarketplaceCalls: number,   // subset via gate
 *   quantityMarketplaceCalls: number // subset via direct legacy path
 * }>}
 */
async function executeEbayProductEdit(req, ctx = {}, deps = {}) {
  const { itemId, sku } = req;

  // ── 1. Primitive validation (unchanged from legacy route behaviour) ────
  if (req.price === undefined && req.quantity === undefined) {
    return {
      ok: false, httpStatus: 400, marketplaceCalls: 0,
      priceMarketplaceCalls: 0, quantityMarketplaceCalls: 0,
      body: { error: '가격 또는 수량을 입력하세요' },
    };
  }
  if (!itemId || typeof itemId !== 'string' || itemId.trim() === '') {
    return {
      ok: false, httpStatus: 400, marketplaceCalls: 0,
      priceMarketplaceCalls: 0, quantityMarketplaceCalls: 0,
      body: { error: 'itemId 필수' },
    };
  }

  // Guarded parsing — MANUAL_DIRECT still enforces primitive data safety.
  let priceNum = null;
  if (req.price !== undefined) {
    priceNum = parseFloat(req.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return {
        ok: false, httpStatus: 400, marketplaceCalls: 0,
        priceMarketplaceCalls: 0, quantityMarketplaceCalls: 0,
        body: { error: 'price 는 양의 유한한 숫자여야 합니다' },
      };
    }
  }
  let qtyNum = null;
  if (req.quantity !== undefined) {
    qtyNum = parseInt(req.quantity, 10);
    if (!Number.isFinite(qtyNum) || qtyNum < 0) {
      return {
        ok: false, httpStatus: 400, marketplaceCalls: 0,
        priceMarketplaceCalls: 0, quantityMarketplaceCalls: 0,
        body: { error: 'quantity 는 0 이상 정수여야 합니다' },
      };
    }
  }

  const uuid = deps.uuid || crypto.randomUUID.bind(crypto);
  const actor = ctx.actor || (ctx.userId != null ? `user:${ctx.userId}` : 'system');

  const result = {
    ok: true, httpStatus: 200, marketplaceCalls: 0,
    priceMarketplaceCalls: 0, quantityMarketplaceCalls: 0,
    body: { success: true, platform: 'eBay', itemId, updates: {} },
  };

  // ── 2. PRICE mutation → PriceExecutionGate ──────────────────────────────
  //    Runs FIRST. If it BLOCK/FAIL we do not attempt the quantity leg —
  //    the edit intent has failed as a whole and a partial state is worse
  //    than no change.
  if (priceNum !== null) {
    const gateFn = deps.gateExecute || priceExecutionGate.executePriceWrite;
    const requestId = req.requestId || uuid();
    const outcome = await gateFn({
      sku: sku || `ebay-item-${itemId}`,
      itemId: String(itemId),
      oldPrice: null,      // audit-only lookup skipped for this endpoint
                           // (edit UI shows current price so operator already sees it)
      newPrice: priceNum,
      // MANUAL_DIRECT still needs an enum reason_code (priceEngine enum).
      // AUTO_UNDERCUT_SAFE is the closest existing value; the actor field
      // marks this as a human edit and price_events.event_type=PriceApplied
      // will still record it truthfully.
      reasonCode: 'AUTO_UNDERCUT_SAFE',
      requestId,
      context: 'MANUAL_DIRECT',
      actor,
      currency: 'USD',
    }, deps.gateDeps || {});

    result.priceMarketplaceCalls = countGateMarketplaceCalls(outcome);
    result.marketplaceCalls += result.priceMarketplaceCalls;
    result.body.updates.price = priceNum;
    result.body.priceOutcome = {
      outcome: outcome.outcome,
      reasonCode: outcome.reasonCode,
      runId: outcome.runId,
      eventId: outcome.eventId,
      stateSyncError: outcome.stateSyncError || null,
    };

    if (outcome.outcome === priceExecutionGate.OUTCOME.BLOCKED) {
      result.ok = false;
      result.body.success = false;
      result.body.blocked = true;
      result.body.reason = outcome.reasonCode;
      result.body.error = outcome.error || null;
      return result;
    }
    if (outcome.outcome === priceExecutionGate.OUTCOME.FAILED) {
      result.ok = false;
      result.body.success = false;
      result.body.error = outcome.error || 'marketplace failed';
      return result;
    }
    if (outcome.outcome === priceExecutionGate.OUTCOME.IDEMPOTENT_REPLAY) {
      result.ok = outcome.reasonCode === 'PRIOR_SUCCESS';
      result.body.success = outcome.reasonCode === 'PRIOR_SUCCESS';
      result.body.idempotent = true;
      result.body.priorReason = outcome.reasonCode;
      // Do NOT run the quantity leg on replay — the original request
      // already settled. Client that wants a fresh quantity edit must
      // send a new requestId or a separate call.
      return result;
    }
    // APPLIED → continue to optional quantity leg
  }

  // ── 3. QUANTITY mutation (legacy — this phase does not cover stock) ────
  if (qtyNum !== null) {
    // 2026-08-30 fix: 동일 broken conditional 이 이 파일에도 있었음
    //   (priceExecutionGate.js:194 참고). `||` 우선순위로 인해 `deps.ebay` 없으면
    //   getInstance 미정의 → 항상 falsy → deps.ebay = undefined → "no ebay client available".
    let ebay = deps.ebay;
    if (!ebay) {
      const EbayAPI = require('../api/ebayAPI');
      ebay = new EbayAPI();
    }
    if (!ebay || typeof ebay.updateItem !== 'function') {
      result.ok = false;
      result.body.success = false;
      result.body.error = 'no ebay client available';
      return result;
    }
    try {
      const qRes = await ebay.updateItem(String(itemId), { quantity: qtyNum });
      result.quantityMarketplaceCalls = 1;
      result.marketplaceCalls += 1;
      if (!qRes || qRes.success !== true) {
        result.ok = false;
        result.body.success = false;
        result.body.error = (qRes && qRes.error) || 'quantity update failed';
      } else {
        result.body.updates.quantity = qtyNum;
      }
    } catch (e) {
      result.quantityMarketplaceCalls = 1;
      result.marketplaceCalls += 1;
      result.ok = false;
      result.body.success = false;
      result.body.error = e.message;
      return result;
    }

    // Legacy quantity state sync (unchanged behaviour).
    if (result.body.updates.quantity !== undefined) {
      try {
        const db = deps.db || require('../db/supabaseClient').getClient();
        await db.from('ebay_products')
          .update({ stock: qtyNum, updated_at: new Date().toISOString() })
          .eq('item_id', String(itemId));
      } catch (e) {
        // best-effort — do not overturn the marketplace outcome
        // eslint-disable-next-line no-console
        console.warn('[ebayProductEdit] quantity local sync failed:', e.message);
      }
    }
  }

  // ── 4. Legacy products (dataSource.updateProduct) sync — best-effort ───
  //    Kept for legacy screens that still read products.price_usd.
  //    dataSource is optional — route can leave it out for tests.
  if (deps.dataSource && typeof deps.dataSource.updateProduct === 'function') {
    const dbUpdates = {};
    if (result.body.updates.price !== undefined) dbUpdates.priceUSD = result.body.updates.price;
    if (result.body.updates.quantity !== undefined) dbUpdates.stock = result.body.updates.quantity;
    if (Object.keys(dbUpdates).length > 0) {
      try {
        const dbRes = await deps.dataSource.updateProduct('itemId', itemId, dbUpdates, sku);
        result.body.dbSync = !!dbRes?.success;
      } catch (e) {
        result.body.dbSync = false;
        result.body.dbSyncError = e.message;
      }
    }
  }

  return result;
}

/** Only APPLIED / FAILED actually reached eBay in this gate call. */
function countGateMarketplaceCalls(outcome) {
  if (outcome.outcome === priceExecutionGate.OUTCOME.APPLIED) return 1;
  if (outcome.outcome === priceExecutionGate.OUTCOME.FAILED) return 1;
  return 0;
}

module.exports = {
  executeEbayProductEdit,
  _internal: { countGateMarketplaceCalls },
};
