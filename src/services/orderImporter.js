/**
 * src/services/orderImporter.js — mock JSON 주문 import orchestration (Phase 2)
 *
 * 역할:
 *   admin 이 POST 한 mock order JSON 을 받아서:
 *     1. validation (marketplace / external_order_id / lines)
 *     2. 중복 주문 사전 조회 → DuplicateOrderError
 *     3. raw_payload / buyer_contact 의 redact 적용
 *     4. wms_orders insert
 *     5. wms_order_lines bulk insert
 *     6. 각 line 에 대해 skuMatcher.matchOrderLine 실행
 *     7. matched / failed 결과 wms_order_lines update
 *     8. failed line 별 SKU_MATCH_FAILED 자동 카드 생성 (line당 1카드, import당 50개 상한)
 *     9. 50개 초과 시 SKU_MATCH_FAILED_BATCH_OVERFLOW 요약 카드 1개
 *    10. summary 반환
 *
 * Phase 2 의도된 미구현:
 *   - title fuzzy
 *   - 외부 마켓 API 연동
 *   - jobs polling worker
 */
'use strict';

const wmsRepo = require('../db/wmsOrderRepository');
const skuMatcher = require('./skuMatcher');
const { createExceptionTask } = require('./exceptionTask');
const { redact } = require('../lib/redact');

const FAILED_CARD_CAP = 50;

const VALID_MARKETPLACES = new Set([
  'ebay', 'shopify', 'naver', 'shopee', 'alibaba', 'coupang', 'qoo10',
]);

const VALID_ORDER_STATUS = new Set([
  'pending', 'paid', 'ready_to_ship', 'shipped', 'cancelled', 'refunded',
]);

// ── helpers ───────────────────────────────────────────────

function trimOrNull(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function parseNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseIntPositive(v, fallback = 1) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'VALIDATION_ERROR';
  }
}

/**
 * payload validation. 통과 시 정규화된 객체 반환, 실패 시 ValidationError throw.
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ValidationError('payload 가 객체가 아닙니다');
  }

  const marketplace = trimOrNull(payload.marketplace, 50);
  const externalOrderId = trimOrNull(payload.external_order_id, 200);

  if (!marketplace) throw new ValidationError('marketplace 필수');
  if (!VALID_MARKETPLACES.has(marketplace)) {
    throw new ValidationError(`marketplace 부적합 (허용: ${[...VALID_MARKETPLACES].join(',')})`);
  }
  if (!externalOrderId) throw new ValidationError('external_order_id 필수');

  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length === 0) throw new ValidationError('lines 가 비어있습니다');

  const orderStatusRaw = payload.order_status;
  const orderStatus = orderStatusRaw && VALID_ORDER_STATUS.has(orderStatusRaw)
    ? orderStatusRaw : 'pending';

  // line 정규화
  const seenLineIds = new Set();
  const normalizedLines = lines.map((l, idx) => {
    if (!l || typeof l !== 'object') {
      throw new ValidationError(`lines[${idx}] 가 객체가 아닙니다`);
    }
    const externalLineId = trimOrNull(l.external_line_id, 200);
    if (!externalLineId) {
      throw new ValidationError(`lines[${idx}].external_line_id 필수`);
    }
    if (seenLineIds.has(externalLineId)) {
      throw new ValidationError(`lines[${idx}].external_line_id 중복: ${externalLineId}`);
    }
    seenLineIds.add(externalLineId);

    return {
      external_line_id: externalLineId,
      marketplace_sku:  trimOrNull(l.marketplace_sku, 200),
      listing_id:       trimOrNull(l.listing_id, 200),
      option_id:        trimOrNull(l.option_id, 200),
      title:            trimOrNull(l.title, 500),
      quantity:         parseIntPositive(l.quantity, 1),
      unit_price:       parseNumOrNull(l.unit_price),
      currency:         trimOrNull(l.currency, 10),
      raw_payload:      l.raw_payload && typeof l.raw_payload === 'object'
                          ? redact(l.raw_payload)
                          : (typeof l === 'object' ? redact(l) : null),
    };
  });

  return {
    marketplace,
    external_order_id: externalOrderId,
    order_status: orderStatus,
    buyer_name:    trimOrNull(payload.buyer_name, 200),  // PR 2: nullable, 마스킹은 redact 가 처리
    buyer_country: trimOrNull(payload.buyer_country, 10),
    buyer_contact: payload.buyer_contact && typeof payload.buyer_contact === 'object'
                     ? redact(payload.buyer_contact)
                     : null,
    ordered_at:    payload.ordered_at || null,
    total_amount:  parseNumOrNull(payload.total_amount),
    currency:      trimOrNull(payload.currency, 10),
    lines: normalizedLines,
  };
}

/**
 * SKU_MATCH_FAILED 자동 카드 1건의 context 빌드.
 * PII / secret / 원본 buyer_email 등은 포함하지 않음.
 */
