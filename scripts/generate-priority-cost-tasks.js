'use strict';

/**
 * generate-priority-cost-tasks.js
 *
 * 계약서 §BLOCK = 데이터 태스크 원칙 위에 얹는 우선순위 상세 카드.
 *
 * 배경 (2026-07-10):
 *   Engine 1 dry-run 결과 BLOCK 928 (landing_cost 397 + no_match 531).
 *   priceEventService.createBlockDataTasks 가 reason별 1장 집계 태스크는 이미
 *   생성하지만 (sample_skus 30개) 어느 SKU 부터 손대야 매출 임팩트가 큰지는
 *   담기지 않음.
 *
 *   계획서 §부록 A-1 (오가격 봉쇄) 을 시스템이 자동으로 재현한다:
 *     지고 있는 SKU (my_total > competitor_total) 중
 *     격차 × 판매수 × (landing_cost 미완 여부) 로 점수화 → top 100
 *   → 그 리스트를 별도 team_task 로 저장. 직원이 이 태스크의 context 를 열면
 *     "cost_krw / weight_gram 을 이 순서대로 채우면 매출 임팩트 크다" 는 것을
 *     한 눈에 본다.
 *
 * 실행:
 *   node scripts/generate-priority-cost-tasks.js          (dry-run — 개수/상위 5개만 출력)
 *   node scripts/generate-priority-cost-tasks.js --apply  (team_task 실제 저장)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { createExceptionTask } = require('../src/services/exceptionTask');

const APPLY = process.argv.includes('--apply');
const TOP_N = 100; // 태스크 context 에 담을 상위 개수
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  const db = getClient();

  // ── 1. 승인 매칭 로드 (product_matches approved) ──────────────────────
  const { data: matches, error: mErr } = await db
    .from('product_matches')
    .select('our_sku, competitor_item_id')
    .eq('status', 'approved');
  if (mErr) throw new Error(`product_matches: ${mErr.message}`);
  const matchesBySku = new Map();
  for (const m of matches || []) {
    if (!matchesBySku.has(m.our_sku)) matchesBySku.set(m.our_sku, []);
    matchesBySku.get(m.our_sku).push(m.competitor_item_id);
  }
  const skus = [...matchesBySku.keys()];
  console.log(`[priority] 승인 매칭 SKU: ${skus.length}개`);

  // ── 2. sku_master (cost_krw, weight_gram) 로드 ────────────────────────
  const smBySku = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const chunk = skus.slice(i, i + 500);
    const { data, error } = await db.from('sku_master')
      .select('internal_sku, cost_krw, weight_gram, width_cm, height_cm, length_cm')
      .in('internal_sku', chunk);
    if (error) throw new Error(`sku_master: ${error.message}`);
    (data || []).forEach((s) => smBySku.set(s.internal_sku, s));
  }

  // ── 3. 내 리스팅 (my_price + my_shipping) 로드 ────────────────────────
  const myBySku = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const chunk = skus.slice(i, i + 500);
    const { data, error } = await db.from('ebay_products')
      .select('sku, item_id, title, price_usd, shipping_usd, stock, sales_count')
      .neq('status', 'ended')
      .in('sku', chunk);
    if (error) throw new Error(`ebay_products: ${error.message}`);
    (data || []).forEach((p) => myBySku.set(p.sku, p));
  }

  // ── 4. 경쟁 최저 총액 (competitor_listings) 로드 ──────────────────────
  const allCompIds = [];
  matchesBySku.forEach((ids) => ids.forEach((id) => allCompIds.push(id)));
  const compById = new Map();
  const uniqueIds = [...new Set(allCompIds)];
  for (let i = 0; i < uniqueIds.length; i += 500) {
    const chunk = uniqueIds.slice(i, i + 500);
    const { data, error } = await db.from('competitor_listings')
      .select('ebay_item_id, seller_id, price, shipping, quantity_sold, status, last_seen')
      .in('ebay_item_id', chunk);
    if (error) throw new Error(`competitor_listings: ${error.message}`);
    (data || []).forEach((c) => compById.set(String(c.ebay_item_id), c));
  }

  // ── 5. SKU별 격차 + 판매수 + 우선순위 점수 계산 ────────────────────────
  const rows = [];
  for (const sku of skus) {
    const my = myBySku.get(sku);
    if (!my) continue;
    const myTotal = (Number(my.price_usd) || 0) + (Number(my.shipping_usd) || 0);
    if (!(myTotal > 0)) continue;

    // 매칭된 경쟁 리스팅 중 활성 + 가격>0 최저 총액
    let bestComp = null;
    let bestCompSold = 0;
    for (const id of matchesBySku.get(sku) || []) {
      const c = compById.get(String(id));
      if (!c || c.status !== 'active') continue;
      const cPrice = Number(c.price) || 0;
      if (cPrice <= 0) continue;
      const cTotal = cPrice + (Number(c.shipping) || 0);
      if (bestComp == null || cTotal < bestComp) {
        bestComp = cTotal;
        bestCompSold = Number(c.quantity_sold) || 0;
      }
    }
    if (bestComp == null) continue;

    const diff = r2(myTotal - bestComp);
    const losing = diff > 0;
    if (!losing) continue; // 지는 SKU 만 대상 (부록 A-1)

    const sm = smBySku.get(sku);
    const costMissing = !sm || sm.cost_krw == null;
    const weightMissing = !sm || sm.weight_gram == null || sm.weight_gram === 0;
    const dimMissing = !sm || !sm.width_cm || !sm.height_cm || !sm.length_cm;
    // 원가 or 무게/치수가 없어야 = 데이터 태스크 대상 (있으면 이미 Engine 이 판정 가능)
    const missingSomething = costMissing || weightMissing || dimMissing;
    if (!missingSomething) continue;

    // 우선순위 = 격차 × 판매속도. 판매수 없으면 격차만.
    const salesSignal = Math.max(bestCompSold, Number(my.sales_count) || 0);
    const priorityScore = r2(diff * (1 + salesSignal * 0.02));

    const missing = [];
    if (costMissing) missing.push('원가');
    if (weightMissing) missing.push('무게');
    if (dimMissing) missing.push('치수');

    rows.push({
      sku,
      item_id: my.item_id,
      title: (my.title || '').slice(0, 100),
      my_price: r2(Number(my.price_usd) || 0),
      my_shipping: r2(Number(my.shipping_usd) || 0),
      my_total: r2(myTotal),
      competitor_total: r2(bestComp),
      diff,
      competitor_sold: bestCompSold,
      priority_score: priorityScore,
      missing: missing.join('+'),
    });
  }

  rows.sort((a, b) => b.priority_score - a.priority_score);
  const top = rows.slice(0, TOP_N);
  const totalDiffAllTop = r2(top.reduce((s, r) => s + r.diff, 0));

  console.log(`[priority] losing + 데이터 미입력 SKU: ${rows.length}개 → top ${TOP_N}`);
  console.log(`[priority] top ${TOP_N} 잠재 손실 (내 총액 - 경쟁 총액) 합계: $${totalDiffAllTop.toLocaleString()}`);
  console.log('[priority] 상위 5개 미리보기:');
  top.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.sku.padEnd(20)} diff=$${r.diff.toString().padStart(6)} sold=${String(r.competitor_sold).padStart(4)} miss=${r.missing.padEnd(10)} | ${r.title.slice(0, 60)}`);
  });

  if (!APPLY) {
    console.log('[priority] dry-run — 실제 저장: node scripts/generate-priority-cost-tasks.js --apply');
    return;
  }

  // ── 6. team_task 저장 (하루 1장 dedupe) ────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const res = await createExceptionTask({
    exceptionType: 'LANDING_COST_DATA_MISSING',
    dedupeKey: `engine1:priority-cost:${today}`,
    title: `[우선순위 데이터] losing top ${top.length} SKU — 원가·무게 입력 (잠재 손실 $${totalDiffAllTop.toLocaleString()})`,
    memo: [
      '지고 있는 SKU 중 원가·무게·치수 미입력분 우선순위 리스트.',
      '이 순서대로 SKU 마스터에서 값을 채우면 Engine 1 이 자동가격 대상으로 편입.',
      '계약서 §BLOCK = 데이터 태스크 원칙.',
    ].join('\n'),
    severity: 'high',
    context: {
      source: 'engine1-priority',
      generated_at: new Date().toISOString(),
      total_losing_missing: rows.length,
      top_n: top.length,
      total_potential_impact_usd: totalDiffAllTop,
      priority_skus: top,
    },
  });

  console.log(`[priority] team_task ${res.deduped ? 'dedup (기존 유지)' : '생성 완료'} — id=${res.id ?? '?'}`);
  console.log('[priority] SKU 마스터 화면 → 자동 예외 카드에서 확인 가능');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[priority] 실패:', e.message); process.exit(1); });
