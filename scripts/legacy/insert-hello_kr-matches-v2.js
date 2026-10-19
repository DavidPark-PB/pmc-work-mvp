#!/usr/bin/env node
// ⛔ PR-A (2026-10-20) · 이 스크립트는 폐기됨. product_matches 자동 승인은 금지.
//    승인 경로는 UI 및 Slack 검수만. DB CHECK 제약 (migration 119) 이 영구 차단.
//    실행 복구가 필요하면 사장님과 상의 후 검토.
throw new Error("[LEGACY] 이 스크립트는 폐기됨 (PR-A 2026-10-20). 사장님 승인 없이 실행 금지.");

/**
 * hello_kr Claude 수동 매칭 배치 2 (2026-07-19).
 * 판매 상위 300개 확대 후 신규 확정 9건.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');

const MATCHES = [
  ['355863337843', '204850480901', 0.90, 'Samsung Buds POKEMON Monster Ball 4 Types — 동일 상품 라인'],
  ['358740625306', '206268965884', 0.92, 'Starbucks 2026 Jeju Haenyeo Bearista Keychain — 완벽 매치'],
  ['356537895205', '205281854386', 0.95, 'Starbucks DearLove Locket Mirror Keychain V-Day — 완벽 매치'],
  ['355011150066', '205547865214', 0.88, 'Pokemon Ditto Metamon Galaxy Buds Case — 같은 라인'],
  ['358190548143', '206065587339', 0.95, 'Starbucks 2026 LuvBunny Kona 237ml V-Day — 완벽 매치'],
  ['354559858667', '205301587125', 0.93, 'Gogo Dino 17 Type Transformation Robot — 완벽 매치'],
  ['356502628363', '205282002366', 0.90, 'Starbucks 2025 Snowboard Bearista Keychain — 매치'],
  ['358064338236', '205992433883', 0.95, 'Starbucks 2026 Baby Pony Bearista Keychain — 완벽 매치'],
  ['358276855857', '206067535905', 0.92, 'Starbucks 2026 Positive Pink Love Waterbottle 414ml — 매치'],
];

async function main() {
  const db = getClient();
  const skus = [...new Set(MATCHES.map(m => m[1]))];
  const skuToItemId = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const chunk = skus.slice(i, i + 500);
    const { data } = await db.from('ebay_products').select('sku, item_id').in('sku', chunk);
    (data || []).forEach(r => skuToItemId.set(r.sku, r.item_id));
  }

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

  // dedup 기존
  const compIds = rows.map(r => r.competitor_item_id);
  const { data: existing } = await db.from('product_matches')
    .select('competitor_item_id').in('competitor_item_id', compIds);
  const existingSet = new Set((existing || []).map(r => r.competitor_item_id));
  const newRows = rows.filter(r => !existingSet.has(r.competitor_item_id));

  console.log(`총 ${rows.length}건 중 신규 ${newRows.length}건 (기존 ${existingSet.size}건 스킵)`);
  if (newRows.length === 0) return;
  const { data, error } = await db.from('product_matches').insert(newRows).select();
  if (error) { console.error(error); return; }
  console.log(`✅ ${data?.length || 0}건 신규 매칭 추가`);
}

main().catch(e => { console.error(e); process.exit(1); });
