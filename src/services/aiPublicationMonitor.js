/**
 * src/services/aiPublicationMonitor.js — AI 워크플로우 리스팅 undercut 감시.
 *
 * Owner 승인 (2026-08-30):
 *   AI 상품 제작으로 등록된 리스팅이 있으면 · 원본 경쟁사가 30일 이내에 가격을 인하할 때마다
 *   벨 알림(team_tasks · assignee_scope='operators')을 사장에게 발송.
 *
 * 데이터 계약:
 *   - recordPublication : publish 성공 직후 aiWorkflowPublisher 가 호출. upsert 로 pair 등록.
 *   - runSweep          : cron 이 6시간마다 호출. 활성 pair 를 Browse API 로 재조회 후
 *                         current < min_seen_price 이면 exception task 생성 + min_seen 갱신.
 *
 * 안전장치:
 *   - Browse API quota 절약: SWEEP_MAX_PAIRS 로 회당 검사 개수 제한, 오래된 last_checked_at 부터 처리.
 *   - dedupe_key = `ai_wf_undercut:{publication_id}` — 알림 open 중 재알림 차단.
 *   - Browse API 404 (경쟁사 리스팅 종료) 시 ended_at 세팅 → 이후 sweep 대상 제외.
 *   - assignee_scope='operators' — 사장 벨만 (staff 로 흘리지 않음).
 */
'use strict';

const { getClient } = require('../db/supabaseClient');

const SWEEP_MAX_PAIRS = Number(process.env.AI_WF_MONITOR_MAX_PAIRS || 50);

/**
 * Publish 성공 시 pair 저장.
 * upsert · 같은 (my_ebay_item_id, competitor_item_id) 이면 baseline 을 재설정.
 *
 * @param {Object} opts
 * @param {string} opts.myEbayItemId          - 방금 등록한 우리 eBay itemId
 * @param {number|null} [opts.myPublishPrice]
 * @param {string} opts.competitorItemId      - 원본 경쟁사 eBay itemId (state.competitor.itemId)
 * @param {number|null} [opts.competitorPriceAtPublish]  - 등록 시점 경쟁사 가격 (state.competitor.price)
 * @param {number|null} [opts.createdBy]      - req.user.id
 * @returns {Promise<{id:number, deduped:boolean}>}
 */
async function recordPublication(opts) {
  const {
    myEbayItemId,
    myPublishPrice = null,
    competitorItemId,
    competitorPriceAtPublish = null,
    createdBy = null,
  } = opts || {};

  if (!myEbayItemId || !competitorItemId) {
    throw new Error('recordPublication: myEbayItemId and competitorItemId are required');
  }

  const db = getClient();
  const now = new Date();
  const monitorUntil = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const baseline = (competitorPriceAtPublish != null && Number.isFinite(Number(competitorPriceAtPublish)))
    ? Number(competitorPriceAtPublish) : null;

  const row = {
    my_ebay_item_id:             String(myEbayItemId),
    my_publish_price:            (myPublishPrice != null && Number.isFinite(Number(myPublishPrice)))
      ? Number(myPublishPrice) : null,
    competitor_item_id:          String(competitorItemId),
    competitor_price_at_publish: baseline,
    competitor_min_seen_price:   baseline,
    published_at:                now.toISOString(),
    monitor_until:               monitorUntil.toISOString(),
    ended_at:                    null,
    created_by:                  Number.isFinite(Number(createdBy)) ? Number(createdBy) : null,
  };

  const { data, error } = await db.from('ai_workflow_publications')
    .upsert(row, { onConflict: 'my_ebay_item_id,competitor_item_id' })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id, deduped: false };
}

/**
 * 활성 pair 를 Browse API 로 재조회 → undercut 감지 → 알림.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.ebay]     - EbayAPI 인스턴스 (테스트 주입).  없으면 new EbayAPI().
 * @param {Object} [deps.exceptionSvc]  - createExceptionTask 서비스. 없으면 실제 로드.
 * @param {Object} [deps.db]       - supabase client. 없으면 getClient().
 * @param {number} [deps.maxPairs] - override SWEEP_MAX_PAIRS
 * @returns {Promise<{checked:number, alerts:number, ended:number, skipped:number}>}
 */
