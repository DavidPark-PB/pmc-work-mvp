'use strict';
/**
 * listingSot.js — B2C · Phase 7 · QC PASS 시 Listing SoT (기존 구조) 반영.
 *
 * Owner directive (§10):
 *   · 새로운 listing table 만들지 말고 기존 재사용:
 *       · sku_listing_link : SKU ↔ marketplace listing mapping
 *       · platform_listings: 실제 listing 상태/가격
 *   · QC PASS 시 이 두 곳에 UPSERT · Channel Matrix 에서 정상 조회 되게.
 *   · 실패해도 QC PASS 자체는 성공 · SoT 반영 실패는 별도 로그 (task 자체는 done)
 */

//   ── UPSERT sku_listing_link ────────────────────────
async function upsertSkuListingLink({ db, sku_master_id, marketplace, listing_id, marketplace_sku }) {
  //   기존 UNIQUE(marketplace, listing_id, option_id) 존재 (038 migration)
  //   option_id 는 nullable · 여기서는 null · Postgres UPSERT 시 UNIQUE 매칭이 null 을 다르게 취급해도
  //   먼저 SELECT 로 존재 확인 후 UPDATE/INSERT 분기 (안전)
  const now = new Date().toISOString();
  //   SELECT existing
  const { data: existing, error: eSel } = await db.from('sku_listing_link')
    .select('id, sku_id, marketplace, listing_id, marketplace_sku')
    .eq('sku_id', sku_master_id)
    .eq('marketplace', marketplace)
    .eq('listing_id', listing_id)
    .limit(1);
  if (eSel) return { ok: false, code: 'SLL_SELECT_FAILED', error: eSel.message };
  if (existing && existing.length > 0) {
    const patch = { updated_at: now };
    if (marketplace_sku) patch.marketplace_sku = marketplace_sku;
    const { error } = await db.from('sku_listing_link').update(patch).eq('id', existing[0].id);
    if (error) return { ok: false, code: 'SLL_UPDATE_FAILED', error: error.message };
    return { ok: true, code: 'SLL_UPDATED', link_id: existing[0].id };
  }
  //   INSERT
  const { data: ins, error } = await db.from('sku_listing_link').insert({
    sku_id: sku_master_id, marketplace, listing_id,
    marketplace_sku: marketplace_sku || null,
    is_primary: false,
  }).select('id').maybeSingle();
  if (error) return { ok: false, code: 'SLL_INSERT_FAILED', error: error.message };
  return { ok: true, code: 'SLL_INSERTED', link_id: ins?.id };
}

//   ── UPSERT platform_listings (기존 UNIQUE (platform, platform_item_id)) ─
async function upsertPlatformListing({ db, sku_master, marketplace, listing_id, listing_url, selling_price }) {
  //   sku_master: { id, internal_sku, title, cost_krw } 등
  const now = new Date().toISOString();
  const { data: existing, error: eSel } = await db.from('platform_listings')
    .select('id, platform, platform_item_id, sku, status')
    .eq('platform', marketplace)
    .eq('platform_item_id', listing_id)
    .limit(1);
  if (eSel) return { ok: false, code: 'PL_SELECT_FAILED', error: eSel.message };
  //   status 통일 · Phase 3 view (v_sku_channel_matrix) LIVE 분류 기준: 'active'/'SALE'/'NORMAL'/'approved'
  //   channel 별 표준 status 값:
  //     ebay/shopify: 'active' · naver: 'SALE' · shopee: 'NORMAL' · alibaba: 'approved'
  //     coupang/11st/gmarket 은 기존 데이터 없음 → 'active' 로 통일 (view 는 lower(pl.status) in ('active',...) 매칭)
  const STATUS_MAP = {
    ebay: 'active', shopify: 'active', naver: 'SALE', shopee: 'NORMAL', alibaba: 'approved',
    coupang: 'active', '11st': 'active', gmarket: 'active', auction: 'active',
  };
  const st = STATUS_MAP[marketplace] || 'active';
  const patch = {
    platform: marketplace,
    platform_item_id: listing_id,
    sku: sku_master?.internal_sku || null,
    title: sku_master?.title || null,
    listing_url: listing_url,
    price: selling_price,
    status: st,
    updated_at: now,
    last_synced_at: now,
  };
  if (existing && existing.length > 0) {
    const { error } = await db.from('platform_listings').update(patch).eq('id', existing[0].id);
    if (error) return { ok: false, code: 'PL_UPDATE_FAILED', error: error.message };
    return { ok: true, code: 'PL_UPDATED', platform_listing_id: existing[0].id };
  }
  //   INSERT · 컬럼 defaults 는 기존 스키마에 맡김
  const { data: ins, error } = await db.from('platform_listings').insert({
    ...patch,
    created_at: now,
  }).select('id').maybeSingle();
  if (error) return { ok: false, code: 'PL_INSERT_FAILED', error: error.message };
  return { ok: true, code: 'PL_INSERTED', platform_listing_id: ins?.id };
}

//   ── High-level entry · QC PASS 에서 호출 ─────────
async function upsertListingFromTask({ db, sku_master_id, channel, listing_id, listing_url, selling_price }) {
  //   sku_master 조회
  const { data: sku, error: eSku } = await db.from('sku_master').select('id, internal_sku, title, cost_krw').eq('id', sku_master_id).maybeSingle();
  if (eSku) return { ok: false, code: 'SKU_LOAD_FAILED', error: eSku.message };
  if (!sku) return { ok: false, code: 'SKU_NOT_FOUND' };
  const sll = await upsertSkuListingLink({ db, sku_master_id, marketplace: channel, listing_id, marketplace_sku: null });
  const pl = await upsertPlatformListing({ db, sku_master: sku, marketplace: channel, listing_id, listing_url, selling_price });
  return { ok: sll.ok && pl.ok, sll, pl };
}

module.exports = {
  upsertSkuListingLink,
  upsertPlatformListing,
  upsertListingFromTask,
};
