'use strict';

/**
 * Competitor Listing Refresher (matched-only)
 *
 * 배경 (2026-07-19 사장님 지침):
 *   CSV 로 임포트한 경쟁 셀러 리스팅 (competitor_listings) 은 CompetitorMonitor
 *   가 다루지 않는다 (그건 competitor_prices 만 refresh). 결과: hello_kr 등
 *   CSV 임포트 셀러의 가격이 며칠~일주일씩 오래된 채로 전투 상황판에 노출됨.
 *
 * 해결:
 *   product_matches (approved) 에 있는 competitor_item_id 중 competitor_listings
 *   에도 존재하는 것 (즉 CSV 임포트 대상) 만 Browse API 로 매일 refresh.
 *   - 매칭 없는 리스팅은 어차피 전투 상황판 판정 불가 → 스킵.
 *   - 셀러당 매칭 수: value-goods 184, hello_kr 161, onmom_house 136, ...
 *   - 일일 총합 ~583 콜 (Buy > Browse 5,000/day 의 12%).
 *
 * env override:
 *   COMP_LISTING_REFRESH_CHUNK  default 1000
 */

const { getClient } = require('../db/supabaseClient');
const EbayAPI = require('../api/ebayAPI');

async function runRefreshCompetitorListingsChunk({ maxItems } = {}) {
  const CHUNK = Math.max(50, parseInt(maxItems) || parseInt(process.env.COMP_LISTING_REFRESH_CHUNK) || 1000);
  const db = getClient();
  const ebay = new EbayAPI();

  console.log(`[CompListingRefresher] 시작 — chunk=${CHUNK}`);

  // 1. approved 매칭의 competitor_item_id 로드
  const matchedIds = new Set();
  let ofs = 0;
  while (true) {
    const { data, error } = await db.from('product_matches')
      .select('competitor_item_id').eq('status', 'approved').range(ofs, ofs + 999);
    if (error) { console.error('[CompListingRefresher] product_matches 로드 실패:', error.message); return { processed: 0, updated: 0, failed: 0 }; }
    if (!data || data.length === 0) break;
    data.forEach(r => r.competitor_item_id && matchedIds.add(String(r.competitor_item_id)));
    if (data.length < 1000) break;
    ofs += 1000;
  }
  const ids = [...matchedIds];
  console.log(`[CompListingRefresher] approved 매칭: ${ids.length}개`);

  if (ids.length === 0) return { processed: 0, updated: 0, failed: 0 };

  // 2. competitor_listings 에 존재하는 것만 (CSV 임포트 대상)
  //    last_seen 오래된 순 정렬해서 stale 우선 refresh.
  const candidates = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { data, error } = await db.from('competitor_listings')
      .select('ebay_item_id, seller_id, price, shipping, status, last_seen')
      .in('ebay_item_id', chunk);
    if (error) { console.error('[CompListingRefresher] competitor_listings 조회 실패:', error.message); return { processed: 0, updated: 0, failed: 0 }; }
    candidates.push(...(data || []));
  }
  candidates.sort((a, b) => {
    const at = a.last_seen ? new Date(a.last_seen).getTime() : 0;
    const bt = b.last_seen ? new Date(b.last_seen).getTime() : 0;
    return at - bt; // 오래된 것 먼저
  });
  const targets = candidates.slice(0, CHUNK);
  console.log(`[CompListingRefresher] 갱신 대상: ${targets.length}개 (전체 후보 ${candidates.length}개 중)`);

  if (targets.length === 0) return { processed: 0, updated: 0, failed: 0 };

  // 3. Browse API 호출
  const itemIds = targets.map(t => String(t.ebay_item_id));
  const items = await ebay.getCompetitorItems(itemIds);
  console.log(`[CompListingRefresher] Browse API 응답: ${items.length}/${itemIds.length}`);

  const byId = new Map(items.map(x => [String(x.itemId), x]));
  let updated = 0;
  let failed = 0;
  const now = new Date().toISOString();

  for (const t of targets) {
    const item = byId.get(String(t.ebay_item_id));
    if (!item) {
      // Browse API 실패 (rate-limit / 404 / ended). ended 마킹은 아래 조건에서만.
      failed++;
      continue;
    }
    const price = Number.isFinite(item.price) ? item.price : (Number.isFinite(item.priceMin) ? item.priceMin : null);
    const shipping = Number.isFinite(item.shippingCost) ? item.shippingCost : 0;
    // Browse API status 를 우리 status 로 매핑
    let newStatus = t.status || 'active';
    if (item.status === 'ended') newStatus = 'ended';
    else if (item.status === 'out_of_stock') newStatus = 'out_of_stock';
    else if (Number.isFinite(item.quantityAvailable) && item.quantityAvailable === 0) newStatus = 'out_of_stock';
    else newStatus = 'active';

    // competitor_listings 스키마에 실제 있는 컬럼만 UPDATE.
    // (quantity_available/price_min/price_max/variant_count 는 없음 → 42703 유발)
    const patch = {
      price: price != null ? price : t.price,
      shipping,
      status: newStatus,
      last_seen: now,
    };
    if (Number.isFinite(item.quantityAvailable)) patch.quantity = item.quantityAvailable;
    // total_price = price + shipping (competitor_listings 에 있는 컬럼)
    if (patch.price != null) patch.total_price = +(patch.price + (patch.shipping || 0)).toFixed(2);

    const { error: upErr } = await db.from('competitor_listings').update(patch).eq('ebay_item_id', t.ebay_item_id);
    if (upErr) {
      failed++;
      if (failed <= 5) console.error(`[CompListingRefresher] UPDATE fail ${t.ebay_item_id}: ${upErr.code} ${upErr.message}`);
    } else {
      updated++;
    }
  }

  console.log(`[CompListingRefresher] 완료 — 처리: ${targets.length}, 갱신: ${updated}, 실패: ${failed}`);
  return { processed: targets.length, updated, failed };
}

module.exports = { runRefreshCompetitorListingsChunk };
