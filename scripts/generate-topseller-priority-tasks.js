'use strict';

/**
 * generate-topseller-priority-tasks.js
 *
 * 매출 상위 SKU 중 원가/무게 미입력분을 우선순위 team_task 로 등록.
 *
 * 배경 (2026-07-10):
 *   Engine 4 조기 실행으로 active SKU 가 9,464 → 2,771 로 축소.
 *   이 2,771 개 중에도 사장님이 원가/무게를 다 채우는 건 물리적으로 어려움.
 *   파레토 원칙 (매출 상위 20% 가 사업 매출 80%) 을 따라, sales_count 상위
 *   200 개부터 원가 채우면 매출 기준 커버리지가 빠르게 상승.
 *
 * 기존 generate-priority-cost-tasks.js 와 차이:
 *   - 그 스크립트: losing SKU + 격차 큰 순 (경쟁 대응 관점)
 *   - 이 스크립트: 판매수 큰 순 (매출 규모 관점)
 *   두 스크립트를 병행하면 "지금 지고있는 것 + 앞으로 크게 벌 것" 커버.
 *
 * 실행:
 *   node scripts/generate-topseller-priority-tasks.js          (dry-run)
 *   node scripts/generate-topseller-priority-tasks.js --apply  (team_task 저장)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { createExceptionTask } = require('../src/services/exceptionTask');

const APPLY = process.argv.includes('--apply');
const TOP_N = 200;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  const db = getClient();

  // 1. active sku_master 로드 (Engine 4 이후 2,771 예상)
  const activeSkus = new Set();
  const smBySku = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await db.from('sku_master')
      .select('internal_sku, cost_krw, weight_gram, width_cm, height_cm, length_cm, supplier_id')
      .eq('status', 'active')
      .range(from, from + 999);
    if (error) throw new Error(`sku_master: ${error.message}`);
    if (!data || data.length === 0) break;
    data.forEach((s) => { activeSkus.add(s.internal_sku); smBySku.set(s.internal_sku, s); });
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[topseller] active SKU: ${activeSkus.size}개`);

  // 2. 판매 있는 eBay 리스팅 (sales_count > 0) 조회, 상위 정렬
  const listings = [];
  from = 0;
  while (true) {
    const { data, error } = await db.from('ebay_products')
      .select('sku, item_id, title, price_usd, sales_count, stock')
      .neq('status', 'ended')
      .gt('sales_count', 0)
      .order('sales_count', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(`ebay_products: ${error.message}`);
    if (!data || data.length === 0) break;
    listings.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[topseller] 판매 있는 eBay 리스팅: ${listings.length}개`);

  // 3. active SKU 이면서 원가/무게/치수 부족한 것 필터
  const candidates = [];
  for (const l of listings) {
    if (!activeSkus.has(l.sku)) continue; // Engine 4 로 paused 처리된 것 제외
    const sm = smBySku.get(l.sku);
    const costMissing = !sm || sm.cost_krw == null;
    const weightMissing = !sm || sm.weight_gram == null || sm.weight_gram === 0;
    const dimMissing = !sm || !sm.width_cm || !sm.height_cm || !sm.length_cm;
    const supplierMissing = !sm || sm.supplier_id == null;
    if (!(costMissing || weightMissing || dimMissing)) continue; // 이미 다 채워짐

    const missing = [];
    if (costMissing) missing.push('원가');
    if (weightMissing) missing.push('무게');
    if (dimMissing) missing.push('치수');
    if (supplierMissing) missing.push('소싱처');

    // 예상 매출 임팩트 (판매수 × 판매가 대략) — 큰 순으로 정렬
    const est_revenue = (Number(l.sales_count) || 0) * (Number(l.price_usd) || 0);

    candidates.push({
      sku: l.sku,
      item_id: l.item_id,
      title: (l.title || '').slice(0, 100),
      sales_count: Number(l.sales_count) || 0,
      price_usd: r2(Number(l.price_usd) || 0),
      stock: Number(l.stock) || 0,
      estimated_revenue_usd: r2(est_revenue),
      missing: missing.join('+'),
    });
  }

  candidates.sort((a, b) => b.estimated_revenue_usd - a.estimated_revenue_usd);
  const top = candidates.slice(0, TOP_N);
  const totalRevenue = r2(top.reduce((s, c) => s + c.estimated_revenue_usd, 0));

  console.log(`[topseller] 판매 있음 + 데이터 미입력 SKU: ${candidates.length}개 → top ${TOP_N}`);
  console.log(`[topseller] top ${TOP_N} 누적 매출 규모: $${totalRevenue.toLocaleString()}`);
  console.log('[topseller] 상위 5개 미리보기:');
  top.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.sku.padEnd(20)} 판매 ${String(c.sales_count).padStart(5)} · $${c.price_usd} · 누적 $${c.estimated_revenue_usd.toLocaleString()} · 미입력 ${c.missing} | ${c.title.slice(0, 55)}`);
  });

  if (!APPLY) {
    console.log('[topseller] dry-run — 실제 저장: node scripts/generate-topseller-priority-tasks.js --apply');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const res = await createExceptionTask({
    exceptionType: 'LANDING_COST_DATA_MISSING',
    dedupeKey: `engine1:topseller-priority:${today}`,
    title: `[매출 우선순위] top ${top.length} SKU — 원가·무게 입력 (누적 매출 $${totalRevenue.toLocaleString()})`,
    memo: [
      '판매 있는 SKU 중 원가·무게·치수 미입력분을 매출 규모 순으로 정렬.',
      '파레토 원칙: 상위 200 개 채우면 매출 커버리지 대부분 확보.',
      'SKU 마스터 화면에서 이 순서대로 원가/무게 인라인 입력 → Engine 1 즉시 자동가격 편입.',
      '계약서 §Landing Cost Complete + Engine 4 조기 실행 (2026-07-10) 정합.',
    ].join('\n'),
    severity: 'high',
    context: {
      source: 'engine4-topseller',
      generated_at: new Date().toISOString(),
      total_active_missing: candidates.length,
      top_n: top.length,
      total_estimated_revenue_usd: totalRevenue,
      priority_skus: top,
    },
  });

  console.log(`[topseller] team_task ${res.deduped ? 'dedup' : '생성'} id=${res.id ?? '?'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[topseller] 실패:', e.message); process.exit(1); });
