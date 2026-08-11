#!/usr/bin/env node
/**
 * phase2-2a-data-fill-queue.js — read-only CSV export of SKUs whose sku_master
 * cost/weight fill would immediately unlock Engine 1 decisions.
 *
 * Owner directive (2026-08-11):
 *   "우선 보강 SKU 산출 기능 유지/정리. 우선순위: active eBay + approved
 *    competitor match + 높은 sales/revenue + missing cost or weight.
 *    Top 20/50 export 가능하게. 단 production data 자동 수정 금지.
 *    직원이 SKU master에서 채울 수 있는 CSV 형태까지만 준비."
 *
 * Zero writes. Emits a CSV that maps 1:1 to the SKU Master
 * import template so staff can fill cost/weight and upload.
 *
 * Usage:
 *   node scripts/phase2-2a-data-fill-queue.js --top=20
 *   node scripts/phase2-2a-data-fill-queue.js --top=50
 */
'use strict';

require('dotenv').config({ path: __dirname + '/../config/.env' });
const fs = require('node:fs');
const path = require('node:path');
const { getClient } = require('../src/db/supabaseClient');
const { _internal } = require('../src/jobs/engine1DryRunJob');
const { classifyPricingInputs, CLASS } = _internal;

const args = process.argv.slice(2);
const TOP = Number((args.find(a => a.startsWith('--top=')) || '--top=20').split('=')[1]);

async function loadAllRows(query, pageSize = 1000, hardCap = 100000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
    if (from >= hardCap) break;
  }
  return rows;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

(async () => {
  const db = getClient();
  console.log(`[data-fill-queue] loading (top=${TOP})...`);

  const [pm, sm, ep] = await Promise.all([
    loadAllRows(db.from('product_matches').select('our_sku, competitor_item_id, status').eq('status', 'approved')),
    loadAllRows(db.from('sku_master').select('internal_sku, cost_krw, weight_gram, default_packaging_weight_g, length_cm, width_cm, height_cm')),
    loadAllRows(db.from('ebay_products').select('sku, item_id, title, price_usd, shipping_usd, sales_count, status').neq('status', 'ended')),
  ]);

  const smBySku = new Map(sm.map(r => [r.internal_sku, r]));
  const matchesBySku = new Set(pm.map(m => m.our_sku));

  const candidates = [];
  for (const my of ep) {
    if (!matchesBySku.has(my.sku)) continue;
    const smRow = smBySku.get(my.sku);
    const cls = classifyPricingInputs(smRow);
    // Interested in NO_ROW + MISSING_DATA only. VALID = already fine.
    // INVALID_DATA = data corruption, needs manual investigation (not a
    // simple "fill missing").
    if (cls.status === CLASS.VALID || cls.status === CLASS.INVALID_DATA) continue;

    const sales = Number(my.sales_count) || 0;
    const revenue = sales * (Number(my.price_usd) || 0);
    const missingCost = !smRow || smRow.cost_krw == null || Number(smRow.cost_krw) <= 0;
    const missingWeight = !smRow || !((Number(smRow.weight_gram) || 0) + (Number(smRow.default_packaging_weight_g) || 0) > 0);
    const missingDims = !smRow || !(smRow.length_cm > 0 && smRow.width_cm > 0 && smRow.height_cm > 0);
    const score =
      20 +                                     // base for active + matched
      Math.min(50, Math.log10(sales + 1) * 10) +
      Math.min(30, Math.log10(revenue + 1) * 5) +
      (missingCost ? 5 : 0) +
      (missingWeight ? 5 : 0) +
      (cls.status === CLASS.NO_ROW ? 10 : 0);

    candidates.push({
      sku: my.sku,
      item_id: my.item_id,
      title: (my.title || '').slice(0, 100),
      status: cls.status,
      sales_30d: sales,
      current_price_usd: my.price_usd,
      estimated_revenue_usd: Math.round(revenue),
      cost_krw: smRow ? smRow.cost_krw : null,
      weight_gram: smRow ? smRow.weight_gram : null,
      packaging_weight_gram: smRow ? smRow.default_packaging_weight_g : null,
      length_cm: smRow ? smRow.length_cm : null,
      width_cm: smRow ? smRow.width_cm : null,
      height_cm: smRow ? smRow.height_cm : null,
      missing_cost: missingCost,
      missing_weight: missingWeight,
      missing_dims: missingDims,
      score: Math.round(score * 100) / 100,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates.slice(0, TOP);

  // ─── CSV output (SKU Master import template shape) ─────────────────────
  // Match the actual template columns used by /api/sku-master/import so
  // staff can drop this file directly into the upload form.
  const header = [
    'internal_sku', 'cost_krw', 'weight_gram', 'default_packaging_weight_g',
    'length_cm', 'width_cm', 'height_cm',
    // observability columns (ignored by importer)
    '_status', '_sales_30d', '_revenue_usd', '_current_price_usd', '_item_id', '_title',
  ];
  const lines = [header.join(',')];
  for (const c of picked) {
    lines.push([
      c.sku,
      c.cost_krw ?? '', c.weight_gram ?? '',
      c.packaging_weight_gram ?? '', c.length_cm ?? '', c.width_cm ?? '', c.height_cm ?? '',
      c.status, c.sales_30d, c.estimated_revenue_usd, c.current_price_usd, c.item_id, c.title,
    ].map(csvEscape).join(','));
  }

  const outDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '');
  const csvPath = path.join(outDir, `phase2-2a-data-fill-top${TOP}-${ts}.csv`);
  const jsonPath = path.join(outDir, `phase2-2a-data-fill-top${TOP}-${ts}.json`);
  fs.writeFileSync(csvPath, lines.join('\n'));
  fs.writeFileSync(jsonPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    top: TOP,
    total_candidates: candidates.length,
    picked: picked.length,
    breakdown_by_status: candidates.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {}),
    rows: picked,
  }, null, 2));

  console.log('\n═══════ Data fill queue ═══════');
  console.log(`Total candidates (MISSING_DATA / NO_ROW):`, candidates.length);
  console.log(`Picked top ${TOP}`);
  console.log('\nTop 5 preview:');
  picked.slice(0, 5).forEach((c, i) => console.log(`  ${i+1}. ${c.sku}  sales:${c.sales_30d}  $${c.current_price_usd}  missing:{cost:${c.missing_cost}, weight:${c.missing_weight}, dims:${c.missing_dims}}`));
  console.log(`\nCSV:  ${csvPath}   ← upload via SKU Master import`);
  console.log(`JSON: ${jsonPath}`);
  console.log('\n⚠️  Read-only. No sku_master row was created or updated.');
})();
