#!/usr/bin/env node
/**
 * Google Sheets 최종 Dashboard → competitor_prices Supabase import
 *
 * Reads columns N (eBay Item ID as sku) and V-AG (3 competitors × name/itemID/price/shipping)
 * and upserts into competitor_prices table.
 *
 * Usage: node scripts/import-competitor-prices.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });

const GoogleSheetsAPI = require('../src/api/googleSheetsAPI');
const { getClient } = require('../src/db/supabaseClient');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
// Sheet name wrapped in single quotes to handle spaces/special chars in Sheets API
const SHEET_RANGE = "'최종 Dashboard'!N:AG";

// Column offsets from N (index 0):
// N=0: eBay Item ID
// O-U (1-7): skipped
// V=8: 경쟁셀러1 이름, W=9: 상품ID, X=10: 판매가, Y=11: 배송비
// Z=12: 경쟁셀러2 이름, AA=13: 상품ID, AB=14: 판매가, AC=15: 배송비
// AD=16: 경쟁셀러3 이름, AE=17: 상품ID, AF=18: 판매가, AG=19: 배송비
//
// Range N:AG spans columns N through AG = 20 columns total (index 0-19)
const COMPETITOR_SLOTS = [
  { nameIdx: 8, itemIdx: 9, priceIdx: 10, shipIdx: 11 },  // V-Y
  { nameIdx: 12, itemIdx: 13, priceIdx: 14, shipIdx: 15 }, // Z-AC
  { nameIdx: 16, itemIdx: 17, priceIdx: 18, shipIdx: 19 }, // AD-AG
];

async function importCompetitorPrices() {
  if (!SPREADSHEET_ID) throw new Error('GOOGLE_SPREADSHEET_ID not set in env');

  const sheets = new GoogleSheetsAPI();
  const allRows = await sheets.readData(SPREADSHEET_ID, SHEET_RANGE);
  // Skip header row (row index 0 = sheet row 1)
  const rows = allRows.slice(1);

  const db = getClient();
  const toInsert = [];

  for (const row of rows) {
    const sku = row[0]?.toString().trim();
    if (!sku) continue;

    for (const c of COMPETITOR_SLOTS) {
      const name = row[c.nameIdx]?.toString().trim();
      const itemId = row[c.itemIdx]?.toString().trim();
      const price = parseFloat(row[c.priceIdx]);
      const shipping = parseFloat(row[c.shipIdx]) || 0;

      if (!name || isNaN(price)) continue;

      toInsert.push({
        sku,
        competitor_id: itemId || name,
        competitor_price: price,
        competitor_shipping: shipping,
        competitor_url: itemId ? `https://www.ebay.com/itm/${itemId}` : null,
        tracked_at: new Date().toISOString(),
      });
    }
  }

  if (toInsert.length === 0) {
    console.log('No competitor data found in sheet');
    return { inserted: 0 };
  }

  // Delete existing entries for affected SKUs then re-insert
  const skus = [...new Set(toInsert.map(r => r.sku))];
  const { error: delError } = await db.from('competitor_prices').delete().in('sku', skus);
  if (delError) throw new Error(`Delete failed: ${delError.message}`);

  for (let i = 0; i < toInsert.length; i += 500) {
    const batch = toInsert.slice(i, i + 500);
    const { error } = await db.from('competitor_prices').insert(batch);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }

  console.log(`Imported ${toInsert.length} competitor price records for ${skus.length} SKUs`);
  return { inserted: toInsert.length, skus: skus.length };
}

module.exports = { importCompetitorPrices };

if (require.main === module) {
  importCompetitorPrices()
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
