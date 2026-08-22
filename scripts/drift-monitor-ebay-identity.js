'use strict';

/**
 * scripts/drift-monitor-ebay-identity.js — Phase 8P-22B.
 *
 * READ-ONLY drift monitor for eBay identity health.
 * Exits 0 when clean, 1 when any anomaly bucket > 0.
 * Zero writes · zero DDL · safe to run on cron.
 *
 * Buckets:
 *   A. eBay OMS product_id IS NULL
 *   B. eBay failed identity_conflict
 *   C. price-shaped ebay_sku marketplace_identity
 *   D. suspect UUID eBay SKU identities
 *   E. marketplace_sku used by >1 distinct listing identity (via SLL)
 *   F. sku_master.internal_sku matching price/uuid/too-short patterns
 *   G. listing MI / SLL disagreement (per-sku listing set mismatch)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { isPriceShapedEbaySku, isUuidShapedEbaySku } = require('../src/services/ebay/skuAuthorityValidator');

async function selectAll(db, table, buildFilters, pageSize = 1000) {
  const rows = []; let cursor = 0;
  while (true) {
    let q = db.from(table).select('*').range(cursor, cursor + pageSize - 1);
    q = buildFilters(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    cursor += pageSize;
  }
  return rows;
}
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

async function main() {
  const db = getClient();

  //   A. eBay OMS product_id NULL where sku_master_id is set
  const ebayOrders = await selectAll(db, 'oms_orders', q => q.select('id').eq('channel', 'ebay'));
  const ebayOrderIds = ebayOrders.map(o => o.id);
  const gap = [];
  for (const slice of chunk(ebayOrderIds, 500)) {
    const { data } = await db.from('oms_order_items').select('id, sku_master_id, product_id, match_status, match_reason')
      .in('order_id', slice).not('sku_master_id', 'is', null).is('product_id', null);
    gap.push(...(data || []));
  }
  const A = gap.length;

  //   B. failed identity_conflict (all eBay OMS rows)
  const conflict = [];
  for (const slice of chunk(ebayOrderIds, 500)) {
    const { data } = await db.from('oms_order_items').select('id, match_reason')
      .in('order_id', slice).eq('match_status', 'failed').like('match_reason', 'identity_conflict:%');
    conflict.push(...(data || []));
  }
  const B = conflict.length;

  //   C. price-shaped ebay_sku MI
  const ebaySkuMi = await selectAll(db, 'marketplace_identity', q => q.select('*').eq('channel', 'ebay').eq('identity_type', 'ebay_sku'));
  const priceMi = ebaySkuMi.filter(r => isPriceShapedEbaySku(String(r.identity_value)));
  const C = priceMi.length;

  //   D. UUID-shaped ebay_sku MI (all treated suspect; owner-confirmed ones may be legit)
  const uuidMi = ebaySkuMi.filter(r => isUuidShapedEbaySku(String(r.identity_value)));
  const D = uuidMi.length;

  //   E. marketplace_sku shared across >1 listing_id in SLL
  const sll = await selectAll(db, 'sku_listing_link', q => q.select('*').eq('marketplace', 'ebay'));
  const mskuToListings = new Map();
  for (const r of sll) {
    if (!r.marketplace_sku) continue;
    if (!mskuToListings.has(r.marketplace_sku)) mskuToListings.set(r.marketplace_sku, new Set());
    mskuToListings.get(r.marketplace_sku).add(String(r.listing_id));
  }
  const shared = [...mskuToListings.entries()].filter(([, s]) => s.size > 1);
  const E = shared.length;

  //   F. malformed sku_master.internal_sku
  const smAll = await selectAll(db, 'sku_master', q => q.select('id, internal_sku, status'));
  const malformedSm = smAll.filter(r => {
    const v = String(r.internal_sku || '');
    return isPriceShapedEbaySku(v) || isUuidShapedEbaySku(v) || v.trim().length < 3;
  });
  const F = malformedSm.length;

  //   G. listing MI / SLL disagreement per sku
  const listingMi = ebaySkuMi.length ? null : null;
  const ebayListingMi = await selectAll(db, 'marketplace_identity', q => q.select('*').eq('channel', 'ebay').eq('identity_type', 'ebay_listing_id'));
  const miListingsBySku = new Map();
  for (const r of ebayListingMi) {
    if (!miListingsBySku.has(r.sku_master_id)) miListingsBySku.set(r.sku_master_id, new Set());
    miListingsBySku.get(r.sku_master_id).add(String(r.identity_value));
  }
  const sllListingsBySku = new Map();
  for (const r of sll) {
    if (!sllListingsBySku.has(r.sku_id)) sllListingsBySku.set(r.sku_id, new Set());
    sllListingsBySku.get(r.sku_id).add(String(r.listing_id));
  }
  const disagree = [];
  for (const [sku, mSet] of miListingsBySku) {
    const sSet = sllListingsBySku.get(sku) || new Set();
    if (sSet.size === 0) continue;
    for (const l of mSet) if (!sSet.has(l)) disagree.push({ sku, listing: l, side: 'MI_has_SLL_missing' });
  }
  const G = disagree.length;

  console.log('╔══ DRIFT MONITOR · eBay identity health ══');
  console.log(`  A. eBay OMS product_id NULL                      = ${A}`);
  console.log(`  B. failed identity_conflict                       = ${B}`);
  console.log(`  C. price-shaped ebay_sku MI                       = ${C}${C ? ' · sample: '+JSON.stringify(priceMi.slice(0,5).map(r=>({id:r.id,v:r.identity_value,sm:r.sku_master_id}))) : ''}`);
  console.log(`  D. UUID-shaped ebay_sku MI (suspect)              = ${D}`);
  console.log(`  E. marketplace_sku shared across >1 listing (SLL) = ${E}${E ? ' · sample: '+JSON.stringify(shared.slice(0,5).map(([v,s])=>({v,n:s.size}))) : ''}`);
  console.log(`  F. malformed sku_master.internal_sku              = ${F}${F ? ' · sample: '+JSON.stringify(malformedSm.slice(0,5).map(r=>({id:r.id,isku:r.internal_sku}))) : ''}`);
  console.log(`  G. MI/SLL listing disagreement per sku            = ${G}`);
  console.log('╚═════════════════════════════════════════');

  const total = A + B + C + D + E + F + G;
  if (total > 0) { console.error(`DRIFT_DETECTED total=${total}`); process.exit(1); }
  console.log('DRIFT_CLEAN');
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error('drift monitor failed:', e.message); process.exit(2); });
module.exports = { main };
