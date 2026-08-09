'use strict';

/**
 * retirementActionService.js — Phase 1 Commit 5D
 * ---------------------------------------------------------------------------
 * Extracted from /api/sku-scores/retirement/execute so the price-mutation
 * branch can go through PriceExecutionGate and be independently unit-tested.
 *
 * Only the price_increase_5pct action is a marketplace mutation. The other
 * actions (deactivate, margin_review) just set flags and are left untouched.
 *
 * Owner directive (2026-08-10):
 *   - The +5% number is a system-computed value; user clicks the action
 *     button = human approval → context = MANUAL_APPROVED.
 *   - MANUAL_APPROVED waives auto_apply_enabled only; kill_switch, valid
 *     price, currency, idempotency, marketplace-integrity all still apply.
 *   - Existing +5% math must be preserved verbatim.
 */

const priceExecutionGate = require('./priceExecutionGate');

/**
 * Deterministic idempotency key. Same day + same SKU + same intended price
 * → same key → gate short-circuits duplicate execution.
 */
function _retirementRequestId({ sku, itemId, newPrice, dateStr }) {
  return `retirement:price_increase_5pct:${dateStr}:${sku}:${itemId}:${Number(newPrice).toFixed(2)}`;
}

/**
 * Execute one retirement action for one SKU.
 *
 * @param {object} req              { sku, action, currentPrice, ebayItemId }
 * @param {object} ctx              { userId, actor, dateStr? }
 * @param {object} [deps]           { gateExecute, gateDeps }
 *
 * @returns {Promise<{
 *   sku, action, success, oldPrice?, newPrice?, error?, note?,
 *   marketplaceCalls: number, runId?, eventId?
 * }>}
 */
async function executeRetirementAction(req, ctx = {}, deps = {}) {
  const { sku, action } = req;
  const result = { sku, action, success: false, marketplaceCalls: 0 };

  if (!sku || !action) {
    result.error = 'sku와 action은 필수입니다';
    return result;
  }

  if (action === 'deactivate') {
    result.success = true;
    result.note = '비활성화 플래그 설정됨 - 플랫폼별 수동 처리 필요';
    return result;
  }
  if (action === 'margin_review') {
    result.success = true;
    result.note = '마진 검토 플래그 설정됨';
    return result;
  }

  if (action !== 'price_increase_5pct') {
    result.error = `unsupported action: ${action}`;
    return result;
  }

  // ── price_increase_5pct branch ─────────────────────────────────────────
  const currentPrice = parseFloat(req.currentPrice) || 0;
  if (!(currentPrice > 0)) {
    result.error = '현재 가격 정보 없음';
    return result;
  }
  // Preserve the original +5% math exactly.
  const newPrice = +(currentPrice * 1.05).toFixed(2);

  const ebayItemId = req.ebayItemId;
  if (!ebayItemId) {
    result.error = 'eBay Item ID 없음';
    return result;
  }

  const dateStr = ctx.dateStr || new Date().toISOString().slice(0, 10);
  const requestId = req.requestId || _retirementRequestId({ sku, itemId: ebayItemId, newPrice, dateStr });

  const gateFn = deps.gateExecute || priceExecutionGate.executePriceWrite;
  const outcome = await gateFn({
    sku,
    itemId: String(ebayItemId),
    oldPrice: currentPrice,
    newPrice,
    reasonCode: 'AUTO_UNDERCUT_SAFE',   // enum-only; the retirement business
                                        // meaning is carried by actor/source.
    requestId,
    context: 'MANUAL_APPROVED',
    actor: ctx.actor || (ctx.userId != null ? `user:${ctx.userId}` : 'system:retirement'),
    currency: 'USD',
  }, deps.gateDeps || {});

  // Marketplace call count comes from the gate outcome
  if (outcome.outcome === priceExecutionGate.OUTCOME.APPLIED ||
      outcome.outcome === priceExecutionGate.OUTCOME.FAILED) {
    result.marketplaceCalls = 1;
  }

  result.runId = outcome.runId;
  result.eventId = outcome.eventId;
  result.gateOutcome = outcome.outcome;
  result.oldPrice = currentPrice;
  result.newPrice = newPrice;

  if (outcome.outcome === priceExecutionGate.OUTCOME.APPLIED) {
    result.success = true;
  } else if (outcome.outcome === priceExecutionGate.OUTCOME.IDEMPOTENT_REPLAY) {
    result.success = outcome.reasonCode === 'PRIOR_SUCCESS';
    result.note = `idempotent replay (${outcome.reasonCode})`;
  } else if (outcome.outcome === priceExecutionGate.OUTCOME.BLOCKED) {
    result.success = false;
    result.error = `blocked by gate: ${outcome.reasonCode}`;
    result.blocked = true;
  } else if (outcome.outcome === priceExecutionGate.OUTCOME.FAILED) {
    result.success = false;
    result.error = outcome.error || 'marketplace failed';
  }

  return result;
}

module.exports = {
  executeRetirementAction,
  _internal: { _retirementRequestId },
};
