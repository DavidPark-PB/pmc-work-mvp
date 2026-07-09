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
const marketIntel = require('./hermesMarketIntelligence');

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
 * 청크 모드: sellerRow.crawl_chunk_size (기본 500) 만큼만 이번 실행에서 처리.
 * next_crawl_offset 를 페이지 단위로 저장/복원해서 대형 셀러 (수천~수만 리스팅) 를
 * 여러 날에 걸쳐 이어 크롤한다.
 *
 * @param {object} sellerRow - competitor_sellers 테이블 행
 *   { id, seller_id, seller_name, platform, active, last_crawled_at,
 *     listing_count, crawl_tier, next_crawl_offset, crawl_chunk_size,
 *     crawl_cycle_started_at, ... }
 * @returns {{ sellerId, sellerName, newItems, updatedItems, priceChanges,
 *            statusChanges, errors, nextOffset, cycleComplete }}
 */
async function crawlSeller(sellerRow) {
  const db = getClient();
  const { seller_id: sellerId, seller_name: sellerNameRaw } = sellerRow;
  // seller_id is the eBay username used in URLs/API. seller_name may be an internal memo/display label.
  const sellerName = sellerId;
  const displayName = sellerNameRaw || sellerId;

  // ── 청크 설정 ────────────────────────────────────────────────────────────
  const CHUNK_SIZE = Math.max(100, parseInt(sellerRow.crawl_chunk_size) || 500);
  const PAGE_SIZE = 100; // Finding API 페이지당 항목 수
  const pagesPerRun = Math.max(1, Math.ceil(CHUNK_SIZE / PAGE_SIZE));
  const savedOffset = Math.max(0, parseInt(sellerRow.next_crawl_offset) || 0);
  const startPage = 1 + savedOffset; // offset 0 = page 1 부터

  const result = {
    sellerId,
    sellerName: displayName,
    newItems: 0,
    updatedItems: 0,
    priceChanges: 0,
    statusChanges: 0,
    errors: [],
    nextOffset: savedOffset,   // 실패 시 유지
    cycleComplete: false,
  };

  console.log(`[Crawler] 셀러 수집 시작: ${displayName} (seller_id=${sellerId}, tier=${sellerRow.crawl_tier || 'B'}, chunk=${CHUNK_SIZE}, offset=${savedOffset})`);

  // ── 1. 리스팅 목록 수집 (청크) — Finding API 우선 ────────────────────────
  const ALLOW_SCRAPER = process.env.COMPETITOR_ALLOW_SCRAPER === 'true';
  let listings = [];
  let hasMore = false;
  let lastPage = startPage - 1;
  let totalPages = 0;
  try {
    const chunk = await ebay.findSellerListingsByFindingAPI(sellerName, { startPage, maxPages: pagesPerRun });
    listings = chunk.items || [];
    hasMore = !!chunk.hasMore;
    lastPage = chunk.lastPage || (startPage + pagesPerRun - 1);
    totalPages = chunk.totalPages || 0;
  } catch (e) {
    console.warn(`[Crawler][${sellerName}] Finding API 실패, Browse API fallback:`, e.message);
    try {
      // Browse API fallback — 청크 미지원. offset 0 (=이번 바퀴 시작) 일 때만 실행.
      if (savedOffset === 0) {
        listings = await ebay.findSellerListings(sellerName, 5);
      }
    } catch (e2) {
      if (ALLOW_SCRAPER && savedOffset === 0) {
        console.warn(`[Crawler][${sellerName}] API 실패, 스크래퍼 최후수단 시도:`, e2.message);
        try {
          const { scrapeSellerListings } = require('./ebayScraper');
          listings = await scrapeSellerListings(sellerName, 5);
        } catch (e3) {
          const msg = `리스팅 수집 실패(API+스크래퍼): ${e3.message}`;
          console.error(`[Crawler][${sellerName}] ${msg}`);
          result.errors.push(msg);
          return result;
        }
      } else {
        const msg = `리스팅 수집 실패(API): ${e2.message}`;
        console.error(`[Crawler][${sellerName}] ${msg}`);
        result.errors.push(msg);
        return result;
      }
    }
  }

  if (!listings || listings.length === 0) {
    console.log(`[Crawler][${sellerName}] 이 청크에서 리스팅 없음 (page ${startPage}~${lastPage})`);
    // 대형 셀러 마지막 청크가 비었을 수 있음 → 한 바퀴 완료로 간주
    result.nextOffset = 0;
    result.cycleComplete = true;
    return result;
  }
  console.log(`[Crawler][${sellerName}] 청크 수집: ${listings.length}개 (page ${startPage}~${lastPage} / total ${totalPages})`);

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
    .select('id, ebay_item_id, title, price, shipping, quantity, status, quantity_sold')
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
    const newStatus   = detail.status ?? 'active';

    // 판매수(누적) + 판매속도(직전 크롤 대비 증가분)
    const newSold = Number.isFinite(detail.quantitySold) ? detail.quantitySold : (detail.quantitySold ? parseInt(detail.quantitySold) : null);
    const oldSold = existing && existing.quantity_sold != null ? parseInt(existing.quantity_sold) : null;
    const soldVelocity = (newSold != null && oldSold != null) ? Math.max(0, newSold - oldSold) : null;

    const upsertRow = {
      seller_id:       sellerId,
      ebay_item_id:    item.itemId,
      title:           detail.title      ?? item.title   ?? '',
      price:           newPrice,
      shipping:        newShipping,
      quantity:        detail.stock      ?? null,
      quantity_sold:   newSold,
      sold_velocity:   soldVelocity,
      sold_measured_at: newSold != null ? now : null,
      image_url:       detail.imageUrl   ?? null,
      url:             detail.url        ?? item.url ?? '',
      item_specifics:  detail.itemSpecifics ?? null,
      status:          newStatus,
      last_seen:       now,
    };

    // INSERT 전용 컬럼 (conflict 시 UPDATE 제외)
    if (!existing) {
      upsertRow.first_seen = now;
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
      const oldShipping = parseFloat(existing.shipping ?? 0);
      const oldTotal = oldPrice + oldShipping;
      const newTotal = newPrice + newShipping;
      if (oldTotal > 0 && Math.abs(newTotal - oldTotal) / oldTotal > 0.01) {
        priceHistoryRows.push({
          competitor_item_id: item.itemId,
          seller_id:          sellerId,
          old_price:          oldPrice,
          new_price:          newPrice,
          old_shipping:       oldShipping,
          new_shipping:       newShipping,
          old_total:          oldTotal,
          new_total:          newTotal,
          change_pct:         ((newTotal - oldTotal) / oldTotal * 100),
          changed_at:         now,
        });
        result.priceChanges++;
      }

      const oldStatus = existing.status || 'active';
      if (oldStatus !== newStatus) {
        result.statusChanges++;
        const alertType = newStatus === 'out_of_stock'
          ? 'out_of_stock'
          : (oldStatus === 'out_of_stock' && newStatus === 'active' ? 'restocked' : 'status_change');
        await marketIntel.recordMarketAlert({
          eventKey: `${alertType}:${item.itemId}:${oldStatus}:${newStatus}:${now}`,
          alertType,
          severity: alertType === 'out_of_stock' ? 'watch' : 'info',
          competitorSellerId: sellerId,
          competitorItemId: item.itemId,
          title: detail.title ?? item.title ?? existing.title ?? '',
          oldStatus,
          newStatus,
          message: `${sellerId} ${item.itemId} 상태 변경: ${oldStatus} → ${newStatus}`,
          recommendation: alertType === 'out_of_stock' ? '경쟁사 품절 — 가격 유지/인상 후보 확인' : '재입고 또는 상태 변경 확인',
          createdAt: now,
        }, { sendTelegram: true });
      }
    } else {
      result.newItems++;
      await marketIntel.recordMarketAlert({
        eventKey: `new_listing:${item.itemId}:${now}`,
        alertType: 'new_listing',
        severity: 'info',
        competitorSellerId: sellerId,
        competitorItemId: item.itemId,
        title: detail.title ?? item.title ?? '',
        newPrice,
        newShipping,
        message: `${sellerId} 신규 경쟁상품: ${detail.title ?? item.title ?? item.itemId}`,
        recommendation: 'SKU 매핑 후보 검토',
        createdAt: now,
        data: { url: detail.url ?? item.url ?? '' },
      }, { sendTelegram: true });
    }

    await marketIntel.recordPriceSnapshot({
      snapshotType: 'competitor',
      sellerId,
      itemId: item.itemId,
      title: detail.title ?? item.title ?? '',
      price: newPrice,
      shipping: newShipping,
      quantity: detail.stock ?? null,
      status: newStatus,
      rawData: detail,
    });
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

  // ── 5. competitor_sellers 메타 업데이트 (청크 인식) ─────────────────────
  //   - hasMore == true  → next_crawl_offset += pagesPerRun (다음 실행 이어서),
  //                        last_crawled_at 은 아직 갱신 X (한 바퀴 미완료)
  //   - hasMore == false → 이번 청크가 마지막. offset 0 리셋 + last_crawled_at = now
  const nextOffset = hasMore ? (savedOffset + pagesPerRun) : 0;
  const cycleComplete = !hasMore;
  const sellerUpdate = {
    listing_count: (cycleComplete ? listings.length : (sellerRow.listing_count || 0) + listings.length),
    next_crawl_offset: nextOffset,
  };
  if (cycleComplete) {
    sellerUpdate.last_crawled_at = now;
    sellerUpdate.crawl_cycle_started_at = null; // 한 바퀴 완료 → 리셋
  } else if (savedOffset === 0) {
    sellerUpdate.crawl_cycle_started_at = now; // 이번 바퀴 시작
  }

  const { error: sellerUpdErr } = await db
    .from('competitor_sellers')
    .update(sellerUpdate)
    .eq('seller_id', sellerId);

  if (sellerUpdErr) {
    console.warn(`[Crawler][${sellerName}] seller 메타 업데이트 실패:`, sellerUpdErr.message);
    // 신규 컬럼 미적용 시 (migration 070 미실행) fallback
    if (sellerUpdErr.code === '42703') {
      await db.from('competitor_sellers').update({
        last_crawled_at: cycleComplete ? now : (sellerRow.last_crawled_at || now),
        listing_count: listings.length,
      }).eq('seller_id', sellerId);
    }
  }

  result.nextOffset = nextOffset;
  result.cycleComplete = cycleComplete;

  // 가격 변동 즉시 alert 생성/전송 (중복은 market_alerts.event_key 로 방지)
  for (const h of priceHistoryRows) {
    const isDrop = parseFloat(h.new_total) < parseFloat(h.old_total);
    await marketIntel.recordMarketAlert({
      eventKey: `${isDrop ? 'price_drop' : 'price_rise'}:${h.competitor_item_id}:${h.changed_at}:${h.old_total}:${h.new_total}`,
      alertType: isDrop ? 'price_drop' : 'price_rise',
      severity: isDrop ? 'warning' : 'watch',
      competitorSellerId: sellerId,
      competitorItemId: h.competitor_item_id,
      oldPrice: h.old_price,
      newPrice: h.new_price,
      oldShipping: h.old_shipping,
      newShipping: h.new_shipping,
      message: `${sellerId} ${isDrop ? '가격 하락' : '가격 상승'}: $${h.old_total.toFixed(2)} → $${h.new_total.toFixed(2)}`,
      recommendation: isDrop ? '자동 인하 금지 — 마진과 복수 경쟁사 움직임 확인' : '경쟁사 인상 — 가격 유지/인상 후보 확인',
      createdAt: h.changed_at,
      data: { changePct: h.change_pct },
    }, { sendTelegram: true });
  }

  console.log(
    `[Crawler][${sellerName}] 청크 완료 — ` +
    `신규: ${result.newItems}, 업데이트: ${result.updatedItems}, ` +
    `가격변동: ${result.priceChanges}, 상태변동: ${result.statusChanges}, ` +
    `오류: ${result.errors.length}, 다음 offset: ${result.nextOffset}, ` +
    `한 바퀴 완료: ${result.cycleComplete}`
  );

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 티어 기반 크롤 스케줄 결정.
 *
 * 사장님 지침 (2026-07-09):
 *   - Tier F/D (박터지는 3~5셀러) → 매일 크롤
 *   - Tier C (보통)              → 3일 이상 오래된 것 중 1명
 *   - Tier B (기본)              → 7일 이상 오래된 것 중 1명 (하루 1셀러 로테이션)
 *   - Tier A (공존)              → 14일 이상 오래된 것 중 1명 (격주)
 *   - 청크 진행 중 (next_crawl_offset > 0) 셀러는 티어 무관하게 이어서 진행
 *
 * @param {Array} allSellers  - active 셀러 전체 (last_crawled_at 오래된 순)
 * @returns {Array} 오늘 크롤 대상 셀러
 */
function selectTodaysSellers(allSellers) {
  const now = Date.now();
  const daysAgo = (isoStr) => {
    if (!isoStr) return Infinity;
    return (now - new Date(isoStr).getTime()) / (1000 * 60 * 60 * 24);
  };

  const TIER_INTERVAL_DAYS = { F: 0, D: 0, C: 3, B: 7, A: 14 };

  const selected = [];
  const seenIds = new Set();
  const rotationBucket = { B: [], A: [] }; // 로테이션 큐 (하루 1명씩)

  for (const s of allSellers) {
    const tier = s.crawl_tier || 'B';
    const offset = parseInt(s.next_crawl_offset) || 0;

    // 청크 진행 중이면 티어 무관하게 이어서
    if (offset > 0) {
      selected.push(s);
      seenIds.add(s.seller_id);
      continue;
    }

    const threshold = TIER_INTERVAL_DAYS[tier] ?? 7;
    const age = daysAgo(s.last_crawled_at);
    if (age < threshold) continue;

    if (tier === 'F' || tier === 'D' || tier === 'C') {
      // C 는 3일 이상 지난 것 전부 (그래도 많지 않음)
      selected.push(s);
      seenIds.add(s.seller_id);
    } else if (tier === 'B' || tier === 'A') {
      // 로테이션 큐 — 각 티어에서 하루 1명만
      if (rotationBucket[tier].length === 0) {
        rotationBucket[tier].push(s);
      }
    }
  }

  // 로테이션 큐 flush (already sorted by last_crawled_at asc)
  for (const tier of ['B', 'A']) {
    for (const s of rotationBucket[tier]) {
      if (!seenIds.has(s.seller_id)) {
        selected.push(s);
        seenIds.add(s.seller_id);
      }
    }
  }

  return selected;
}

/**
 * competitor_sellers 크롤 실행.
 *
 * 기본 동작 = 티어 기반 스케줄:
 *   - Tier F/D 매일, C 는 3일 주기, B 는 7일 로테이션, A 는 14일 로테이션
 *   - 대형 셀러 (수천 리스팅) 는 crawl_chunk_size 만큼 청크로 이어 크롤
 *
 * @param {object} opts
 * @param {string[]} [opts.sellerIds]        - 특정 셀러 강제 실행 (스케줄 무시)
 * @param {boolean}  [opts.silent]           - 콘솔 출력 억제
 * @param {boolean}  [opts.ignoreSchedule]   - 티어 스케줄 무시하고 active 전부 (레거시)
 * @returns {{ sellers, selected, totalNew, totalUpdated, totalPriceChanges, totalErrors, details }}
 */
async function runCrawler({ sellerIds, silent = false, ignoreSchedule = false } = {}) {
  const db = getClient();

  if (!silent) console.log('[Crawler] ===== 경쟁사 크롤러 시작 (티어 기반) =====');

  // 1. active 셀러 로드 — 신규 컬럼 시도 후 없으면 fallback
  let sellers = null;
  let sellerErr = null;
  {
    let query = db
      .from('competitor_sellers')
      .select('id, seller_id, seller_name, platform, active, last_crawled_at, listing_count, crawl_tier, next_crawl_offset, crawl_chunk_size, crawl_cycle_started_at')
      .eq('active', true)
      .order('last_crawled_at', { ascending: true, nullsFirst: true });
    if (sellerIds && sellerIds.length > 0) query = query.in('seller_id', sellerIds);
    const r = await query;
    sellers = r.data;
    sellerErr = r.error;
    // migration 070 미적용
    if (sellerErr && sellerErr.code === '42703') {
      console.warn('[Crawler] 신규 컬럼 없음 (migration 070 미적용) — legacy 스키마로 폴백');
      let q2 = db
        .from('competitor_sellers')
        .select('id, seller_id, seller_name, platform, active, last_crawled_at, listing_count')
        .eq('active', true)
        .order('last_crawled_at', { ascending: true, nullsFirst: true });
      if (sellerIds && sellerIds.length > 0) q2 = q2.in('seller_id', sellerIds);
      const r2 = await q2;
      sellers = r2.data;
      sellerErr = r2.error;
    }
  }

  if (sellerErr) {
    console.error('[Crawler] 셀러 로드 실패:', sellerErr.message);
    return { sellers: 0, selected: 0, totalNew: 0, totalUpdated: 0, totalPriceChanges: 0, totalErrors: 1, details: [] };
  }

  if (!sellers || sellers.length === 0) {
    if (!silent) console.log('[Crawler] active 셀러 없음');
    return { sellers: 0, selected: 0, totalNew: 0, totalUpdated: 0, totalPriceChanges: 0, totalErrors: 0, details: [] };
  }

  // 2. 오늘 크롤할 셀러 선정 (명시적 sellerIds 아니면 티어 스케줄)
  const targets = (sellerIds && sellerIds.length > 0) || ignoreSchedule
    ? sellers
    : selectTodaysSellers(sellers);

  if (!silent) {
    console.log(`[Crawler] active 전체 ${sellers.length}명 → 오늘 처리 ${targets.length}명`);
    for (const t of targets) {
      const tier = t.crawl_tier || 'B';
      const offset = parseInt(t.next_crawl_offset) || 0;
      const badge = offset > 0 ? `이어받기 offset=${offset}` : `${tier}티어 신규`;
      console.log(`  → ${t.seller_id} (${badge})`);
    }
  }

  if (targets.length === 0) {
    if (!silent) console.log('[Crawler] 오늘 처리할 셀러 없음 (다음 스케줄 대기)');
    return { sellers: sellers.length, selected: 0, totalNew: 0, totalUpdated: 0, totalPriceChanges: 0, totalErrors: 0, details: [] };
  }

  // 3. 셀러별 순차 처리 (eBay rate limit 준수)
  let totalNew = 0;
  let totalUpdated = 0;
  let totalPriceChanges = 0;
  let totalErrors = 0;
  const details = [];

  for (const seller of targets) {
    let res;
    try {
      res = await crawlSeller(seller);
    } catch (e) {
      console.error(`[Crawler] 셀러 처리 중 예외 (${seller.seller_name}):`, e.message);
      res = {
        sellerId: seller.seller_id,
        sellerName: seller.seller_name || seller.seller_id,
        newItems: 0,
        updatedItems: 0,
        priceChanges: 0,
        statusChanges: 0,
        errors: [e.message],
        nextOffset: parseInt(seller.next_crawl_offset) || 0,
        cycleComplete: false,
      };
    }

    totalNew          += res.newItems;
    totalUpdated      += res.updatedItems;
    totalPriceChanges += res.priceChanges;
    totalErrors       += (res.errors || []).length;
    details.push(res);

    // 셀러 간 딜레이 (eBay rate limit 여유)
    await sleep(2000);
  }

  const summary = {
    sellers: sellers.length,
    selected: targets.length,
    totalNew,
    totalUpdated,
    totalPriceChanges,
    totalErrors,
    details,
  };

  if (!silent) {
    console.log(
      `[Crawler] ===== 완료 ===== ` +
      `active: ${summary.sellers}, 처리: ${summary.selected}, 신규: ${totalNew}, ` +
      `업데이트: ${totalUpdated}, 가격변동: ${totalPriceChanges}, 오류: ${totalErrors}`
    );
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { runCrawler, crawlSeller, selectTodaysSellers };
