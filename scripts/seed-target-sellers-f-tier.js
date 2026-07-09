'use strict';

/**
 * seed-target-sellers-f-tier.js — 부록 A-3 감시 6인방을 F 티어로 지정
 *
 * 근거 (docs/commerce-os v1 계획서 §부록 A-3):
 *   나머지 20곳은 Engine 1 이 자동으로 밟는다. 아래 6곳만 사람이 촘촘히 본다.
 *     raon-kr        (TCG 저가 낱팩+박스)
 *     cardstoy       (TCG 낱팩 초저가)
 *     k-magic        (K뷰티/네일)       ← 계획서 원문엔 감시 6인방 아니지만 A-3 표에 나옴
 *     koreadoreen    (TCG 박스)
 *     siwan1004      (고액 BTS/화장품/레고)
 *     tcg-company    (TCG 고액 벌크)
 *     korshop        (TCG 고액 벌크)
 *
 *   → 계획서엔 "6인방" 이라 하지만 표에 7개. TCG-company / korshop 는 같은 카테고리로
 *     묶어 하나로 세었을 가능성. 안전하게 7개 모두 F 티어로 지정 (매일 크롤).
 *
 * 동작:
 *   1. 각 seller_id 로 competitor_sellers 조회
 *   2. 있으면 crawl_tier='F' 로 update
 *   3. 없으면 insert (active=true, crawl_tier='F')
 *   4. Idempotent — 재실행해도 안전
 *
 * 실행:
 *   node scripts/seed-target-sellers-f-tier.js          (dry-run)
 *   node scripts/seed-target-sellers-f-tier.js --apply  (실제 반영)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');

const APPLY = process.argv.includes('--apply');

// 계획서 §부록 A-3 감시 대상 (2026-07-10)
const TARGETS = [
  { seller_id: 'raon-kr',      seller_name: 'raon-kr',      memo: '부록A-3 F티어 (TCG 저가 낱팩+박스)' },
  { seller_id: 'cardstoy',     seller_name: 'cardstoy',     memo: '부록A-3 F티어 (TCG 낱팩 초저가)' },
  { seller_id: 'k-magic',      seller_name: 'k-magic',      memo: '부록A-3 F티어 (K뷰티/네일)' },
  { seller_id: 'koreadoreen',  seller_name: 'koreadoreen',  memo: '부록A-3 F티어 (TCG 박스)' },
  { seller_id: 'siwan1004',    seller_name: 'siwan1004',    memo: '부록A-3 F티어 (BTS/화장품/레고 고액)' },
  { seller_id: 'tcg-company',  seller_name: 'tcg-company',  memo: '부록A-3 F티어 (TCG 고액 벌크 · 내 요새 침입)' },
  { seller_id: 'korshop',      seller_name: 'korshop',      memo: '부록A-3 F티어 (TCG 고액 벌크 · 내 요새 침입)' },
];

async function main() {
  const db = getClient();

  const sellerIds = TARGETS.map((t) => t.seller_id);
  const { data: existing, error: qErr } = await db
    .from('competitor_sellers')
    .select('seller_id, active, crawl_tier')
    .in('seller_id', sellerIds);
  if (qErr) throw new Error(`competitor_sellers 조회 실패: ${qErr.message}`);
  const existingMap = new Map((existing || []).map((r) => [r.seller_id, r]));

  const toInsert = [];
  const toUpdate = [];
  for (const t of TARGETS) {
    const cur = existingMap.get(t.seller_id);
    if (!cur) {
      toInsert.push({
        seller_id: t.seller_id,
        seller_name: t.seller_name,
        platform: 'ebay',
        active: true,
        crawl_tier: 'F',
        memo: t.memo,
      });
    } else if (cur.crawl_tier !== 'F' || !cur.active) {
      toUpdate.push({ seller_id: t.seller_id, memo: t.memo, wasT: cur.crawl_tier, wasA: cur.active });
    }
  }

  console.log(`[F-tier] 대상 ${TARGETS.length}명 — 신규 insert ${toInsert.length}, tier update ${toUpdate.length}, 이미 F&active ${TARGETS.length - toInsert.length - toUpdate.length}`);
  for (const t of toInsert) console.log(`  + insert ${t.seller_id}`);
  for (const u of toUpdate) console.log(`  ~ update ${u.seller_id} (${u.wasT}→F, active ${u.wasA}→true)`);

  if (!APPLY) {
    console.log('[F-tier] dry-run — 실제 반영: node scripts/seed-target-sellers-f-tier.js --apply');
    return;
  }

  if (toInsert.length > 0) {
    const { error } = await db.from('competitor_sellers').insert(toInsert);
    if (error) throw new Error(`insert 실패: ${error.message}`);
    console.log(`[F-tier] insert ${toInsert.length}건 완료`);
  }
  for (const u of toUpdate) {
    const { error } = await db.from('competitor_sellers')
      .update({ crawl_tier: 'F', active: true, memo: u.memo })
      .eq('seller_id', u.seller_id);
    if (error) console.warn(`  [update 실패] ${u.seller_id}: ${error.message}`);
  }
  console.log('[F-tier] 완료 — 매일 새벽 1시 competitorCrawler 가 F 티어부터 크롤함.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[F-tier] 실패:', e.message); process.exit(1); });
