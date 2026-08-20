#!/usr/bin/env node
/**
 * Google Sheets → Supabase Data Migration Script
 * Uses EXISTING schema: products + platform_listings (extended with PMC columns)
 *
 * Usage: node scripts/migrate-sheets-to-supabase.js [--table=<name>] [--dry-run]
 *
 * Options:
 *   --table=products            Migrate only one table
 *   --dry-run                   Show what would be migrated without writing
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const path = require('path');
const fs = require('fs');
const { getClient, isSupabaseEnabled } = require('../src/db/supabaseClient');
const GoogleSheetsAPI = require('../src/api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const credentialsPath = path.join(__dirname, '../config/credentials.json');

const args = process.argv.slice(2);
const targetTable = args.find(a => a.startsWith('--table='))?.split('=')[1];
const dryRun = args.includes('--dry-run');

let sheets;
let db;

async function init() {
  if (!isSupabaseEnabled()) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in config/.env');
    process.exit(1);
  }

  db = getClient();
  sheets = new GoogleSheetsAPI(credentialsPath);
  await sheets.authenticate();
  console.log('Connected to Google Sheets and Supabase\n');
}

// ─── 1. products (최종 Dashboard A2:S → existing products table) ───
async function migrateProducts() {
  console.log('=== Migrating products (최종 Dashboard) ===');

  const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!A2:S');
  if (!rows || rows.length === 0) { console.log('  No data found'); return 0; }

  const products = rows
    .filter(r => r[1]) // must have SKU (col B)
    .map(row => ({
      sku: row[1],
      title_ko: row[2] || '',
      title: row[2] || '',
      image_url: row[0] || '',
      weight: parseFloat(row[3]) || 0,
      cost_price: parseInt(row[4]) || 0,
      shipping_krw: parseInt(row[5]) || 0,
      fee_krw: parseInt(row[6]) || 0,
      tax_krw: parseInt(row[7]) || 0,
      total_cost: parseInt(row[8]) || 0,
      price_usd: parseFloat(row[9]) || 0,
      shipping_usd: parseFloat(row[10]) || 0,
      profit_krw: parseInt(row[11]) || 0,
      margin_pct: parseFloat(row[12]) || 0,
      ebay_item_id: row[13] || '',
      sales_count: parseInt(row[14]) || 0,
      stock: parseInt(row[15]) || 0,
      ebay_status: row[16] || '',
      shopify_status: row[17] || '',
      supplier: row[18] || '',
      status: 'active',
    }));

  console.log(`  Found ${products.length} products`);
  if (dryRun) { console.log('  [DRY RUN] Skipping write'); return products.length; }

  for (let i = 0; i < products.length; i += 200) {
    const chunk = products.slice(i, i + 200);
    const { error } = await db.from('products').upsert(chunk, { onConflict: 'sku' });
    if (error) {
      console.error(`  Error at chunk ${i}: ${error.message}`);
    } else {
      console.log(`  Inserted ${i + chunk.length}/${products.length}`);
    }
  }

  return products.length;
}

// ─── Build SKU → product_id map ───
async function buildSkuMap() {
  const { data, error } = await db
    .from('products')
    .select('id, sku')
    .not('sku', 'is', null)
    .neq('sku', '');
  if (error) throw error;
  const map = {};
  (data || []).forEach(r => { map[r.sku] = r.id; });
  return map;
}

// ─── 2. eBay Products → platform_listings (platform='ebay') ───
async function migrateEbayListings() {
  console.log('\n=== Migrating eBay → platform_listings ===');

  const rows = await sheets.readData(SPREADSHEET_ID, 'eBay Products!A2:N');
  if (!rows || rows.length === 0) { console.log('  No data found'); return 0; }

  const skuMap = await buildSkuMap();

  const listings = rows
    .filter(r => r[0] && r[2]) // must have SKU and item_id
    .map(row => ({
      product_id: skuMap[row[0]] || null,
      platform: 'ebay',
      platform_item_id: row[2] || '',
      platform_sku: row[0] || '',
      sku: row[0] || '',
      title: row[1] || '',
      price: parseFloat(row[3]) || 0,
      currency: 'USD',
      shipping_cost: parseFloat(row[4]) || 0,
      quantity: parseInt(row[6]) || 0,
      status: row[9] || '',
      fee_rate: parseFloat(row[11]) || 13,
      sales_count: parseInt(row[7]) || 0,
      image_url: row[13] || '',
    }))
    .filter(r => r.platform_item_id); // must have item_id for upsert

  console.log(`  Found ${listings.length} eBay listings (${listings.filter(l => l.product_id).length} with product_id)`);
  if (dryRun) return listings.length;

  const { error } = await db.from('platform_listings').upsert(listings, { onConflict: 'platform,platform_item_id' });
  if (error) console.error(`  Error: ${error.message}`);
  else console.log(`  Inserted ${listings.length} rows`);

  return listings.length;
}

// ─── 3. Shopify → platform_listings (platform='shopify') ───
async function migrateShopifyListings() {
  console.log('\n=== Migrating Shopify → platform_listings ===');

  const rows = await sheets.readData(SPREADSHEET_ID, 'Shopify!A2:K');
  if (!rows || rows.length === 0) { console.log('  No data found'); return 0; }

  const skuMap = await buildSkuMap();

  const listings = rows
    .filter(r => r[0])
    .map(row => ({
      product_id: skuMap[row[0]] || null,
      platform: 'shopify',
      platform_item_id: row[0], // Use SKU as platform_item_id for Shopify
      platform_sku: row[0] || '',
      sku: row[0] || '',
      title: row[1] || '',
      price: parseFloat(row[3]) || 0,
      currency: 'USD',
      shipping_cost: 0,
      quantity: 0,
      status: row[9] || '',
      fee_rate: parseFloat(row[5]) || 15,
      exchange_rate: parseFloat(row[4]) || 1400,
      purchase_price_krw: parseInt(row[2]) || 0,
      shipping_krw: parseInt(row[6]) || 0,
      profit_krw: parseInt(row[7]) || 0,
      margin_pct: parseFloat(row[8]) || 0,
    }));

  // Deduplicate by platform_item_id (keep last occurrence)
  const deduped = Object.values(
    listings.reduce((acc, l) => { acc[l.platform_item_id] = l; return acc; }, {})
  );

  console.log(`  Found ${listings.length} Shopify listings (${deduped.length} unique)`);
  if (dryRun) return deduped.length;

  for (let i = 0; i < deduped.length; i += 200) {
    const chunk = deduped.slice(i, i + 200);
    const { error } = await db.from('platform_listings').upsert(chunk, { onConflict: 'platform,platform_item_id' });
    if (error) console.error(`  Error at chunk ${i}: ${error.message}`);
    else console.log(`  Inserted ${i + chunk.length}/${deduped.length}`);
  }

  return deduped.length;
}

// ─── 4. Naver Products → platform_listings (platform='naver') ───
async function migrateNaverListings() {
  console.log('\n=== Migrating Naver → platform_listings ===');

  const rows = await sheets.readData(SPREADSHEET_ID, 'Naver Products!A2:J');
  if (!rows || rows.length === 0) { console.log('  No data found'); return 0; }

  const skuMap = await buildSkuMap();

  const listings = rows
    .filter(r => r[0])
    .map(row => {
      const productNo = row[0] || '';
      const sku = row[1] || productNo; // Some Naver listings have SKU in col B
      return {
        product_id: skuMap[sku] || null,
        platform: 'naver',
        platform_item_id: productNo,
        platform_sku: sku,
        sku: sku,
        title: row[1] || '',
        price: parseInt(row[2]) || 0,
        currency: 'KRW',
        quantity: parseInt(row[3]) || 0,
        status: row[4] || '',
        fee_rate: parseFloat(row[7]) || 5.5,
        image_url: row[9] || '',
      };
    });

  // Deduplicate by platform_item_id (keep last occurrence)
  const deduped = Object.values(
    listings.reduce((acc, l) => { acc[l.platform_item_id] = l; return acc; }, {})
  );

  console.log(`  Found ${listings.length} Naver listings (${deduped.length} unique)`);
  if (dryRun) return deduped.length;

  for (let i = 0; i < deduped.length; i += 200) {
    const chunk = deduped.slice(i, i + 200);
    const { error } = await db.from('platform_listings').upsert(chunk, { onConflict: 'platform,platform_item_id' });
    if (error) console.error(`  Error at chunk ${i}: ${error.message}`);
    else console.log(`  Inserted ${i + chunk.length}/${deduped.length}`);
  }

  return deduped.length;
}

// ─── 5. Alibaba → platform_listings (platform='alibaba') ───
async function migrateAlibabaListings() {
  console.log('\n=== Migrating Alibaba → platform_listings ===');

  const rows = await sheets.readData(SPREADSHEET_ID, 'Alibaba Products!A2:J');
  if (!rows || rows.length === 0) { console.log('  No data found'); return 0; }

  const skuMap = await buildSkuMap();

  const listings = rows
    .filter(r => r[0])
    .map(row => ({
      product_id: skuMap[row[0]] || null,
      platform: 'alibaba',
      platform_item_id: row[0], // Use SKU as platform_item_id
      platform_sku: row[0] || '',
      sku: row[0] || '',
      title: row[1] || '',
      price: 0,
      currency: 'USD',
      quantity: 0,
      status: 'sourcing',
      image_url: row[8] || '',
    }));

  // Deduplicate by platform_item_id (keep last occurrence)
  const deduped = Object.values(
    listings.reduce((acc, l) => { acc[l.platform_item_id] = l; return acc; }, {})
  );

  console.log(`  Found ${listings.length} Alibaba listings (${deduped.length} unique)`);
  if (dryRun) return deduped.length;

  for (let i = 0; i < deduped.length; i += 200) {
    const chunk = deduped.slice(i, i + 200);
    const { error } = await db.from('platform_listings').upsert(chunk, { onConflict: 'platform,platform_item_id' });
    if (error) console.error(`  Error at chunk ${i}: ${error.message}`);
    else console.log(`  Inserted ${i + chunk.length}/${deduped.length}`);
  }

  return deduped.length;
}

// ─── 6. orders (주문 배송 A2:T) ───
async function migrateOrders() {
  console.log('\n=== Migrating orders (주문 배송) ===');

  const rows = await sheets.readData(SPREADSHEET_ID, '주문 배송!A2:T');
  if (!rows || rows.length === 0) { console.log('  No data found'); return 0; }

  const orders = rows
    .filter(r => r[2]) // must have order_no
    .map(row => ({
      order_date: row[0] || null,
      platform: row[1] || '',
      order_no: row[2],
      sku: row[3] || '',
      title: row[4] || '',
      quantity: parseInt(row[5]) || 1,
      payment_amount: parseFloat(row[6]) || 0,
      currency: row[7] || 'USD',
      buyer_name: row[8] || '',
      country: row[9] || '',
      carrier: row[10] || '',
      tracking_no: row[11] || '',
      status: row[12] || 'NEW',
      street: row[13] || '',
      city: row[14] || '',
      province: row[15] || '',
      zip_code: row[16] || '',
      phone: row[17] || '',
      country_code: row[18] || '',
      email: row[19] || '',
    }));

  // Deduplicate by order_no (keep last occurrence)
  const deduped = Object.values(
    orders.reduce((acc, o) => { acc[o.order_no] = o; return acc; }, {})
  );

  console.log(`  Found ${orders.length} orders (${deduped.length} unique)`);
  if (dryRun) return deduped.length;

  for (let i = 0; i < deduped.length; i += 200) {
    const chunk = deduped.slice(i, i + 200);
    const { error } = await db.from('orders').upsert(chunk, { onConflict: 'order_no' });
    if (error) console.error(`  Error at chunk ${i}: ${error.message}`);
    else console.log(`  Inserted ${i + chunk.length}/${deduped.length}`);
  }

  return deduped.length;
}

// ─── 7. b2b_buyers ───
async function migrateB2BBuyers() {
  console.log('\n=== Migrating b2b_buyers (B2B Buyers) ===');

  let rows;
  try {
    rows = await sheets.readData(SPREADSHEET_ID, "'B2B Buyers'!A:M");
  } catch { console.log('  Sheet not found, skipping'); return 0; }
  if (!rows || rows.length <= 1) { console.log('  No data found'); return 0; }

  const buyers = rows.slice(1)
    .filter(r => r[0])
    .map(row => ({
      buyer_id: row[0] || '',
      name: row[1] || '',
      contact: row[2] || '',
      email: row[3] || '',
      whatsapp: row[4] || '',
      phone: row[5] || '',
      address: row[6] || '',
      country: row[7] || '',
      currency: row[8] || 'USD',
      payment_terms: row[9] || 'Net 30',
      notes: row[10] || '',
      total_orders: parseInt(row[11]) || 0,
      total_revenue: parseFloat(row[12]) || 0,
    }));

  console.log(`  Found ${buyers.length} buyers`);
  if (dryRun) return buyers.length;

  const { error } = await db.from('b2b_buyers').upsert(buyers, { onConflict: 'buyer_id' });
  if (error) console.error(`  Error: ${error.message}`);
  else console.log(`  Inserted ${buyers.length} rows`);

  return buyers.length;
}

// ─── 8. b2b_invoices ───
async function migrateB2BInvoices() {
  console.log('\n=== Migrating b2b_invoices (B2B Invoices) ===');

  let rows;
  try {
    rows = await sheets.readData(SPREADSHEET_ID, "'B2B Invoices'!A:P");
  } catch { console.log('  Sheet not found, skipping'); return 0; }
  if (!rows || rows.length <= 1) { console.log('  No data found'); return 0; }

  const invoices = rows.slice(1)
    .filter(r => r[0])
    .map(row => {
      let items = [];
      try { items = JSON.parse(row[5] || '[]'); } catch { items = []; }
      return {
        invoice_no: row[0] || '',
        buyer_id: row[1] || '',
        buyer_name: row[2] || '',
        invoice_date: row[3] || new Date().toISOString().split('T')[0],
        due_date: row[4] || null,
        items,
        subtotal: parseFloat(row[6]) || 0,
        tax: parseFloat(row[7]) || 0,
        shipping: parseFloat(row[8]) || 0,
        total: parseFloat(row[9]) || 0,
        currency: row[10] || 'USD',
        status: row[11] || 'CREATED',
        drive_file_id: row[12] || '',
        drive_url: row[13] || '',
        sent_via: row[14] || '',
        sent_at: row[15] || null,
      };
    });

  console.log(`  Found ${invoices.length} invoices`);
  if (dryRun) return invoices.length;

  const { error } = await db.from('b2b_invoices').upsert(invoices, { onConflict: 'invoice_no' });
  if (error) console.error(`  Error: ${error.message}`);
  else console.log(`  Inserted ${invoices.length} rows`);

  return invoices.length;
}

// ─── 9. sku_scores (from JSON file) ───
async function migrateSkuScores() {
  console.log('\n=== Migrating sku_scores (sku-scores.json) ===');

  const scoresPath = path.join(__dirname, '../data/sku-scores.json');
  if (!fs.existsSync(scoresPath)) { console.log('  File not found'); return 0; }

  const raw = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
  const entries = Object.values(raw.scores || {});
  console.log(`  Found ${entries.length} SKU scores`);
  if (dryRun) return entries.length;

  const scoreRows = entries.map(e => ({
    sku: e.sku,
    title: e.title || '',
    selling_price: e.rawData?.sellingPrice || 0,
    purchase_price: e.rawData?.purchasePrice || 0,
    platform_fees: e.rawData?.platformFees || '',
    net_margin_pct: e.rawData?.netMarginPct || 0,
    sales_30d: e.rawData?.sales30d || 0,
    competitor_count: e.rawData?.competitorCount || 0,
    bundle_item_count: e.rawData?.bundleItemCount || 0,
    price_fluctuation_pct: e.rawData?.priceFluctuationPct || 0,
    score_net_margin: e.scores?.netMargin || {},
    score_turnover: e.scores?.turnover || {},
    score_competition: e.scores?.competition || {},
    score_shipping_eff: e.scores?.shippingEfficiency || {},
    score_price_stability: e.scores?.priceStability || {},
    total_score: e.totalScore || 0,
    max_possible: e.maxPossibleScore || 100,
    normalized_score: e.normalizedScore || 0,
    classification: e.classification || 'D',
    purchase_allowed: e.purchaseDecision?.allowed || false,
    purchase_reason: e.purchaseDecision?.reason || '',
    auto_retirement: e.autoRetirement || {},
    manual_overrides: e.manualOverrides || {},
    calculated_at: e.calculatedAt || raw.lastUpdated,
  }));

  for (let i = 0; i < scoreRows.length; i += 200) {
    const chunk = scoreRows.slice(i, i + 200);
    const { error } = await db.from('sku_scores').upsert(chunk, { onConflict: 'sku' });
    if (error) console.error(`  Scores error at ${i}: ${error.message}`);
    else console.log(`  Scores: ${i + chunk.length}/${scoreRows.length}`);
  }

  // History
  const historyRows = [];
  entries.forEach(e => {
    (e.history || []).forEach(h => {
      historyRows.push({
        sku: e.sku,
        date: h.date,
        total_score: h.totalScore || 0,
        normalized_score: h.normalizedScore || 0,
        classification: h.classification || 'D',
      });
    });
  });

  if (historyRows.length > 0) {
    console.log(`  Found ${historyRows.length} history entries`);
    for (let i = 0; i < historyRows.length; i += 500) {
      const chunk = historyRows.slice(i, i + 500);
      const { error } = await db.from('sku_score_history').upsert(chunk, { onConflict: 'sku,date' });
      if (error) console.error(`  History error at ${i}: ${error.message}`);
      else console.log(`  History: ${i + chunk.length}/${historyRows.length}`);
    }
  }

  return entries.length;
}

// ─── 10. price_history (from JSON file) ───
async function migratePriceHistory() {
  console.log('\n=== Migrating price_history (price-history.json) ===');

  const historyPath = path.join(__dirname, '../data/price-history.json');
  if (!fs.existsSync(historyPath)) { console.log('  File not found'); return 0; }

  const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const snapshots = raw.snapshots || {};

  const rows = [];
  Object.entries(snapshots).forEach(([sku, entries]) => {
    (entries || []).forEach(e => {
      rows.push({
        sku,
        date: e.date,
        price: parseFloat(e.price) || 0,
        platform: e.platform || 'ebay',
      });
    });
  });

  console.log(`  Found ${rows.length} price snapshots`);
  if (dryRun) return rows.length;

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from('price_history').upsert(chunk, { onConflict: 'sku,date,platform' });
    if (error) console.error(`  Error at ${i}: ${error.message}`);
    else console.log(`  Inserted ${i + chunk.length}/${rows.length}`);
  }

  return rows.length;
}

// ─── Main ───
const MIGRATIONS = {
  products: migrateProducts,
  ebay_listings: migrateEbayListings,
  shopify_listings: migrateShopifyListings,
  naver_listings: migrateNaverListings,
  alibaba_listings: migrateAlibabaListings,
  orders: migrateOrders,
  b2b_buyers: migrateB2BBuyers,
  b2b_invoices: migrateB2BInvoices,
  sku_scores: migrateSkuScores,
  price_history: migratePriceHistory,
};

async function main() {
  await init();

  if (dryRun) console.log('*** DRY RUN MODE ***\n');

  const results = {};
  const toRun = targetTable ? { [targetTable]: MIGRATIONS[targetTable] } : MIGRATIONS;

  if (targetTable && !MIGRATIONS[targetTable]) {
    console.error(`Unknown table: ${targetTable}`);
    console.error(`Available: ${Object.keys(MIGRATIONS).join(', ')}`);
    process.exit(1);
  }

  for (const [name, fn] of Object.entries(toRun)) {
    try {
      results[name] = await fn();
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      results[name] = `ERROR: ${err.message}`;
    }
  }

  console.log('\n========== Migration Summary ==========');
  for (const [table, count] of Object.entries(results)) {
    console.log(`  ${table}: ${typeof count === 'number' ? count + ' rows' : count}`);
  }
  console.log('========================================');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
