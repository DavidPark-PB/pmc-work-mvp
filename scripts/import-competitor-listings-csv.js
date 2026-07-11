'use strict';

/**
 * import-competitor-listings-csv.js — 사장님이 준 경쟁 셀러 CSV 대량 import
 *
 * 배경 (2026-07-11):
 *   eBay Finding API 503 으로 크롤이 안 돌아서 competitor_listings 신선한
 *   데이터 0. 전투 상황판이 텅 빈 상태.
 *   사장님이 별도로 수집한 경쟁 리스팅 CSV 110 개 파일 (약 28 셀러) 를
 *   `~/Downloads/competitor listing/` 에 준비.
 *
 * CSV 포맷 (eBay 검색 결과 export):
 *   c1 이미지 URL
 *   c2 리스팅 URL (?itm/{itemId})
 *   c3 title
 *   c4 가격 ("$36.84")
 *   c5 판매타입 ("Buy It Now" 등)
 *   c6 배송비 ("+$2.99 delivery" or "Free shipping" or 빈값=Calculated)
 *   c7 컨디션 ("Brand New" 등)
 *   c8 총액 ("$38.78")
 *   c9 판매수/관심수 ("18 sold" or "8 watchers")
 *
 * 파일명 → 셀러:
 *   items-for-sale-by-{seller_id}-...csv
 *   또는 box-for-sale-...csv (한 파일만, 셀러 unknown → skip)
 *
 * 동작:
 *   1. 폴더 내 모든 .csv 순회
 *   2. 셀러별로 competitor_sellers upsert (crawl_tier 유지)
 *   3. 각 리스팅 competitor_listings upsert (unique on seller_id + ebay_item_id)
 *   4. 중복 파일 (같은 셀러 여러 페이지) 자동 병합
 *
 * 실행:
 *   node scripts/import-competitor-listings-csv.js "/path/to/folder"          (dry-run)
 *   node scripts/import-competitor-listings-csv.js "/path/to/folder" --apply  (실제 insert)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { getClient } = require('../src/db/supabaseClient');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FOLDER = args.find((a) => !a.startsWith('--')) || '/Users/parksungmin/Downloads/competitor listing';

// ── 파싱 헬퍼 ────────────────────────────────────────────────────────────
function extractSellerFromFilename(fname) {
  const m = fname.match(/^items-for-sale-by-([a-z0-9-]+?)---ebay/i);
  if (m) return m[1];
  return null;
}

function extractItemIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/itm\/(\d{9,15})/);
  return m ? m[1] : null;
}

function parseUsd(s) {
  if (!s) return 0;
  const m = String(s).match(/([\d,]+\.?\d*)/);
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g, '')) || 0;
}

// "+$2.99 delivery" / "Free shipping" / "" → number (0 = free or calculated)
function parseShipping(s) {
  if (!s) return 0;
  const str = String(s).toLowerCase();
  if (str.includes('free')) return 0;
  const m = str.match(/\$([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) || 0 : 0;
}

// "18 sold" / "8 watchers" / "" → { sold, watchers }
function parseSoldWatch(s) {
  if (!s) return { sold: null, watchers: null };
  const str = String(s).toLowerCase();
  const mSold = str.match(/(\d+)\s*sold/);
  const mWatch = str.match(/(\d+)\s*watch/);
  return {
    sold: mSold ? parseInt(mSold[1], 10) : null,
    watchers: mWatch ? parseInt(mWatch[1], 10) : null,
  };
}

async function main() {
  if (!fs.existsSync(FOLDER)) {
    console.error(`[import] 폴더 없음: ${FOLDER}`);
    process.exit(1);
  }
  const files = fs.readdirSync(FOLDER).filter((f) => f.endsWith('.csv'));
  console.log(`[import] 폴더: ${FOLDER}`);
  console.log(`[import] CSV 파일: ${files.length}개`);

  // ── 1. 파일 → 셀러 그룹핑 + 파싱 ─────────────────────────────────────
  const listingsBySeller = new Map();  // seller_id → Map(itemId → listing)
  const filesBySeller = new Map();      // seller_id → count
  let skippedFiles = 0;
  let totalRows = 0;

  for (const fname of files) {
    const seller = extractSellerFromFilename(fname);
    if (!seller) { skippedFiles++; continue; }

    const content = fs.readFileSync(path.join(FOLDER, fname), 'utf8');
    const parsed = Papa.parse(content, { skipEmptyLines: true });
    const rows = parsed.data || [];
    if (rows.length < 2) continue;
    // 첫 행은 헤더 — 스킵. rows[1..] = 실제 데이터.
    filesBySeller.set(seller, (filesBySeller.get(seller) || 0) + 1);

    if (!listingsBySeller.has(seller)) listingsBySeller.set(seller, new Map());
    const mp = listingsBySeller.get(seller);

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length < 4) continue;
      const image = r[0] || null;
      const url = r[1];
      const title = r[2];
      const priceStr = r[3];
      const shippingStr = r[5];
      const totalStr = r[7];
      const soldStr = r[8];
      const itemId = extractItemIdFromUrl(url);
      if (!itemId || !title) continue;

      const price = parseUsd(priceStr);
      const shipping = parseShipping(shippingStr);
      const total = totalStr ? parseUsd(totalStr) : (price + shipping);
      const sw = parseSoldWatch(soldStr);

      totalRows++;

      if (mp.has(itemId)) {
        // 이미 있으면 최신값 유지 (첫 등장이 대개 신선함)
        continue;
      }
      mp.set(itemId, {
        seller_id: seller,
        ebay_item_id: itemId,
        title: String(title).slice(0, 500),
        price,
        shipping,
        quantity_sold: sw.sold,
        image_url: image,
        url: url || `https://www.ebay.com/itm/${itemId}`,
        status: 'active',
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      });
    }
  }

  const uniqueSellers = [...listingsBySeller.keys()];
  const totalUniqueListings = uniqueSellers.reduce((s, k) => s + listingsBySeller.get(k).size, 0);
  console.log(`[import] 파싱 완료 — 총 rows ${totalRows} · 셀러 ${uniqueSellers.length} · 유니크 리스팅 ${totalUniqueListings} · 스킵 파일 ${skippedFiles}`);

  console.log('[import] 셀러별 리스팅 수:');
  const sellerCounts = uniqueSellers.map((s) => ({ seller: s, files: filesBySeller.get(s), items: listingsBySeller.get(s).size }))
    .sort((a, b) => b.items - a.items);
  sellerCounts.forEach((s) => console.log(`  ${s.seller.padEnd(18)} 파일 ${String(s.files).padStart(2)} · 리스팅 ${s.items}`));

  if (!APPLY) {
    console.log('[import] dry-run — 실제 반영: node scripts/import-competitor-listings-csv.js --apply');
    return;
  }

  const db = getClient();

  // ── 2. competitor_sellers upsert (crawl_tier 유지) ────────────────────
  const { data: existingSellers } = await db.from('competitor_sellers')
    .select('seller_id, crawl_tier, active').in('seller_id', uniqueSellers);
  const existingMap = new Map((existingSellers || []).map((r) => [r.seller_id, r]));
  const toInsertSellers = [];
  const toReactivate = [];
  for (const s of uniqueSellers) {
    const cur = existingMap.get(s);
    if (!cur) toInsertSellers.push({ seller_id: s, seller_name: s, platform: 'ebay', active: true, crawl_tier: 'B' });
    else if (!cur.active) toReactivate.push(s);
  }
  if (toInsertSellers.length > 0) {
    const { error } = await db.from('competitor_sellers').insert(toInsertSellers);
    if (error) console.warn(`[import] sellers insert 실패: ${error.message}`);
    else console.log(`[import] 신규 셀러 ${toInsertSellers.length}명 insert`);
  }
  for (const s of toReactivate) {
    await db.from('competitor_sellers').update({ active: true }).eq('seller_id', s);
  }

  // ── 3. competitor_listings 대량 upsert ───────────────────────────────
  //   unique(seller_id, ebay_item_id). 이미 있으면 UPDATE (last_seen 갱신).
  let totalInserted = 0;
  let totalErrors = 0;
  for (const seller of uniqueSellers) {
    const rows = [...listingsBySeller.get(seller).values()];
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await db.from('competitor_listings')
        .upsert(batch, { onConflict: 'seller_id,ebay_item_id', ignoreDuplicates: false });
      if (error) {
        console.warn(`[import] ${seller} upsert 실패(${i}~): ${error.message}`);
        totalErrors++;
        continue;
      }
      totalInserted += batch.length;
    }
    console.log(`[import] ${seller} — ${rows.length}개 upsert 완료 (누적 ${totalInserted})`);
  }

  console.log(`[import] 완료 — 리스팅 ${totalInserted} upsert · 오류 ${totalErrors}`);
  console.log('[import] 다음: AI 매처 재실행 → 전투 상황판에 자동 반영');
  console.log('  node -e "require(\'./src/services/aiMatcher\').runMatcher({ hours: 24*7, maxCalls: 300 })"');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[import] 실패:', e.message); console.error(e.stack); process.exit(1); });