async function runSweep(deps = {}) {
  const db = deps.db || getClient();
  const maxPairs = Number.isFinite(deps.maxPairs) ? deps.maxPairs : SWEEP_MAX_PAIRS;

  // 활성 pair — monitor_until 미도래 & 종료 안됨. last_checked_at 오래된 것 먼저.
  const { data: pairs, error } = await db.from('ai_workflow_publications')
    .select('*')
    .is('ended_at', null)
    .gt('monitor_until', new Date().toISOString())
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(maxPairs);
  if (error) throw error;
  if (!pairs || pairs.length === 0) {
    return { checked: 0, alerts: 0, ended: 0, skipped: 0 };
  }

  const ebay = deps.ebay || (() => {
    const EbayAPI = require('../api/ebayAPI');
    return new EbayAPI();
  })();
  const exceptionSvc = deps.exceptionSvc || require('./exceptionTask');

  let alerts = 0, ended = 0, skipped = 0;
  const nowIso = new Date().toISOString();

  for (const p of pairs) {
    let item = null;
    try {
      item = await ebay._fetchViaBrowseAPI(String(p.competitor_item_id));
    } catch (e) {
      console.warn(`[aiPubMonitor] fetch failed for competitor ${p.competitor_item_id}: ${e.message}`);
      skipped++;
      continue;
    }

    if (!item) {
      // Browse 404 → 리스팅 종료 판정
      await db.from('ai_workflow_publications')
        .update({ ended_at: nowIso, last_checked_at: nowIso })
        .eq('id', p.id);
      ended++;
      continue;
    }

    // Number(null) === 0 사고 방지 · 명시적으로 유효한 숫자·양수만 취급.
    const rawPrice = item.price;
    const currentPrice = (rawPrice != null && rawPrice !== '' && Number.isFinite(Number(rawPrice)) && Number(rawPrice) > 0)
      ? Number(rawPrice) : null;
    const updates = { last_checked_at: nowIso };
    if (currentPrice != null) updates.last_competitor_price = currentPrice;

    const prevLow = p.competitor_min_seen_price != null
      ? Number(p.competitor_min_seen_price)
      : (p.competitor_price_at_publish != null ? Number(p.competitor_price_at_publish) : null);

    let didAlert = false;
    if (currentPrice != null && Number.isFinite(prevLow) && currentPrice < prevLow) {
      updates.competitor_min_seen_price = currentPrice;
      updates.last_alerted_at = nowIso;
      try {
        await exceptionSvc.createExceptionTask({
          exceptionType: 'COMPETITOR_PRICE_DROP',
          severity: 'medium',
          dedupeKey: `ai_wf_undercut:${p.id}`,
          scope: 'operators',
          title: `[자동] 경쟁사 가격 인하 · $${currentPrice.toFixed(2)} (직전 최저 $${prevLow.toFixed(2)})`,
          memo: [
            `내 리스팅: https://www.ebay.com/itm/${p.my_ebay_item_id}`,
            `경쟁사 리스팅: https://www.ebay.com/itm/${p.competitor_item_id}`,
            `내 판매가: ${p.my_publish_price != null ? `$${Number(p.my_publish_price).toFixed(2)}` : 'n/a'}`,
            `경쟁사 등록 시 가격: ${p.competitor_price_at_publish != null ? `$${Number(p.competitor_price_at_publish).toFixed(2)}` : 'n/a'}`,
            `경쟁사 현재가: $${currentPrice.toFixed(2)}`,
            `직전 최저가: $${prevLow.toFixed(2)}`,
          ].join('\n'),
          context: {
            source: 'ai_workflow_publication',
            publication_id: p.id,
            my_ebay_item_id: p.my_ebay_item_id,
            competitor_item_id: p.competitor_item_id,
            my_publish_price: p.my_publish_price,
            competitor_price_at_publish: p.competitor_price_at_publish,
            competitor_prev_low: prevLow,
            competitor_current_price: currentPrice,
            observed_at: nowIso,
          },
        });
        alerts++;
        didAlert = true;
      } catch (e) {
        console.warn(`[aiPubMonitor] alert task creation failed for pub ${p.id}: ${e.message}`);
      }
    }

    await db.from('ai_workflow_publications').update(updates).eq('id', p.id);
    if (!didAlert && (currentPrice == null || !Number.isFinite(prevLow))) skipped++;
  }

  return { checked: pairs.length, alerts, ended, skipped };
}

module.exports = { recordPublication, runSweep };
