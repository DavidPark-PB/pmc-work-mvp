/**
 * src/services/skuMatcher.js — order_line ↔ sku_master 매칭 (Phase 2)
 *
 * 매칭 순서 (보수적 — fuzzy 자동 확정 금지):
 *   A. sku_listing_link exact   (marketplace + listing_id + option_id IS NOT DISTINCT FROM)
 *   B. sku_listing_link.marketplace_sku
 *   C. sku_master.internal_sku  (line.marketplace_sku = sku_master.internal_sku)
 *   D. failed
 *
 * Phase 2 미구현 (금지):
 *   - title fuzzy / Levenshtein / embedding / string similarity
 *   - AI / LLM 호출
 *
 * 입력: line = { marketplace_sku, listing_id, option_id }
 *       options = { marketplace }      ← 호출자가 wms_orders.marketplace 전달
 *
 * 출력: { matched_sku_id, match_status, match_confidence, match_reason }
 *
 * match_reason 코드 (varchar(64) 호환 짧은 enum):
 *   - link_exact
 *   - marketplace_sku
 *   - internal_sku
 *   - ambiguous_marketplace_sku
 *   - no_match
 */
'use strict';

const { getClient } = require('../db/supabaseClient');

/**
 * sku_listing_link 에서 (marketplace, listing_id, option_id) 정확 매칭.
 * option_id 가 NULL 인 경우 NULL 끼리 일치.
 */
async function matchByLink({ marketplace, listingId, optionId }) {
  if (!marketplace || !listingId) return null;
  const c = getClient();

  // option_id 비교: PostgREST 는 IS NOT DISTINCT FROM 직접 미지원 →
  // optionId 가 null 이면 .is('option_id', null), 아니면 .eq('option_id', value)
  let q = c.from('sku_listing_link')
    .select('sku_id')
    .eq('marketplace', marketplace)
    .eq('listing_id', listingId);

  q = (optionId === null || optionId === undefined)
    ? q.is('option_id', null)
    : q.eq('option_id', optionId);

  const { data, error } = await q.limit(2);
  if (error) throw error;
  // 038 의 UNIQUE (marketplace, listing_id, option_id) 가 1대1 보장 — 단 안전 장치로 length 체크
  if (!data || data.length === 0) return null;
  if (data.length > 1) return null;  // 비정상 (UNIQUE 위반) — 매칭 보류
  return data[0].sku_id;
}

/**
 * sku_listing_link 에서 (marketplace, marketplace_sku) 매칭.
 * 복수 매칭 시 ambiguous 로 보고 null + ambiguous flag.
 */
async function matchByMarketplaceSku({ marketplace, marketplaceSku }) {
  if (!marketplace || !marketplaceSku) return { skuId: null, ambiguous: false };
  const { data, error } = await getClient()
    .from('sku_listing_link')
    .select('sku_id')
    .eq('marketplace', marketplace)
    .eq('marketplace_sku', marketplaceSku)
    .limit(5);
  if (error) throw error;
  if (!data || data.length === 0) return { skuId: null, ambiguous: false };

  const uniqueSkuIds = [...new Set(data.map((r) => r.sku_id))];
  if (uniqueSkuIds.length > 1) return { skuId: null, ambiguous: true };
  return { skuId: uniqueSkuIds[0], ambiguous: false };
}

/**
 * sku_master.internal_sku == line.marketplace_sku 직접 매칭.
 * sku_master.internal_sku 는 038 에서 UNIQUE 라 1대1 보장.
 */
async function matchByInternalSku({ marketplaceSku }) {
  if (!marketplaceSku) return null;
  const { data, error } = await getClient()
    .from('sku_master')
    .select('id')
    .eq('internal_sku', marketplaceSku)
    .maybeSingle();
  if (error) throw error;
  return data ? data.id : null;
}

/**
 * 단일 order_line 매칭. 3단계 시도 + 모두 실패 시 failed.
 */
async function matchOrderLine(line, options = {}) {
  const marketplace = options.marketplace || null;
  const listingId   = line?.listing_id ?? null;
  const optionId    = line?.option_id ?? null;
  const marketplaceSku = line?.marketplace_sku ?? null;

  // A. link exact
  const linkSkuId = await matchByLink({ marketplace, listingId, optionId });
  if (linkSkuId) {
    return {
      matched_sku_id:   linkSkuId,
      match_status:     'matched_link',
      match_confidence: 'high',
      match_reason:     'link_exact',
    };
  }

  // B. marketplace_sku
  const mp = await matchByMarketplaceSku({ marketplace, marketplaceSku });
  if (mp.skuId) {
    return {
      matched_sku_id:   mp.skuId,
      match_status:     'matched_marketplace_sku',
      match_confidence: 'medium',
      match_reason:     'marketplace_sku',
    };
  }
  if (mp.ambiguous) {
    return {
      matched_sku_id:   null,
      match_status:     'failed',
      match_confidence: null,
      match_reason:     'ambiguous_marketplace_sku',
    };
  }

  // C. internal_sku
  const internalSkuId = await matchByInternalSku({ marketplaceSku });
  if (internalSkuId) {
    return {
      matched_sku_id:   internalSkuId,
      match_status:     'matched_internal_sku',
      match_confidence: 'medium',
      match_reason:     'internal_sku',
    };
  }

  // D. all failed
  return {
    matched_sku_id:   null,
    match_status:     'failed',
    match_confidence: null,
    match_reason:     'no_match',
  };
}

module.exports = { matchOrderLine };
