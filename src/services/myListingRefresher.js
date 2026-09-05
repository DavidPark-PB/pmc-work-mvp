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

/**
 * R2-A (2026-09-05) · Unknown ≠ Zero invariant.
 *
 * Return the first valid observed price from the Browse API item envelope,
 * or `null` if no field carries a usable value. Callers MUST omit the
 * `price_usd` key from the DB patch when this returns `null` so that the
 * previously-stored canonical value is preserved.
 *
 * Valid price = finite AND > 0.
 *   priceExecutionGate.validateInput already rejects p<=0 as GATE_INVALID_PRICE
 *   (priceExecutionGate.js:344), so treating 0/negative here as invalid keeps
 *   the entire pricing stack consistent: an eBay listing whose live price is
 *   0 or negative is not something we would ever write, so it is also not
 *   something we should synthesise into our canonical column.
 *
 * Priority (unchanged from prior behaviour):
 *   1. item.price
 *   2. item.priceMin (multi-variant range lower bound)
 *   3. null (Unknown · caller omits patch key)
 *
 * @param {object} item Browse API item envelope
 * @returns {number|null} valid price OR null (Unknown)
 */
function _extractValidPrice(item) {
  if (!item) return null;
  if (Number.isFinite(item.price) && item.price > 0) return item.price;
  if (Number.isFinite(item.priceMin) && item.priceMin > 0) return item.priceMin;
  return null;
}

async function runRefreshMyListingsChunk({ maxItems, staleDays, matchedOnly } = {}) {
  const CHUNK      = Math.max(50, parseInt(maxItems)  || parseInt(process.env.MY_LISTING_REFRESH_CHUNK) || 500);
  const STALE_DAYS = Math.max(1,  parseInt(staleDays) || parseInt(process.env.MY_LISTING_STALE_DAYS)   || 14);
  const MATCHED_ONLY = matchedOnly === true || process.env.MY_LISTING_MATCHED_ONLY === 'true';
  const staleThreshold = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  const db = getClient();
  const ebay = new EbayAPI();

  console.log(`[MyListingRefresher] 시작 — chunk=${CHUNK}, staleDays=${STALE_DAYS}, matchedOnly=${MATCHED_ONLY}`);

  // 2026-07-12 사장님 지침 (matchedOnly=true 기본):
  //   product_matches (status='approved') 에 있는 our_sku 만 refresh 대상.
  //   이유: 매칭 없는 SKU 는 Engine 1 판정 안 됨 → 신선도 우선순위 낮음.
  //   대상을 좁히면 매일 크론 1회에 전량 refresh 가능 → 항상 신선.
  let matchedSkus = null;
  if (MATCHED_ONLY) {
    const set = new Set();
    let ofs = 0;
    while (true) {
      const { data, error } = await db.from('product_matches')
        .select('our_sku').eq('status', 'approved').range(ofs, ofs + 999);
      if (error) { console.warn('[MyListingRefresher] product_matches 로드 실패:', error.message); break; }
      if (!data || data.length === 0) break;
      data.forEach((r) => r.our_sku && set.add(r.our_sku));
      if (data.length < 1000) break;
      ofs += 1000;
    }
    matchedSkus = [...set];
    console.log(`[MyListingRefresher] 매칭된 SKU: ${matchedSkus.length}개 (이것만 대상)`);
    if (matchedSkus.length === 0) {
      console.log('[MyListingRefresher] 매칭 없음 — 종료');
      return { processed: 0, updated: 0, failed: 0, errors: [] };
    }
  }

  // 우선순위:
  //   (1) shipping_usd = 0 or null (아예 배송비 정보 없음)  ← 가장 급함
  //   (2) shipping_usd > 0 이지만 updated_at 이 stale
  //   각 그룹 안에서 updated_at 오래된 순.
  let candidates = [];
  if (MATCHED_ONLY && matchedSkus) {
    // .in() 은 최대 ~1000 개 안전. 500 개씩 청크 조회 후 병합.
    const collected = [];
    for (let i = 0; i < matchedSkus.length; i += 500) {
      const chunk = matchedSkus.slice(i, i + 500);
      const { data, error } = await db.from('ebay_products')
        .select('item_id, sku, shipping_usd, price_usd, updated_at, status')
        .neq('status', 'ended')
        .in('sku', chunk);
      if (error) {
        console.error('[MyListingRefresher] 후보 로드 실패:', error.message);
        return { processed: 0, updated: 0, failed: 0, errors: [error.message] };
      }
      collected.push(...(data || []));
    }
    // updated_at 오래된 순 정렬 후 상한 CHUNK
    collected.sort((a, b) => {
      const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return at - bt;
    });
    candidates = collected.slice(0, CHUNK);
  } else {
    const { data, error } = await db
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
    candidates = data || [];
  }
  // 이후 로직 (undefined 참조 방지)
  const error = null;

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
  //   R2-A (2026-09-05) · truthful metric · counts refresh cycles where the
  //   Browse API returned no valid price and we deliberately preserved the
  //   existing canonical price_usd instead of writing 0. Summary-level only ·
  //   no per-item log spam (thousands of SKUs · logs would flood Railway).
  let pricePreservedMissing = 0;
  const errors = [];

  for (const c of candidates) {
    const item = byId.get(String(c.item_id));
    if (!item) {
      // 404 등 — Browse API 실패. status='ended' 마킹은 별도 흐름에서.
      failed++;
      continue;
    }
    const shipping = Number.isFinite(item.shippingCost) ? item.shippingCost : 0;
    //   R2-A · Unknown ≠ Zero · missing/invalid observation MUST NOT
    //   overwrite the last-known canonical price with 0. When the Browse
    //   API returns an envelope but no usable price/priceMin, we build the
    //   patch WITHOUT the price_usd key so the existing DB value is
    //   preserved. Other observed fields (shipping · stock · status) still
    //   update because they carry independent value.
    const validPrice = _extractValidPrice(item);
    const patch = {
      shipping_usd: shipping,
      updated_at: new Date().toISOString(),
    };
    if (validPrice != null) {
      patch.price_usd = validPrice;
    } else {
      pricePreservedMissing++;
    }
    if (Number.isFinite(item.quantityAvailable)) patch.stock = item.quantityAvailable;
    if (item.status === 'out_of_stock') patch.status = 'active'; // 리스팅 자체는 active

    const { error: upErr } = await db.from('ebay_products').update(patch).eq('item_id', c.item_id);
    if (upErr) {
      failed++;
      errors.push(`${c.item_id}: ${upErr.message}`);
      // 컬럼 부족 시 최소 필드만 재시도 · R2-A · price_usd 는 valid 일 때만 포함
      if (upErr.code === '42703') {
        const retry = {
          shipping_usd: patch.shipping_usd,
          updated_at: patch.updated_at,
        };
        if (validPrice != null) retry.price_usd = validPrice;
        await db.from('ebay_products').update(retry).eq('item_id', c.item_id);
      }
    } else {
      updated++;
    }
  }

  console.log(`[MyListingRefresher] 완료 — 처리: ${candidates.length}, 갱신: ${updated}, 실패: ${failed}, price_preserved_missing: ${pricePreservedMissing}`);
  return { processed: candidates.length, updated, failed, pricePreservedMissing, errors };
}

module.exports = {
  runRefreshMyListingsChunk,
  //   R2-A · exposed for tests only. Do not use from other callers.
  _extractValidPrice,
};
