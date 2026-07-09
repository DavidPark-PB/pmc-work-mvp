'use strict';

/**
 * priceEventService.js — Commerce OS v1 Event-first 가격 이벤트 발행
 * ---------------------------------------------------------------------------
 * 가격은 상태가 아니라 이벤트의 결과. price_events(append-only)에 기록한다.
 * 현재가는 최신 PriceApplied 이벤트에서 파생 (getCurrentAppliedPrice).
 *
 * 이벤트 흐름:
 *   PriceRecommendationCreated → PriceApproved → PriceApplied
 *   CompetitorChanged → PriceUpdated → PriceReverted(선택)
 *
 * BLOCK은 가격 문제가 아니라 데이터 태스크 — createBlockDataTasks가
 * 기존 exceptionTask(team_tasks) 경로로 직원 작업 큐에 하향한다.
 */

const { getClient } = require('../db/supabaseClient');
const { BLOCK_TASK_TYPE } = require('../engines/priceEngine');

const EVENT_TYPES = Object.freeze([
  'PriceRecommendationCreated', 'PriceApproved', 'PriceApplied',
  'CompetitorChanged', 'PriceUpdated', 'PriceReverted',
]);

/**
 * 이벤트 1건 발행 (INSERT only — UPDATE/DELETE 금지).
 * @param {object} ev
 *   { event_type, sku, item_id, old_price, new_price, recommended_price,
 *     action, reason_code, confidence_snapshot, rule_version,
 *     competitor_ref, landing_cost, actor }
 */
async function publishPriceEvent(ev) {
  if (!EVENT_TYPES.includes(ev.event_type)) {
    throw new Error(`unknown event_type: ${ev.event_type}`);
  }
  if (ev.action && !ev.reason_code) {
    throw new Error('reason_code is required (AUTO 포함 — KPI 집계용)');
  }
  const db = getClient();
  const row = {
    event_type: ev.event_type,
    sku: ev.sku || null,
    item_id: ev.item_id || null,
    old_price: ev.old_price ?? null,
    new_price: ev.new_price ?? null,
    recommended_price: ev.recommended_price ?? null,
    currency: ev.currency || 'USD',
    action: ev.action || null,
    reason_code: ev.reason_code || null,
    confidence_snapshot: ev.confidence_snapshot || null,
    rule_version: ev.rule_version || null,
    competitor_ref: ev.competitor_ref || null,
    landing_cost: ev.landing_cost ?? null,
    actor: ev.actor || 'system',
  };
  const { data, error } = await db.from('price_events').insert(row).select('id').single();
  if (error) throw new Error(`price_events insert 실패: ${error.message}`);
  return data.id;
}

/** 추천 배치 발행 — decideSku() 결과 배열을 일괄 INSERT (500개 단위). */
async function publishRecommendations(decisions, { actor = 'system' } = {}) {
  const db = getClient();
  const rows = decisions.map((d) => ({
    event_type: 'PriceRecommendationCreated',
    sku: d.sku,
    item_id: d.item_id || null,
    old_price: d.current_total ?? null,
    recommended_price: d.recommended_price,
    action: d.action,
    reason_code: d.reason_code,
    confidence_snapshot: d.confidence_snapshot,
    rule_version: d.rule_version,
    competitor_ref: d.competitor_ref || null,
    landing_cost: d.landing_cost_usd ?? null,
    actor,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('price_events').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`price_events 일괄 insert 실패: ${error.message}`);
    inserted += Math.min(500, rows.length - i);
  }
  return inserted;
}

/** 현재가 파생 — 최신 PriceApplied 이벤트. 없으면 null(레거시 소스 사용). */
async function getCurrentAppliedPrice(sku) {
  const db = getClient();
  const { data } = await db.from('price_events')
    .select('new_price, created_at')
    .eq('sku', sku).eq('event_type', 'PriceApplied')
    .order('created_at', { ascending: false }).limit(1);
  return data && data.length ? Number(data[0].new_price) : null;
}

/** 오늘 이 SKU가 이미 인하한 누적 % (일일 최대 인하율 캡 검사용). */
async function getTodayDropPctUsed(sku) {
  const map = await getTodayDropPctMap([sku]);
  return map.get(sku) || 0;
}

/** 오늘 SKU별 누적 인하 % — 전체를 쿼리 1~2번으로 로드 (배치용). */
async function getTodayDropPctMap(skus) {
  const db = getClient();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const map = new Map();
  const { data } = await db.from('price_events')
    .select('sku, old_price, new_price')
    .eq('event_type', 'PriceApplied')
    .gte('created_at', dayStart.toISOString())
    .limit(10000);
  const wanted = skus ? new Set(skus) : null;
  for (const e of data || []) {
    if (wanted && !wanted.has(e.sku)) continue;
    if (e.old_price > 0 && e.new_price < e.old_price) {
      map.set(e.sku, (map.get(e.sku) || 0) + (e.old_price - e.new_price) / e.old_price * 100);
    }
  }
  return map;
}

/** guardrails 싱글톤 로드. */
async function getGuardrails() {
  const db = getClient();
  const { data, error } = await db.from('pricing_guardrails').select('*').eq('id', 1).single();
  if (error) throw new Error(`pricing_guardrails 로드 실패: ${error.message}`);
  return data;
}

/**
 * BLOCK → 직원 데이터 태스크 생성 (dedupe_key로 중복 방지).
 * Control Tower 표시: "가격 변경 불가 N개 → 무게/원가/매핑 입력 큐".
 */
async function createBlockDataTasks(blockDecisions) {
  const { createExceptionTask } = require('./exceptionTask');
  const TASK_MEMO = {
    BLOCK_LANDING_COST_UNKNOWN: 'weight_gram / 치수 / cost_krw 보완 필요 — 입력 시 자동가격 대상에 편입됩니다.',
    BLOCK_NO_MATCH: 'SKU 매핑 확인/등록 필요 (product_matches 승인).',
    BLOCK_MAP: 'MAP(최저광고가) 정책 등록/해제 확인 필요.',
    BLOCK_STALE_COMPETITOR: '경쟁가 신선도 초과 — 크롤 재수집 필요.',
    BLOCK_API_ERROR: 'API 오류 — 자동화 파이프라인 점검 필요.',
  };
  let created = 0;
  for (const d of blockDecisions) {
    const type = BLOCK_TASK_TYPE[d.reason_code];
    if (!type) continue;
    try {
      const res = await createExceptionTask({
        exceptionType: type,
        dedupeKey: `engine1:${d.reason_code}:${d.sku}`,
        title: `[Engine1] ${d.sku} — ${d.reason_code}`,
        memo: TASK_MEMO[d.reason_code] || d.reason_code,
        severity: 'medium',
        context: {
          source: 'engine1',
          sku: d.sku,
          item_id: d.item_id,
          reason_code: d.reason_code,
          missing_data: d.missing_data || null,
        },
      });
      if (!res.deduped) created += 1;
    } catch (e) {
      console.warn(`[priceEvents] BLOCK 태스크 생성 실패(${d.sku}):`, e.message);
    }
  }
  return created;
}

module.exports = {
  EVENT_TYPES,
  publishPriceEvent,
  publishRecommendations,
  getCurrentAppliedPrice,
  getTodayDropPctUsed,
  getTodayDropPctMap,
  getGuardrails,
  createBlockDataTasks,
};
