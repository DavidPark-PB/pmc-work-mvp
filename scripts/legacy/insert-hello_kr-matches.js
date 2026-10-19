#!/usr/bin/env node
// ⛔ PR-A (2026-10-20) · 이 스크립트는 폐기됨. product_matches 자동 승인은 금지.
//    승인 경로는 UI 및 Slack 검수만. DB CHECK 제약 (migration 119) 이 영구 차단.
//    실행 복구가 필요하면 사장님과 상의 후 검토.
throw new Error("[LEGACY] 이 스크립트는 폐기됨 (PR-A 2026-10-20). 사장님 승인 없이 실행 금지.");

/**
 * hello_kr Claude 수동 매칭 27건 INSERT.
 * 2026-07-18 사장님 지침: API 크레딧 없이 Claude Code (Max 구독) 안에서 직접 판정.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');

// [competitor_item_id, our_sku, confidence, reason]
const MATCHES = [
  ['354498113916', '204850480901', 0.90, 'Samsung Pokemon Galaxy Buds Monster Ball case — 동일 상품'],
  ['354434508599', '205394203674', 0.95, 'Takara Tomy Beyblade BB-118 Phantom Orion B:D — 완벽 매치'],
  ['355368582241', '204424692224', 0.95, 'Pinkfong Wonderstar Detective Pinkfong Hogi Figure 6 Set — 완벽 매치'],
  ['355064899835', '205444355201', 0.98, 'Starbucks Korea 2023 SS The 1st store Opera tumbler 473ml — 완벽 매치'],
  ['356457657285', '205282031363', 0.92, 'Squid Game Younghee Jinro Chamisul Soju Toy Figure — 매치'],
  ['355115683419', '205395973641', 0.90, 'Takara Tomy Beyblade BB-108 L Drago Destroy F:S — 매치'],
  ['354908726916', '205394211390', 0.92, 'Takara Tomy Sonokong Beyblade Ray Unicorno D125CS — 매치'],
  ['355368438153', '205409499120', 0.93, 'Splendor Pokemon Edition Board Game Korea — 매치'],
  ['354935724093', '205583613555', 0.92, 'Starbucks 2023 Blackpink Pink Stud Coldcup 710ml — 매치'],
  ['356414362099', '205279385293', 0.98, 'Starbucks Korea 2025 Harry Potter Desk Organizer — 완벽 매치'],
  ['356419950019', '204321483823', 0.98, 'NMIXX FANLIGHT LIGHT STICK — 완벽 매치'],
  ['354308915181', '203842355435', 0.90, 'Starbucks 2022 Sweetlove SS DW To Go Tumbler 473ml — 매치'],
  ['356459655507', '205282031363', 0.90, 'Squid Game Younghee (다른 SKU 로 매칭, 같은 our_sku 재사용)'],
  ['355047167872', '205890487076', 0.90, 'TOBOT MINI New Tobot X+Y+Z Robot Set — 매치'],
  ['356258502259', '205299213013', 0.95, 'Pat a Pat Como COMO Model Cut Soft Doll Plush 25cm — 완벽 매치'],
  ['356238722740', '205306616309', 0.90, 'Hyundai IONIQ 5 1:38 Mini Diecast — 매치'],
  ['356238620588', '205306526344', 0.92, 'Hyundai SANTAFE MX5 Mini Diecast 1:38 — 매치'],
  ['357387354918', '205619827269', 0.92, 'Starbucks Korea 2025 SS Aloha Bearista Keychain — 매치'],
  ['358069419124', '205992320740', 0.92, 'Starbucks Korea 2026 Friends Turkish/Turkey Bearista Keychain — 매치'],
  ['354451441718', '205352148816', 0.92, 'Hyundai Motor Car SONATA DN8 Mini Diecast 1:38 — 매치'],
  ['356598435370', '205262914257', 0.93, 'Catch Teenieping Shooting Star Season 5 Pact — 매치'],
  ['356188752521', '205306631872', 0.95, 'Hyundai Motor Car STARIA Lounge Diecast Mini Car 1:38 — 매치'],
  ['356686564894', '205297121340', 0.95, 'Pokemon Card Scarlet & Violet Triplet Beat Booster Box sv1a Korean — 완벽 매치'],
  ['358716772002', '206413360716', 0.95, 'Starbucks Korea 2026 SS Summer Fest Dion Coldcup 591ml — 매치'],
  ['356335849030', '205730970641', 0.90, 'Hite Jinro Frog Toad Figure Blue & Pink Couple Set — 매치'],
  ['356667257671', '203131393653', 0.95, 'Pinkfong Baby Shark Pop-up Smartphone Melody Toy — 완벽 매치'],
  ['354480154532', '204373377384', 0.88, 'KIA Motor Car EV6 (GT variant) Mini Diecast 1:38 — 매치'],
];

async function main() {
  const db = getClient();

  // our_sku → our_item_id 매핑 로드
  const skus = [...new Set(MATCHES.map(m => m[1]))];
  const skuToItemId = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const chunk = skus.slice(i, i + 500);
    const { data } = await db.from('ebay_products').select('sku, item_id').in('sku', chunk);
    (data || []).forEach(r => skuToItemId.set(r.sku, r.item_id));
  }

  // INSERT rows
  const now = new Date().toISOString();
  const rows = MATCHES.map(([compId, ourSku, conf, reason]) => ({
    our_sku: ourSku,
    our_item_id: skuToItemId.get(ourSku) || null,
    competitor_item_id: compId,
    seller_id: 'hello_kr',
    confidence: conf,
    method: 'manual',
    ai_reason: reason,
    status: 'approved',
    approved_by: 'claude_code',
    approved_at: now,
  }));

  // 이미 있는 competitor_item_id 필터링
  const compIds = rows.map(r => r.competitor_item_id);
  const { data: existing } = await db.from('product_matches')
    .select('competitor_item_id').in('competitor_item_id', compIds);
  const existingSet = new Set((existing || []).map(r => r.competitor_item_id));
  const newRows = rows.filter(r => !existingSet.has(r.competitor_item_id));

  console.log(`[insert] ${rows.length}건 중 ${newRows.length}건 신규 (기존 ${existingSet.size}건 스킵)`);
  if (newRows.length === 0) return;

  const { data, error } = await db.from('product_matches').insert(newRows).select();
  if (error) {
    console.error('INSERT 실패:', error);
    return;
  }
  console.log(`[insert] 성공: ${data?.length || 0}건 신규 매칭 추가`);
}

main().catch(e => { console.error(e); process.exit(1); });
