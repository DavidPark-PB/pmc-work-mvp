'use strict';

/**
 * My Listing Refresher
 *
 * ebay_products 의 shipping_usd / price_usd / stock 를 Browse API 로 재갱신.
 *
 * 배경 (2026-07-09 사장님 지침):
 *   GetMyeBaySelling (Trading API) 이 반환하는 shipping_cost 는 트랜잭션 기준
 *   (실제 판매된 배송비) 이라 리스팅 설정값이 아니다. 그래서 productSync 는
 *   shipping_usd 를 스킵하고 기존 DB 값을 유지한다. 문제는 새로 등록된 리스팅
 *   또는 배송 프로파일이 바뀐 리스팅은 shipping_usd 가 0 or null 로 저장돼
 *   전투 상황판에서 "배송비 무료" 로 오판된다는 것.
 *
 * 해결:
 *   내 리스팅도 경쟁사와 같은 Browse API (get_item_by_legacy_id) 로 갱신.
 *   Browse API 는 X-EBAY-C-ENDUSERCTX 헤더로 우편번호를 넣으면 CALCULATED
 *   shipping 도 실제 값으로 반환한다.
 *
 * 매일 새벽 3 시 크론이 shipping_usd 가 stale 하거나 0 인 것부터 500 개씩 훑음.
 * eBay 리스팅 9,000+ 개 → 약 18 일에 한 바퀴.
 *
 * env override:
 *   MY_LISTING_REFRESH_CHUNK   default 500
 *   MY_LISTING_STALE_DAYS      default 14 (14 일 이상 오래된 것 대상)
 */

const { getClient } = require('../db/supabaseClient');
const EbayAPI = require('../api/ebayAPI');

async function runRefreshMyListingsChunk({ maxItems, staleDays } = {}) {
  const CHUNK      = Math.max(50, parseInt(maxItems)  || parseInt(process.env.MY_LISTING_REFRESH_CHUNK) || 500);
  const STALE_DAYS = Math.max(1,  parseInt(staleDays) || parseInt(process.env.MY_LISTING_STALE_DAYS)   || 14);
  const staleThreshold = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  const db = getClient();
  const ebay = new EbayAPI();

  console.log(`[MyListingRefresher] 시작 — chunk=${CHUNK}, staleDays=${STALE_DAYS}`);

  // 우선순위:
  //   (1) shipping_usd = 0 or null (아예 배송비 정보 없음)  ← 가장 급함
  //   (2) shipping_usd > 0 이지만 updated_at 이 stale
  //   각 그룹 안에서 updated_at 오래된 순.
  //
  // Supabase 로 OR 조건 여러 개 처리 — .or() 사용.
  const { data: candidates, error } = await db
    .from('ebay_products')
    .select('item_id, sku, shipping_usd, price_usd, updated_at, status')
    .neq('status', 'ended')
    .or(`shipping_usd.is.null,shipping_usd.eq.0,updated_at.lt.${staleThreshold}`)
    .order('shipping_usd', { ascending: true, nullsFirst: true })
    .order('updated_at', { ascending: true, nullsFirst: true })
    .limit(CHUNK);

  if (error) {
    console.error('[MyListingRefresher] 후보 로드 실패:', error.message);
    return { processed: 0, updated: 0, failed: 0, errors: [error.message] };
  }
  if (!candidates || candidates.length === 0) {
    console.log('[MyListingRefresher] 갱신할 리스팅 없음 — 전부 신선');
    return { processed: 0, updated: 0, failed: 0, errors: [] };
  }

  console.log(`[MyListingRefresher] 갱신 대상: ${candidates.length}개`);
  const itemIds = candidates.map(c => c.item_id).filter(Boolean);

  // Browse API 병렬 호출 (getCompetitorItems 재사용 — 이미 동시성/rate limit 제어)
  const items = await ebay.getCompetitorItems(itemIds);
  console.log(`[MyListingRefresher] Browse API 응답: ${items.length}/${itemIds.length}`);

  const byId = new Map(items.map(x => [String(x.itemId), x]));
  let updated = 0;
  let failed = 0;
  const errors = [];

  for (const c of candidates) {
    const item = byId.get(String(c.item_id));
    if (!item) {
      // 404 등 — Browse API 실패. status='ended' 마킹은 별도 흐름에서.
      failed++;
      continue;
    }
    const shipping = Number.isFinite(item.shippingCost) ? item.shippingCost : 0;
    const price = Number.isFinite(item.price) ? item.price : (Number.isFinite(item.priceMin) ? item.priceMin : 0);
    const patch = {
      price_usd: price,
      shipping_usd: shipping,
      updated_at: new Date().toISOString(),
    };
    if (Number.isFinite(item.quantityAvailable)) patch.stock = item.quantityAvailable;
    if (item.status === 'out_of_stock') patch.status = 'active'; // 리스팅 자체는 active

    const { error: upErr } = await db.from('ebay_products').update(patch).eq('item_id', c.item_id);
    if (upErr) {
      failed++;
      errors.push(`${c.item_id}: ${upErr.message}`);
      // 컬럼 부족 시 최소 필드만 재시도
      if (upErr.code === '42703') {
        await db.from('ebay_products').update({
          price_usd: patch.price_usd, shipping_usd: patch.shipping_usd, updated_at: patch.updated_at,
        }).eq('item_id', c.item_id);
      }
    } else {
      updated++;
    }
  }

  console.log(`[MyListingRefresher] 완료 — 처리: ${candidates.length}, 갱신: ${updated}, 실패: ${failed}`);
  return { processed: candidates.length, updated, failed, errors };
}

module.exports = { runRefreshMyListingsChunk };
