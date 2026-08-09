'use strict';

/**
 * battleKillPriceService.js — Phase 1 Commit 3
 * ---------------------------------------------------------------------------
 * Pure function that owns the /api/battle/kill-price mutation.
 *
 * Flow (owner directive 2026-08-10):
 *   Battle UI
 *     → /api/battle/kill-price
 *     → 기존 가격결정/validation (competitor-crash pre-check preserved)
 *     → PriceExecutionGate (MANUAL_APPROVED context)
 *     → eBay
 *     → event/audit
 *     → confirmed listing state sync
 *
 * The route MUST NOT touch ebay.updateItem or ebay_products.update directly
 * anymore. All marketplace + state-sync goes through the gate.
 *
 * Extracted from api.js:2181 so it can be unit-tested with mocks and so
 * "grep 'ebay.updateItem' src/web/routes/api.js" cannot silently
 * reintroduce a bypass.
 */

const priceExecutionGate = require('./priceExecutionGate');

const CRASH_THRESHOLD_PCT = 50;

/**
 * @param {object} req      the sanitised body — { itemId, newPrice, sku, requestId? }
 * @param {object} ctx      execution context — { userId, actor }
 * @param {object} deps     dependency injection (all optional; production defaults)
 * @param {object} [deps.db]                 Supabase client (getClient)
 * @param {function} [deps.gateExecute]      override for the gate's executePriceWrite
 *   — tests can pass a stub so no real Supabase / eBay is required.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   httpStatus: number,
 *   body: object,
 *   marketplaceCalls: number  // for test assertion; 0 unless the gate ran the eBay stub
 * }>}
 *   The route wrapper does `res.status(r.httpStatus).json(r.body)`.
 */
