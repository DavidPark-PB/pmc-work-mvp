'use strict';

/**
 * Competitor Crawler
 *
 * competitor_sellers 테이블에 등록된 셀러의 eBay 리스팅을 수집해
 * competitor_listings 테이블에 저장하고, 가격 변동 이력을 기록한다.
 *
 * 실행: 크론(매일 새벽 2시) 또는 수동(POST /api/competitors/crawl)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');
const EbayAPI = require('../api/ebayAPI');

const ebay = new EbayAPI();

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/** ms 단위 sleep */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 배열을 N개 단위 청크로 분할
 * @param {Array} arr
 * @param {number} size
 * @returns {Array[]}
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 핵심 함수
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 단일 셀러의 eBay 리스팅을 수집해 DB에 저장한다.
 *
 * @param {object} sellerRow - competitor_sellers 테이블 행
 *   { id, seller_name, platform, active, last_crawled_at, listing_count, ... }
 * @returns {{ sellerId, newItems, updatedItems, priceChanges, errors }}
 */
async function crawlSeller(sellerRow) {
  const db = getClient();
  const { id: sellerId, seller_name: sellerName } = sellerRow;

  const result = {
    sellerId,
    sellerName,
    newItems: 0,
    updatedItems: 0,
    priceChanges: 0,
    errors: [],
  };

  console.log(`[Crawler] 셀러 수집 시작: ${sellerName} (id=${sellerId})`);

  // ── 1. 리스팅 목록 수집 — Playwright scraper 우선, 실패시 Finding API fallback ──
  let listings = [];
  try {
    const { scrapeSellerListings } = require('./ebayScraper');
    listings = await scrapeSellerListings(sellerName, 5);
  } catch (e) {
    console.warn(`[Crawler][${sellerName}] Scraper 실패, Finding API fallback:`, e.message);
    try {
      listings = await ebay.findSellerListingsByFindingAPI(sellerName, 10);
    } catch (e2) {
      try {
        listings = await ebay.findSellerListings(sellerName, 5);
      } catch (e3) {
        const msg = `리스팅 수집 실패: ${e3.message}`;
        console.error(`[Crawler][${sellerName}] ${msg}`);
        result.errors.push(msg);
        return result;
      }
    }
  }

  if (!listings || listings.length === 0) {
    console.log(`[Crawler][${sellerName}] 리스팅 없음`);
    return result;
  }
  console.log(`[Crawler][${sellerName}] 목록 수집: ${listings.length}개`);

  // ── 2. Browse API로 상세 정보 수집 (배치 10개, 딜레이 1초) ──────────────
  const detailMap = {};   // itemId → detail
  const batches = chunk(listings, 10);

  for (const batch of batches) {
    await Promise.all(
      batch.map(async item => {
        try {
          const detail = await ebay._fetchViaBrowseAPI(item.itemId);
          if (detail) detailMap[item.itemId] = detail;
        } catch (e) {
          const msg = `Browse API 실패 (itemId=${item.itemId}): ${e.message}`;
          console.warn(`[Crawler][${sellerName}] ${msg}`);
          result.errors.push(msg);
        }
      })
    );
    await sleep(1000);
  }

  console.log(`[Crawler][${sellerName}] 상세 조회 완료: ${Object.keys(detailMap).length}개`);

  // ── 3. 기존 listings 로드 (가격 비교용) ──────────────────────────────────
  const itemIds = listings.map(l => l.itemId);
  const { data: existingRows } = await db
    .from('competitor_listings')
    .select('id, ebay_item_id, price, shipping')
    .eq('seller_id', sellerId)
    .in('ebay_item_id', itemIds);

  const existingMap = {};  // ebay_item_id → row
  (existingRows || []).forEach(r => { existingMap[r.ebay_item_id] = r; });

  // ── 4. Upsert + 가격 변동 기록 ───────────────────────────────────────────
  const now = new Date().toISOString();
  const priceHistoryRows = [];

  for (const item of listings) {
    const detail = detailMap[item.itemId] || {};
    const existing = existingMap[item.itemId];

    const newPrice    = parseFloat(detail.price    ?? item.price    ?? 0);
    const newShipping = parseFloat(detail.shippingCost ?? item.shipping ?? 0);

    const upsertRow = {
      seller_id:       sellerId,
      ebay_item_id:    item.itemId,
      title:           detail.title      ?? item.title   ?? '',
      price:           newPrice,
      shipping:        newShipping,
      quantity:        detail.stock      ?? null,
      image_url:       detail.imageUrl   ?? null,
      item_specifics:  detail.itemSpecifics ?? null,
      status:          detail.status     ?? 'active',
      last_seen:       now,
    };

    // INSERT 전용 컬럼 (conflict 시 UPDATE 제외)
    if (!existing) {
      upsertRow.created_at = now;
    }

    const { data: upserted, error: upsertErr } = await db
      .from('competitor_listings')
      .upsert(upsertRow, {
        onConflict: 'seller_id,ebay_item_id',
        ignoreDuplicates: false,
      })
      .select('id, price, shipping')
      .maybeSingle();

    if (upsertErr) {
      const msg = `upsert 실패 (itemId=${item.itemId}): ${upsertErr.message}`;
      console.warn(`[Crawler][${sellerName}] ${msg}`);
      result.errors.push(msg);
      continue;
    }

    if (existing) {
      result.updatedItems++;

      // 가격 변동 감지: 1% 이상 차이
      const oldPrice = parseFloat(existing.price ?? 0);
      if (oldPrice > 0 && Math.abs(newPrice - oldPrice) / oldPrice > 0.01) {
        const listingId = upserted?.id ?? existing.id;
        priceHistoryRows.push({
          listing_id:  listingId,
          seller_id:   sellerId,
          ebay_item_id: item.itemId,
          old_price:   oldPrice,
          new_price:   newPrice,
          changed_at:  now,
        });
        result.priceChanges++;
      }
    } else {
      result.newItems++;
    }
  }

  // 가격 이력 일괄 insert
  if (priceHistoryRows.length > 0) {
    const { error: histErr } = await db
      .from('competitor_price_history')
      .insert(priceHistoryRows);
    if (histErr) {
      console.warn(`[Crawler][${sellerName}] 가격 이력 insert 실패:`, histErr.message);
    }
  }

  // ── 5. competitor_sellers 메타 업데이트 ──────────────────────────────────
  const { error: sellerUpdErr } = await db
    .from('competitor_sellers')
    .update({
      last_crawled_at: now,
      listing_count:   listings.length,
    })
    .eq('id', sellerId);

  if (sellerUpdErr) {
    console.warn(`[Crawler][${sellerName}] seller 메타 업데이트 실패:`, sellerUpdErr.message);
  }

  console.log(
    `[Crawler][${sellerName}] 완료 — ` +
    `신규: ${result.newItems}, 업데이트: ${result.updatedItems}, ` +
    `가격변동: ${result.priceChanges}, 오류: ${result.errors.length}`
  );

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 전체 competitor_sellers 크롤 실행
 *
 * @param {object} opts
 * @param {string[]} [opts.sellerIds] - 특정 셀러 ID만 처리 (없으면 전체)
 * @param {boolean}  [opts.silent]    - 콘솔 출력 억제 (크론 silent 모드)
 * @returns {{ sellers, totalNew, totalUpdated, totalPriceChanges, totalErrors, details }}
 */
async function runCrawler({ sellerIds, silent = false } = {}) {
  const db = getClient();

  if (!silent) console.log('[Crawler] ===== 경쟁사 크롤러 시작 =====');

  // 1. active 셀러 로드
  let query = db
    .from('competitor_sellers')
    .select('id, seller_name, platform, last_crawled_at, listing_count')
    .eq('active', true)
    .order('last_crawled_at', { ascending: true, nullsFirst: true });

  if (sellerIds && sellerIds.length > 0) {
    query = query.in('id', sellerIds);
  }

  const { data: sellers, error: sellerErr } = await query;

  if (sellerErr) {
    const msg = `셀러 로드 실패: ${sellerErr.message}`;
    console.error('[Crawler]', msg);
    return { sellers: 0, totalNew: 0, totalUpdated: 0, totalPriceChanges: 0, totalErrors: 1, details: [] };
  }

  if (!sellers || sellers.length === 0) {
    if (!silent) console.log('[Crawler] active 셀러 없음');
    return { sellers: 0, totalNew: 0, totalUpdated: 0, totalPriceChanges: 0, totalErrors: 0, details: [] };
  }

  if (!silent) console.log(`[Crawler] 처리 대상 셀러: ${sellers.length}개`);

  // 2. 셀러별 순차 처리 (eBay rate limit 준수)
  let totalNew = 0;
  let totalUpdated = 0;
  let totalPriceChanges = 0;
  let totalErrors = 0;
  const details = [];

  for (const seller of sellers) {
    let res;
    try {
      res = await crawlSeller(seller);
    } catch (e) {
      console.error(`[Crawler] 셀러 처리 중 예외 (${seller.seller_name}):`, e.message);
      res = {
        sellerId: seller.id,
        sellerName: seller.seller_name,
        newItems: 0,
        updatedItems: 0,
        priceChanges: 0,
        errors: [e.message],
      };
    }

    totalNew          += res.newItems;
    totalUpdated      += res.updatedItems;
    totalPriceChanges += res.priceChanges;
    totalErrors       += res.errors.length;
    details.push(res);

    // 셀러 간 딜레이 (eBay rate limit 여유)
    await sleep(2000);
  }

  const summary = {
    sellers: sellers.length,
    totalNew,
    totalUpdated,
    totalPriceChanges,
    totalErrors,
    details,
  };

  if (!silent) {
    console.log(
      `[Crawler] ===== 완료 ===== ` +
      `셀러: ${summary.sellers}, 신규: ${totalNew}, ` +
      `업데이트: ${totalUpdated}, 가격변동: ${totalPriceChanges}, 오류: ${totalErrors}`
    );
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { runCrawler, crawlSeller };
