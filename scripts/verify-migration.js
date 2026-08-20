#!/usr/bin/env node
/**
 * Migration Verification Script
 * Compares Google Sheets row counts with Supabase data (existing schema)
 *
 * Usage: node scripts/verify-migration.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const path = require('path');
const fs = require('fs');
const { getClient } = require('../src/db/supabaseClient');
const GoogleSheetsAPI = require('../src/api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const credentialsPath = path.join(__dirname, '../config/credentials.json');

let sheets, db;

async function init() {
  db = getClient();
  sheets = new GoogleSheetsAPI(credentialsPath);
  await sheets.authenticate();
}

async function countSheetRows(range, keyCol = 0) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, range);
    if (!rows) return 0;
    return rows.filter(r => r[keyCol]).length;
  } catch {
    return -1; // sheet not found
  }
}

async function countDbRows(table, filter) {
  let query = db.from(table).select('*', { count: 'exact', head: true });
  if (filter) {
    Object.entries(filter).forEach(([key, value]) => {
      query = query.eq(key, value);
    });
  }
  const { count, error } = await query;
  if (error) return -1;
  return count || 0;
}

async function verifyRowCounts() {
  console.log('=== Row Count Verification ===\n');

  const checks = [
    { label: '최종 Dashboard', range: '최종 Dashboard!A2:S', keyCol: 1, table: 'products', filter: null },
    { label: 'eBay Products', range: 'eBay Products!A2:N', keyCol: 0, table: 'platform_listings', filter: { platform: 'ebay' } },
    { label: 'Shopify', range: 'Shopify!A2:K', keyCol: 0, table: 'platform_listings', filter: { platform: 'shopify' } },
    { label: 'Naver Products', range: 'Naver Products!A2:J', keyCol: 0, table: 'platform_listings', filter: { platform: 'naver' } },
    { label: 'Alibaba Products', range: 'Alibaba Products!A2:J', keyCol: 0, table: 'platform_listings', filter: { platform: 'alibaba' } },
    { label: '주문 배송', range: '주문 배송!A2:T', keyCol: 2, table: 'orders', filter: null },
  ];

  let allMatch = true;

  for (const check of checks) {
    const sheetCount = await countSheetRows(check.range, check.keyCol);
    const dbCount = await countDbRows(check.table, check.filter);
    const match = sheetCount === dbCount;
    if (!match) allMatch = false;

    const icon = sheetCount === -1 ? '⚠️' : match ? '✅' : '❌';
    console.log(`  ${icon} ${check.label.padEnd(20)} Sheet: ${String(sheetCount).padStart(5)}  DB: ${String(dbCount).padStart(5)}  ${match ? 'MATCH' : 'MISMATCH'}`);
  }

  // B2B
  const buyerSheetCount = await countSheetRows("'B2B Buyers'!A2:M", 0);
  const buyerDbCount = await countDbRows('b2b_buyers');
  console.log(`  ${buyerSheetCount === buyerDbCount ? '✅' : '❌'} ${'B2B Buyers'.padEnd(20)} Sheet: ${String(buyerSheetCount).padStart(5)}  DB: ${String(buyerDbCount).padStart(5)}`);

  const invSheetCount = await countSheetRows("'B2B Invoices'!A2:P", 0);
  const invDbCount = await countDbRows('b2b_invoices');
  console.log(`  ${invSheetCount === invDbCount ? '✅' : '❌'} ${'B2B Invoices'.padEnd(20)} Sheet: ${String(invSheetCount).padStart(5)}  DB: ${String(invDbCount).padStart(5)}`);

  // JSON files
  const scoresPath = path.join(__dirname, '../data/sku-scores.json');
  if (fs.existsSync(scoresPath)) {
    const scores = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
    const jsonCount = Object.keys(scores.scores || {}).length;
    const dbScoreCount = await countDbRows('sku_scores');
    console.log(`  ${jsonCount === dbScoreCount ? '✅' : '❌'} ${'SKU Scores'.padEnd(20)} JSON:  ${String(jsonCount).padStart(5)}  DB: ${String(dbScoreCount).padStart(5)}`);
  }

  const historyPath = path.join(__dirname, '../data/price-history.json');
  if (fs.existsSync(historyPath)) {
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    let jsonCount = 0;
    Object.values(history.snapshots || {}).forEach(arr => { jsonCount += arr.length; });
    const dbHistCount = await countDbRows('price_history');
    console.log(`  ${jsonCount === dbHistCount ? '✅' : '❌'} ${'Price History'.padEnd(20)} JSON:  ${String(jsonCount).padStart(5)}  DB: ${String(dbHistCount).padStart(5)}`);
  }

  return allMatch;
}

async function verifySettlementCalc() {
  console.log('\n=== Settlement Calculation Verification ===\n');

  // Spot-check eBay listings
  const { data: ebayRows } = await db
    .from('platform_listings')
    .select('sku, price, shipping_cost, fee_rate')
    .eq('platform', 'ebay')
    .limit(5);

  if (!ebayRows || ebayRows.length === 0) {
    console.log('  No eBay listings to verify');
    return;
  }

  for (const r of ebayRows) {
    const p = parseFloat(r.price) || 0;
    const s = parseFloat(r.shipping_cost) || 0;
    const f = parseFloat(r.fee_rate) || 13;
    const expected = Math.round((p + s) * (1 - f / 100) * 1400);
    console.log(`  ${r.sku}: (${p} + ${s}) * (1 - ${f}%) * 1400 = ₩${expected.toLocaleString()}`);
  }
}

async function verifySampleData() {
  console.log('\n=== Sample Data Verification ===\n');

  // Check products
  const { data: samples } = await db
    .from('products')
    .select('sku, title_ko, price_usd, margin_pct, ebay_item_id')
    .not('sku', 'is', null)
    .neq('sku', '')
    .limit(3);

  if (samples && samples.length > 0) {
    console.log('  Sample products:');
    samples.forEach(s => {
      console.log(`    SKU: ${s.sku} | Title: ${(s.title_ko || '').substring(0, 40)} | $${s.price_usd} | Margin: ${s.margin_pct}%`);
    });
  }

  // Check platform_listings distribution
  const platforms = ['ebay', 'shopify', 'naver', 'alibaba'];
  console.log('\n  Platform listings:');
  for (const p of platforms) {
    const count = await countDbRows('platform_listings', { platform: p });
    console.log(`    ${p.padEnd(10)}: ${count} listings`);
  }

  // Check orders
  const { data: orderSamples } = await db
    .from('orders')
    .select('order_no, platform, sku, payment_amount, currency')
    .order('order_date', { ascending: false })
    .limit(3);

  if (orderSamples && orderSamples.length > 0) {
    console.log('\n  Recent orders:');
    orderSamples.forEach(o => {
      console.log(`    ${o.order_no} | ${o.platform} | ${o.sku} | ${o.currency} ${o.payment_amount}`);
    });
  }
}

async function verifyExistingTables() {
  console.log('\n=== Existing Tables Health Check ===\n');

  const existingTables = [
    'products', 'platform_listings', 'product_images',
    'pricing_settings', 'shipping_rates', 'platform_tokens',
  ];

  for (const table of existingTables) {
    const count = await countDbRows(table);
    const icon = count >= 0 ? '✅' : '❌';
    console.log(`  ${icon} ${table.padEnd(22)} ${count >= 0 ? count + ' rows' : 'ERROR'}`);
  }
}

async function main() {
  await init();

  await verifyExistingTables();
  const allMatch = await verifyRowCounts();
  await verifySettlementCalc();
  await verifySampleData();

  console.log('\n========================================');
  console.log(allMatch ? '✅ All row counts match!' : '❌ Some mismatches found — review above');
  console.log('========================================');
}

main().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