async function executeBattleKillPrice(req, ctx = {}, deps = {}) {
  const { itemId, newPrice, sku } = req;

  // ── 1. Primitive request validation (unchanged from legacy route) ──────
  if (!itemId || newPrice == null) {
    return { ok: false, httpStatus: 400, body: { error: 'itemId와 newPrice 필수' }, marketplaceCalls: 0 };
  }
  const price = parseFloat(newPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, httpStatus: 400, body: { error: 'newPrice 는 양수여야 합니다' }, marketplaceCalls: 0 };
  }

  // ── 2. Legacy competitor-crash pre-check ────────────────────────────────
  //    Preserved from the original route so the existing UX (경쟁사 -50%
  //    폭락이면 따라가지 마세요) stays intact. This runs BEFORE the gate so
  //    the gate never even sees the request.
  if (sku) {
    const db = deps.db || require('../db/supabaseClient').getClient();
    try {
      const { data: comps } = await db.from('competitor_prices')
        .select('competitor_price, prev_price, status, competitor_id')
        .eq('sku', sku)
        .neq('competitor_id', '')
        .order('competitor_price', { ascending: true });

      const activeComps = (comps || []).filter(c => c.status !== 'ended' && c.competitor_id);
      if (activeComps.length === 0 && comps && comps.length > 0) {
        // eslint-disable-next-line no-console
        console.log('[kill-price] Warning: all competitors ended for', sku);
      }
      const cheapest = activeComps[0];
      if (cheapest && cheapest.prev_price && cheapest.competitor_price) {
        const drop = (cheapest.prev_price - cheapest.competitor_price) / cheapest.prev_price * 100;
        if (drop >= CRASH_THRESHOLD_PCT) {
          return {
            ok: false, httpStatus: 200, marketplaceCalls: 0,
            body: {
              success: false,
              error: `경쟁사 가격이 ${drop.toFixed(0)}% 폭락 — 비정상 가격, 따라가지 마세요 (이전: $${cheapest.prev_price}, 현재: $${cheapest.competitor_price})`,
            },
          };
        }
      }
    } catch (e) {
      // Crash pre-check is best-effort — do not block the gate on read failure.
      // eslint-disable-next-line no-console
      console.warn('[kill-price] competitor pre-check failed:', e.message);
    }
  }

  // ── 3. Look up old price for the audit event (best-effort) ─────────────
  let oldPrice = null;
  try {
    const db = deps.db || require('../db/supabaseClient').getClient();
    const { data: ep } = await db.from('ebay_products')
      .select('price_usd')
      .eq('item_id', String(itemId))
      .maybeSingle();
    if (ep && ep.price_usd != null) oldPrice = Number(ep.price_usd);
  } catch { /* audit-only lookup */ }

  // ── 4. Idempotency key ───────────────────────────────────────────────────
  //    Client can pass its own requestId (recommended, for retries).
  //    Otherwise we derive one from the mutation shape so accidental
  //    double-clicks within the same second still dedupe.
  const requestId = req.requestId || defaultRequestId({ sku, itemId, price, userId: ctx.userId });

  // ── 5. Gate — the ONLY path to eBay ─────────────────────────────────────
  const gateFn = deps.gateExecute || priceExecutionGate.executePriceWrite;
  const outcome = await gateFn(
    {
      sku: sku || `unknown-sku-${itemId}`,
      itemId: String(itemId),
      oldPrice,
      newPrice: price,
      reasonCode: 'AUTO_UNDERCUT_SAFE',    // battle button = undercut intent
      requestId,
      context: 'MANUAL_APPROVED',
      actor: ctx.actor || (ctx.userId != null ? `user:${ctx.userId}` : 'system'),
      currency: 'USD',
    },
    deps.gateDeps || {},
  );

  // ── 6. Map gate outcome → HTTP response (shape kept close to legacy) ────
  const marketplaceCalls = countMarketplaceCalls(outcome);
  if (outcome.outcome === priceExecutionGate.OUTCOME.APPLIED) {
    return {
      ok: true, httpStatus: 200, marketplaceCalls,
      body: {
        success: true,
        itemId,
        newPrice: price,
        runId: outcome.runId,
        eventId: outcome.eventId,
        stateSyncError: outcome.stateSyncError || null,
      },
    };
  }
  if (outcome.outcome === priceExecutionGate.OUTCOME.IDEMPOTENT_REPLAY) {
    return {
      ok: outcome.reasonCode === 'PRIOR_SUCCESS',
      httpStatus: 200, marketplaceCalls,
      body: {
        success: outcome.reasonCode === 'PRIOR_SUCCESS',
        idempotent: true,
        priorRunId: outcome.priorRunId,
        priorReason: outcome.reasonCode,
        error: outcome.error || null,
      },
    };
  }
  if (outcome.outcome === priceExecutionGate.OUTCOME.FAILED) {
    return {
      ok: false, httpStatus: 200, marketplaceCalls,
      body: {
        success: false,
        error: outcome.error || 'marketplace failed',
        runId: outcome.runId,
        eventId: outcome.eventId,
      },
    };
  }
  // BLOCKED
  return {
    ok: false, httpStatus: 200, marketplaceCalls,
    body: {
      success: false,
      blocked: true,
      reason: outcome.reasonCode,
      runId: outcome.runId,
      eventId: outcome.eventId,
      error: outcome.error || null,
    },
  };
}

function defaultRequestId({ sku, itemId, price, userId }) {
  const bucket = Math.floor(Date.now() / 1000); // 1-second bucket for double-click dedupe
  return `battle-kill:${userId || 'anon'}:${sku || 'nosku'}:${itemId}:${price.toFixed(2)}:${bucket}`;
}

/** Test helper — only APPLIED / FAILED touched the marketplace at all.
 *  BLOCKED means the gate never called eBay. IDEMPOTENT_REPLAY reuses a
 *  prior outcome and never calls eBay in this invocation. */
function countMarketplaceCalls(outcome) {
  if (outcome.outcome === priceExecutionGate.OUTCOME.APPLIED) return 1;
  if (outcome.outcome === priceExecutionGate.OUTCOME.FAILED) return 1;
  return 0;
}

module.exports = {
  executeBattleKillPrice,
  CRASH_THRESHOLD_PCT,
  // exported for tests
  _internal: { defaultRequestId, countMarketplaceCalls },
};
