'use strict';

/**
 * seed-sku-master-from-ebay.js — ebay_products → sku_master 자동 시딩
 * ---------------------------------------------------------------------------
 * 문제: Engine 1 dry-run에서 sku_master 매칭 0건 (eBay SKU가 WMS 마스터에 미등록).
 * 해결: ebay_products의 SKU를 sku_master에 등록(원가/무게는 NULL — 직원이 CSV로 보완)
 *       + sku_listing_link(ebay) 연결.
 *
 * 안전: INSERT only (기존 행 절대 수정 안 함). 재실행해도 중복 생성 없음.
 * 실행: node scripts/seed-sku-master-from-ebay.js          (dry-run — 개수만 출력)
 *       node scripts/seed-sku-master-from-ebay.js --apply  (실제 등록)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { validateEbaySkuAuthority } = require('../src/services/ebay/skuAuthorityValidator');

const APPLY = process.argv.includes('--apply');

async function main() {
  const db = getClient();

  // 1. eBay 리스팅 로드 (ended 제외, sku 있는 것만)
  const ebayBySku = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await db.from('ebay_products')
      .select('sku, title, item_id, status')
      .neq('status', 'ended')
      .range(from, from + 999);
    if (error) throw new Error(`ebay_products 로드 실패: ${error.message}`);
    for (const p of data || []) {
      const sku = (p.sku || '').trim();
      if (!sku) continue;
      if (!ebayBySku.has(sku)) ebayBySku.set(sku, p); // sku 중복 시 첫 행 사용
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  console.log(`[seed] ebay_products 고유 SKU: ${ebayBySku.size}개`);

  // 2. 이미 sku_master에 있는 SKU 제외
  const allSkus = [...ebayBySku.keys()];
  const existing = new Set();
  for (let i = 0; i < allSkus.length; i += 500) {
    const { data, error } = await db.from('sku_master')
      .select('internal_sku')
      .in('internal_sku', allSkus.slice(i, i + 500));
    if (error) throw new Error(`sku_master 조회 실패: ${error.message}`);
    for (const s of data || []) existing.add(s.internal_sku);
  }
  const toCreateRaw = allSkus.filter((s) => !existing.has(s));

  //   Phase 8P-22B · Authority guard.
  //   Reject candidate SKUs where the value is not a safe authoritative eBay SKU
  //   (price-shaped / uuid fallback / blank / non-unique-across-listings). Skipped
  //   SKUs are reported per bucket · never silently discarded.
  const mskuToListings = new Map();
  for (const [sku, p] of ebayBySku.entries()) {
    if (!p.item_id) continue;
    if (!mskuToListings.has(sku)) mskuToListings.set(sku, new Set());
    mskuToListings.get(sku).add(String(p.item_id));
  }
  const counters = {
    safe_seeded: 0, skipped_blank: 0, skipped_price_shaped: 0,
    skipped_uuid_artifact: 0, skipped_non_unique: 0, skipped_other_invalid: 0,
  };
  const quarantine = [];
  const toCreate = [];
  for (const sku of toCreateRaw) {
    const observed = mskuToListings.get(sku) || new Set();
    //   eBay's uuid fallback shows up as ebay_products.sku when the seller left SKU
    //   blank and our ingest wrapper injected a canonical UUID. Treat any UUID-shape
    //   arriving via seed as generated fallback (canonicalUuidArtifact:true).
    const v = validateEbaySkuAuthority(sku, {
      canonicalUuidArtifact: true,
      observedListingIds: observed,
    });
    if (v.ok) { toCreate.push(sku); continue; }
    quarantine.push({ sku, verdict: v.verdict, reason: v.reason, observed_listing_count: observed.size });
    switch (v.verdict) {
      case 'INVALID_BLANK':        counters.skipped_blank += 1; break;
      case 'INVALID_PRICE_SHAPED': counters.skipped_price_shaped += 1; break;
      case 'INVALID_UUID_ARTIFACT':counters.skipped_uuid_artifact += 1; break;
      case 'INVALID_NON_UNIQUE':   counters.skipped_non_unique += 1; break;
      default:                     counters.skipped_other_invalid += 1;
    }
  }
  console.log(`[seed] 기존 등록 ${existing.size}개 · 신규 등록 대상 ${toCreate.length}개 · 22B guard skip=${toCreateRaw.length - toCreate.length}`);
  console.log(`[seed:22B] price=${counters.skipped_price_shaped} uuid=${counters.skipped_uuid_artifact} non_unique=${counters.skipped_non_unique} blank=${counters.skipped_blank} other=${counters.skipped_other_invalid}`);
  if (quarantine.length > 0) {
    const fs = require('fs'); const path = require('path');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const qPath = path.join(__dirname, `../logs/seed-sku-master-quarantine-${stamp}.json`);
    try {
      fs.mkdirSync(path.dirname(qPath), { recursive: true });
      fs.writeFileSync(qPath, JSON.stringify(quarantine, null, 2));
      console.log(`[seed:22B] quarantine → ${qPath}`);
    } catch (e) { console.warn(`[seed:22B] quarantine write skipped: ${e.message}`); }
  }

  if (!APPLY) {
    console.log('[seed] dry-run 모드 — 실제 등록하려면: node scripts/seed-sku-master-from-ebay.js --apply');
    return { counters, quarantineCount: quarantine.length, wouldCreate: toCreate.length };
  }

  // 3. sku_master INSERT (원가/무게 NULL → Engine 1이 BLOCK으로 잡고 CSV로 보완)
  let created = 0;
  for (let i = 0; i < toCreate.length; i += 500) {
    const batch = toCreate.slice(i, i + 500).map((sku) => {
      const p = ebayBySku.get(sku);
      return {
        internal_sku: sku,
        title: (p.title || sku).slice(0, 255),
        status: 'active',
        automation_enabled: false, // 자동화 게이트 — 대표가 SKU별로 ON
        weight_status: 'unknown',
        notes: 'ebay_products 자동 시딩 (engine1)',
      };
    });
    const { error } = await db.from('sku_master').insert(batch);
    if (error) throw new Error(`sku_master insert 실패(${i}~): ${error.message}`);
    created += batch.length;
    console.log(`[seed] sku_master ${created}/${toCreate.length} 등록...`);
  }
  counters.safe_seeded = created;

  // 4. sku_listing_link 연결 (item_id 있는 것만, 중복은 skip)
  //    ebay_products 의 모든 SKU 를 대상 (이번 실행에서 신규 등록된 것 + 이미 있던 것 포함)
  //    2026-07-10 fix: 이전엔 .in('internal_sku', toCreate.slice(0,5000)) 로 5000개 상한 +
  //    신규 등록만 처리해서 재실행 시 listing_link 가 0개로 남았음. 500 개씩 배치 조회로 변경.
  const idBySku = new Map();
  for (let i = 0; i < allSkus.length; i += 500) {
    const chunk = allSkus.slice(i, i + 500);
    const { data: masters, error: mErr } = await db.from('sku_master')
      .select('id, internal_sku').in('internal_sku', chunk);
    if (mErr) throw new Error(`sku_master id 조회 실패: ${mErr.message}`);
    (masters || []).forEach((m) => idBySku.set(m.internal_sku, m.id));
  }
  //    이미 존재하는 링크는 skip — 신규 링크만 저장.
  const { data: existingLinks } = await db.from('sku_listing_link')
    .select('listing_id').eq('marketplace', 'ebay').limit(20000);
  const linkedListingIds = new Set((existingLinks || []).map((r) => String(r.listing_id)));
  let linked = 0;
  const links = allSkus
    .map((sku) => {
      const p = ebayBySku.get(sku);
      const skuId = idBySku.get(sku);
      if (!skuId || !p.item_id) return null;
      if (linkedListingIds.has(String(p.item_id))) return null;
      return { sku_id: skuId, marketplace: 'ebay', listing_id: String(p.item_id), marketplace_sku: sku, is_primary: true };
    })
    .filter(Boolean);
  console.log(`[seed] listing_link 시도 대상 ${links.length}건 (기존 ${linkedListingIds.size} 제외)`);
  for (let i = 0; i < links.length; i += 500) {
    const { error } = await db.from('sku_listing_link').insert(links.slice(i, i + 500));
    if (error) console.warn(`[seed] listing_link 일부 실패(무시 — 중복 가능): ${error.message}`);
    else linked += Math.min(500, links.length - i);
  }

  console.log(`[seed] 완료 — sku_master ${created}개 생성 · listing_link ${linked}개 연결`);
  console.log('[seed] 다음: SKU 마스터 화면에서 "미입력 SKU 템플릿" 다운로드 → 원가/무게 입력 → CSV 업로드');
  return { counters, quarantineCount: quarantine.length, created, linked };
}

module.exports = { main };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('[seed] 실패:', e.message); process.exit(1); });
}