function buildFailedLineContext({ marketplace, order, line, matchResult }) {
  return {
    marketplace,
    external_order_id: order.external_order_id,
    external_line_id:  line.external_line_id,
    title:             line.title || null,
    marketplace_sku:   line.marketplace_sku || null,
    listing_id:        line.listing_id || null,
    option_id:         line.option_id || null,
    quantity:          line.quantity,
    buyer_country:     order.buyer_country || null,
    match_reason:      matchResult.match_reason || null,
  };
}

/**
 * mock JSON 주문을 import.
 *
 * @param {Object} payload — { marketplace, external_order_id, lines, ... }
 * @param {Object} options — { createdBy: <admin user.id> }
 *
 * @returns Promise<{
 *   order: <wms_orders row>,
 *   lines: [<wms_order_lines row>],
 *   totals: { line_count, matched_count, failed_count, cards_created, overflow_card_created },
 * }>
 *
 * Throws:
 *   ValidationError (400)
 *   wmsRepo.DuplicateOrderError (409)
 *   기타 (500)
 */
async function importMockOrder(payload, options = {}) {
  const createdBy = Number.isFinite(options.createdBy) ? Number(options.createdBy) : null;
  if (createdBy === null) {
    throw new ValidationError('createdBy (admin user.id) 가 필요합니다');
  }

  const normalized = validatePayload(payload);

  // 중복 사전 조회
  const existing = await wmsRepo.getWmsOrderByMarketplaceExternalId(
    normalized.marketplace, normalized.external_order_id,
  );
  if (existing) {
    throw new wmsRepo.DuplicateOrderError(
      normalized.marketplace, normalized.external_order_id, existing,
    );
  }

  // wms_orders insert (raw_payload redact)
  const safeRawPayload = redact({
    marketplace:       normalized.marketplace,
    external_order_id: normalized.external_order_id,
    order_status:      normalized.order_status,
    ordered_at:        normalized.ordered_at,
    total_amount:      normalized.total_amount,
    currency:          normalized.currency,
    buyer_name:        normalized.buyer_name,
    buyer_country:     normalized.buyer_country,
    buyer_contact:     normalized.buyer_contact,
    lines_count:       normalized.lines.length,
  });

  const order = await wmsRepo.createWmsOrder({
    marketplace:       normalized.marketplace,
    external_order_id: normalized.external_order_id,
    order_status:      normalized.order_status,
    buyer_name:        normalized.buyer_name,
    buyer_country:     normalized.buyer_country,
    buyer_contact:     normalized.buyer_contact,
    ordered_at:        normalized.ordered_at,
    total_amount:      normalized.total_amount,
    currency:          normalized.currency,
    raw_payload:       safeRawPayload,
    import_source:     'mock',
    imported_by:       createdBy,
  });

  // wms_order_lines bulk insert (raw_payload 는 line 정규화 단계에서 redact 됨)
  const insertedLines = await wmsRepo.createWmsOrderLines(order.id, normalized.lines);

  // 매칭 + update + 자동 카드
  const matchedLines = [];
  const failedLineContexts = [];  // 50 초과 분 capped
  let cardsCreated = 0;

  for (const line of insertedLines) {
    let matchResult;
    try {
      matchResult = await skuMatcher.matchOrderLine(line, { marketplace: order.marketplace });
    } catch (e) {
      console.warn('[orderImporter] match error for line', line.id, '-', e.message);
      matchResult = {
        matched_sku_id:   null,
        match_status:     'failed',
        match_confidence: null,
        match_reason:     'matcher_error',
      };
    }

    const updated = await wmsRepo.updateWmsOrderLineMatch(line.id, matchResult);
    matchedLines.push(updated || { ...line, ...matchResult });

    if (matchResult.match_status === 'failed') {
      const ctx = buildFailedLineContext({
        marketplace: order.marketplace, order, line, matchResult,
      });

      if (cardsCreated < FAILED_CARD_CAP) {
        try {
          await createExceptionTask({
            exceptionType: 'SKU_MATCH_FAILED',
            severity: 'medium',
            context: ctx,
            dedupeKey: `sku_match_failed:${order.marketplace}:${order.external_order_id}:${line.external_line_id}`,
            relatedOrderId: order.id,
            createdBy,
          });
          cardsCreated++;
        } catch (e) {
          console.warn('[orderImporter] createExceptionTask failed for line', line.id, '-', e.message);
        }
      } else {
        failedLineContexts.push(ctx);
      }
    }
  }

  // 50 초과 분 → 요약 카드 1건
  let overflowCardCreated = false;
  if (failedLineContexts.length > 0) {
    try {
      await createExceptionTask({
        exceptionType: 'SKU_MATCH_FAILED_BATCH_OVERFLOW',
        severity: 'high',
        title: `[자동] import #${order.id} 처리 불가 (잔여 ${failedLineContexts.length}건)`,
        memo: `잔여 line ${failedLineContexts.length}건 수동 확인 필요`,
        context: {
          import_order_id: order.id,
          marketplace: order.marketplace,
          external_order_id: order.external_order_id,
          capped_count: failedLineContexts.length,
          total_failed_count: cardsCreated + failedLineContexts.length,
          sample_line_ids: failedLineContexts.slice(0, 5).map((c) => c.external_line_id),
        },
        dedupeKey: `sku_match_failed_overflow:${order.marketplace}:${order.external_order_id}`,
        relatedOrderId: order.id,
        createdBy,
      });
      overflowCardCreated = true;
    } catch (e) {
      console.warn('[orderImporter] overflow card creation failed:', e.message);
    }
  }

  const matchedCount = matchedLines.filter((l) => l.match_status && l.match_status.startsWith('matched_')).length;
  const failedCount  = matchedLines.filter((l) => l.match_status === 'failed').length;

  // 배송 무게 자동 계산 (Phase 3) — best-effort. 실패해도 import 자체는 성공으로 반환.
  // 마이그레이션 051/052 미적용 환경에서도 import 가 안 깨지도록 try/catch.
  let shipmentCalc = null;
  try {
    const shippingCalc = require('./shippingWeightCalculator');
    const result = await shippingCalc.calculateForOrder(order.id);
    shipmentCalc = {
      ok: result.ok,
      missing_sku_count: (result.missingSkus || []).length,
      recommended_carrier: result.shipment?.recommendedCarrier || null,
      chargeable_weight_g: result.shipment?.chargeableWeightG ?? null,
      error: result.error || null,
    };
  } catch (e) {
    console.warn('[orderImporter] shipping calc failed (마이그레이션 051/052 미적용?):', e.message);
    shipmentCalc = { ok: false, error: e.message };
  }

  return {
    order,
    lines: matchedLines,
    totals: {
      line_count:        matchedLines.length,
      matched_count:     matchedCount,
      failed_count:      failedCount,
      cards_created:     cardsCreated,
      overflow_card_created: overflowCardCreated,
      capped_line_count: failedLineContexts.length,
    },
    shipmentCalc,
  };
}

module.exports = {
  importMockOrder,
  ValidationError,
  FAILED_CARD_CAP,
};
