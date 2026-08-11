#!/usr/bin/env node
/**
 * phase2-2a-no-row-audit.js — read-only audit of active eBay SKUs that have
 * no matching sku_master row.
 *
 * Owner directive (2026-08-11):
 *   "seed-sku-master-from-ebay.js를 바로 실행하지 마라. 먼저 68개를
 *    read-only audit."
 *
 * Zero writes. Emits a report on:
 *   - which SKUs
 *   - the shape of ebay_products.sku (12-digit item_id? PMC- prefix? etc.)
 *   - potential duplicates (case, whitespace)
 *   - existing sku_mappings / product_matches references
 *   - active status
 *   - suggested internal_sku (safe default)
 *
 * Output: logs/phase2-2a-no-row-audit-<ts>.json
 */
'use strict';

require('dotenv').config({ path: __dirname + '/../config/.env' });
const fs = require('node:fs');
const path = require('node:path');
const { getClient } = require('../src/db/supabaseClient');

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

function classifySkuShape(sku) {
  const s = String(sku || '');
  if (!s) return 'EMPTY';
  if (/^\d{12}$/.test(s)) return 'BARE_ITEM_ID_12';
  if (/^\d+$/.test(s)) return 'DIGITS_ONLY';
  if (/^PMC-/i.test(s)) return 'PMC_PREFIX';
  if (/^\w+-\w+/.test(s)) return 'DASH_STRUCTURED';
  if (/\s/.test(s)) return 'CONTAINS_WHITESPACE';
  if (s !== s.trim()) return 'HAS_EDGE_WHITESPACE';
  return 'OTHER';
}

(async () => {
  const db = getClient();
  console.log('[no-row-audit] loading ebay_products, sku_master, sku_mappings, product_matches...');

  const [ep, sm, mappings, matches] = await Promise.all([
    loadAllRows(db.from('ebay_products').select('sku, item_id, title, status, price_usd, stock, updated_at').neq('status', 'ended')),
    loadAllRows(db.from('sku_master').select('internal_sku, cost_krw, weight_gram, status')),
    loadAllRows(db.from('sku_mappings').select('our_sku, competitor_item_id, status').eq('status', 'approved'), 1000, 20000).catch(() => []),
    loadAllRows(db.from('product_matches').select('our_sku, competitor_item_id, status').eq('status', 'approved'), 1000, 20000).catch(() => []),
  ]);

  const smSkuSet = new Set(sm.map(r => r.internal_sku));
  const smSkuLowerSet = new Set(sm.map(r => String(r.internal_sku || '').toLowerCase().trim()));
  const mappingsBySku = new Map();
  for (const m of mappings) {
    if (!mappingsBySku.has(m.our_sku)) mappingsBySku.set(m.our_sku, 0);
    mappingsBySku.set(m.our_sku, mappingsBySku.get(m.our_sku) + 1);
  }
  const matchesBySku = new Map();
  for (const m of matches) {
    if (!matchesBySku.has(m.our_sku)) matchesBySku.set(m.our_sku, 0);
    matchesBySku.set(m.our_sku, matchesBySku.get(m.our_sku) + 1);
  }

  const orphans = ep.filter(e => !smSkuSet.has(e.sku));
  const shapeCounts = {};
  const orphanDetails = orphans.map(e => {
    const shape = classifySkuShape(e.sku);
    shapeCounts[shape] = (shapeCounts[shape] || 0) + 1;
    return {
      sku: e.sku,
      item_id: e.item_id,
      title: (e.title || '').slice(0, 80),
      status: e.status,
      price_usd: e.price_usd,
      stock: e.stock,
      updated_at: e.updated_at,
      sku_shape: shape,
      case_insensitive_match_in_sku_master: smSkuLowerSet.has(String(e.sku || '').toLowerCase().trim()) && !smSkuSet.has(e.sku),
      approved_product_matches_count: matchesBySku.get(e.sku) || 0,
      approved_sku_mappings_count: mappingsBySku.get(e.sku) || 0,
      suggested_internal_sku: String(e.sku || '').trim(),
    };
  });

  // Look for potential duplicates within the orphan set
  const seen = new Map();
  for (const o of orphanDetails) {
    const key = String(o.sku || '').toLowerCase().trim();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(o.sku);
  }
  const internalDuplicates = [...seen.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([k, v]) => ({ normalized: k, variants: v }));

  const report = {
    audited_at: new Date().toISOString(),
    counts: {
      ebay_products_active: ep.length,
      sku_master_rows: sm.length,
      orphans_total: orphans.length,
      shape_distribution: shapeCounts,
      internal_duplicate_groups: internalDuplicates.length,
      orphans_with_case_variant_in_sku_master: orphanDetails.filter(o => o.case_insensitive_match_in_sku_master).length,
      orphans_with_approved_matches: orphanDetails.filter(o => o.approved_product_matches_count > 0).length,
      orphans_with_approved_mappings: orphanDetails.filter(o => o.approved_sku_mappings_count > 0).length,
    },
    internal_duplicates: internalDuplicates,
    orphans: orphanDetails,
    seed_safety_flags: [
      orphanDetails.some(o => !o.sku) && 'has_empty_sku',
      shapeCounts.CONTAINS_WHITESPACE && 'has_whitespace_in_sku',
      shapeCounts.HAS_EDGE_WHITESPACE && 'has_edge_whitespace',
      internalDuplicates.length && 'internal_case_duplicates',
      orphanDetails.some(o => o.case_insensitive_match_in_sku_master) && 'case_collision_with_existing_sku_master',
    ].filter(Boolean),
    seed_recommendation: null,   // filled below
  };

  if (report.seed_safety_flags.length === 0) {
    report.seed_recommendation = 'SAFE_TO_PROPOSE_SEED — no shape/duplicate hazards. Owner still approves before any write.';
  } else {
    report.seed_recommendation = 'DO_NOT_SEED_AS_IS — resolve flagged hazards first. Manual review required per SKU.';
  }

  const outDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `phase2-2a-no-row-audit-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n═══════ NO_ROW audit ═══════');
  console.log('counts:', report.counts);
  console.log('safety flags:', report.seed_safety_flags);
  console.log('recommendation:', report.seed_recommendation);
  if (internalDuplicates.length) {
    console.log('\ninternal duplicates (top 5):', internalDuplicates.slice(0, 5));
  }
  console.log('\nsample orphans:');
  orphanDetails.slice(0, 10).forEach(o => console.log(' -', o.sku, `(${o.sku_shape})`, o.item_id, o.title));
  console.log(`\nFull report: ${outPath}`);
  console.log('\n⚠️  Read-only. seed-sku-master-from-ebay.js was NOT executed.');
})();
