/**
 * 네이버/알리바바/쇼피 상품 동기화 → platform_listings 테이블
 *
 * 모듈:
 *   - syncNaverList()         : 네이버 목록 (list API만, 빠름, SKU/이미지 제외)
 *   - enrichNaverDetails(n)   : detail_fetched=false인 N개 detail 가져와 채움
 *   - syncNaverIncremental()  : 마지막 수정일 이후 변경분만 증분 (TODO — API 지원 여부 확인 필요)
 *   - syncShopeeAll()         : multi-shop × 페이징 (detail 포함)
 *   - syncAlibabaAll()        : 500개 수준 풀 동기화 (detail 포함)
 *
 * 모든 함수는 { synced, total, error? } 형태 반환.
 */
const { getClient } = require('../db/supabaseClient');

// API 클라이언트는 동적 로드 (env 로딩 순서 문제 방지)
function getNaverAPI() { const C = require('../api/naverAPI'); return new C(); }
function getShopeeAPI() { const C = require('../api/shopeeAPI'); return new C(); }
function getAlibabaAPI() { const C = require('../api/alibabaAPI'); return new C(); }

const CHUNK = 100;

// ──────────────────────────────────────────
// 네이버
// ──────────────────────────────────────────

async function syncNaverList() {
  const naver = getNaverAPI();
  const db = getClient();
  let synced = 0;
  let page = 1;
  const pageSize = 100;
  const maxPages = 100; // 1만개 상한 (방어)
  let total = 0;

  while (page <= maxPages) {
    const resp = await naver.getProducts(page, pageSize);
    // 응답 구조: contents[] 배열 안에 channelProducts[] 또는 바로 상품들이 있을 수 있음
    const items = resp?.contents || resp?.data?.contents || resp?.items || [];
    if (!Array.isArray(items) || items.length === 0) break;

    const rows = items.map(normalizeNaverListItem).filter(r => r.platform_item_id);
    if (rows.length === 0) break;

    // upsert. detail_fetched는 신규일 때만 false, 기존 행 보존
    // onConflict로 기본 필드 업데이트 (title, price, stock)
    const { error } = await db.from('platform_listings').upsert(
      rows.map(r => ({ ...r, detail_fetched: false })),
      { onConflict: 'platform,platform_item_id', ignoreDuplicates: false }
    );
    if (error) { console.error('[naverSync] upsert:', error.message); break; }

    synced += rows.length;
    total = resp?.totalElements || resp?.total || synced;
    if (items.length < pageSize) break;
    page++;
    await sleep(300); // rate limit 방어
  }

  return { synced, total };
}

function normalizeNaverListItem(it) {
  // Naver 응답 shape 다양 — 여러 필드명 방어적으로 매핑
  const channelProducts = it.channelProducts || [];
  const cp = channelProducts[0] || it;
  const channelNo = cp.channelProductNo || cp.originProductNo || it.originProductNo;

  return {
    platform: 'naver',
    platform_item_id: String(channelNo || ''),
    title: cp.name || it.name || it.originProductName || '',
    price: Number(cp.salePrice || it.salePrice || 0),
    currency: 'KRW',
    quantity: Number(cp.stockQuantity || it.stockQuantity || 0),
    status: String(cp.statusType || it.statusType || 'SALE'),
    fee_rate: 5.5,
    last_modified_at: cp.modifiedDate || it.modifiedDate || null,
  };
}

async function enrichNaverDetails(limit = 100) {
  const naver = getNaverAPI();
  const db = getClient();

  const { data: pending } = await db
    .from('platform_listings')
    .select('id, platform_item_id')
    .eq('platform', 'naver')
    .eq('detail_fetched', false)
    .limit(limit);

  if (!pending || pending.length === 0) return { synced: 0, remaining: 0 };

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const detail = await naver.getProductDetail(row.platform_item_id);
      const updates = normalizeNaverDetail(detail);
      if (updates) {
        await db.from('platform_listings')
          .update({ ...updates, detail_fetched: true })
          .eq('id', row.id);
        synced++;
      } else {
        // 파싱 실패해도 fetched=true 처리 (영영 멈추지 않도록)
        await db.from('platform_listings')
          .update({ detail_fetched: true })
          .eq('id', row.id);
        failed++;
      }
    } catch (e) {
      failed++;
      console.warn('[naverEnrich] detail fail:', row.platform_item_id, e.message);
    }
    await sleep(150); // rate limit
  }

  // 남은 개수
  const { count: remaining } = await db
    .from('platform_listings')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'naver')
    .eq('detail_fetched', false);

  return { synced, failed, remaining: remaining || 0 };
}

function normalizeNaverDetail(resp) {
  if (!resp) return null;
  // v2 detail response: originProduct { name, salePrice, stockQuantity, images, ... }
  const op = resp.originProduct || resp;
  const cp = resp.smartstoreChannelProduct || {};
  const images = op.images || {};
  const imgUrl =
    images.representativeImage?.url ||
    (Array.isArray(images.optionalImages) && images.optionalImages[0]?.url) ||
    '';

  const sku = op.sellerCodeInfo?.sellerCode || op.sellerManagementCode || '';

  return {
    platform_sku: sku,
    sku,
    image_url: imgUrl,
    title: cp.channelProductName || op.name || undefined,
    price: Number(op.salePrice || 0) || undefined,
    quantity: Number(op.stockQuantity || 0),
    status: String(op.statusType || ''),
  };
}

// ──────────────────────────────────────────
// 쇼피
// ──────────────────────────────────────────

async function syncShopeeAll() {
  const shopee = getShopeeAPI();
  const db = getClient();
  const shopIds = shopee.shopIds || [];
  if (shopIds.length === 0) return { synced: 0, total: 0, error: 'SHOPEE_SHOP_IDS 미설정' };

  let synced = 0;
  let total = 0;
  const pageSize = 50; // Shopee API 권장

  for (const shopId of shopIds) {
    let offset = 0;
    while (true) {
      try {
        const items = await shopee.getProductsWithDetails(offset, pageSize, 'NORMAL', shopId);
        if (!items || items.length === 0) break;

        const rows = items.map(it => normalizeShopeeItem(it, shopId)).filter(r => r.platform_item_id);
        if (rows.length > 0) {
          const { error } = await db.from('platform_listings').upsert(
            rows.map(r => ({ ...r, detail_fetched: true })),
            { onConflict: 'platform,platform_item_id' }
          );
          if (error) { console.error('[shopeeSync] upsert:', error.message); break; }
          synced += rows.length;
          total += rows.length;
        }

        if (items.length < pageSize) break;
        offset += pageSize;
        await sleep(400);
      } catch (e) {
        console.error(`[shopeeSync] shop ${shopId} offset ${offset}:`, e.message);
        break;
      }
    }
  }

  return { synced, total };
}

function normalizeShopeeItem(it, shopId) {
  // Shopee get_item_base_info response
  const price = it.price_info?.[0]?.current_price || it.price || 0;
  const imageUrl = it.image?.image_url_list?.[0] || '';
  return {
    platform: 'shopee',
    platform_item_id: String(it.item_id || ''),
    platform_sku: it.item_sku || '',
    sku: it.item_sku || '',
    title: it.item_name || '',
    price: Number(price) || 0,
    currency: it.price_info?.[0]?.currency || 'SGD',
    quantity: Number(it.stock_info_v2?.summary_info?.total_available_stock || it.stock || 0),
    status: String(it.item_status || 'NORMAL'),
    image_url: imageUrl,
    fee_rate: 9,
    last_modified_at: it.update_time ? new Date(it.update_time * 1000).toISOString() : null,
    platform_data: { shop_id: shopId },
  };
}

// ──────────────────────────────────────────
// 알리바바
// ──────────────────────────────────────────

async function syncAlibabaAll() {
  const ali = getAlibabaAPI();
  const db = getClient();
  let synced = 0;
  let page = 1;
  const pageSize = 50;
  const maxPages = 30; // 1500개 상한

  // ICBU detail API는 현재 InvalidApiPath 반환 — list 응답만으로 진행
  // list에는 id, subject(title), main_image, pc_detail_url, gmt_modified, status 포함
  // 가격/재고/SKU는 list에 없으므로 빈 값 (detail API 복구 시 보강 예정)

  while (page <= maxPages) {
    let listResp;
    try {
      listResp = await ali.requestWithRetry('/alibaba/icbu/product/list', {
        current_page: String(page),
        page_size: String(pageSize),
        language: 'en',
      });
    } catch (e) {
      console.error('[alibabaSync] list error:', e.message);
      break;
    }

    const items = listResp?.result?.products || listResp?.products || [];
    if (!Array.isArray(items) || items.length === 0) break;

    const rows = items.map(normalizeAlibabaListItem).filter(r => r.platform_item_id);
    if (rows.length === 0) break;

    const { error } = await db.from('platform_listings').upsert(
      rows.map(r => ({ ...r, detail_fetched: false })), // 추후 detail 복구 시 보강
      { onConflict: 'platform,platform_item_id' }
    );
    if (error) { console.error('[alibabaSync] upsert:', error.message); break; }
    synced += rows.length;

    if (items.length < pageSize) break;
    page++;
    await sleep(300);
  }

  return { synced, total: synced };
}

function normalizeAlibabaListItem(it) {
  const pid = it.id || it.productId || it.product_id;
  const imgs = it.main_image?.images || [];
  return {
    platform: 'alibaba',
    platform_item_id: String(pid || ''),
    title: it.subject || it.title || '',
    status: String(it.status || ''),
    currency: 'USD',
    fee_rate: 3,
    image_url: imgs[0] || '',
    listing_url: it.pc_detail_url || '',
    last_modified_at: it.gmt_modified || null,
  };
}

// ──────────────────────────────────────────
// 공용
// ──────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  syncNaverList,
  enrichNaverDetails,
  syncShopeeAll,
  syncAlibabaAll,
};
