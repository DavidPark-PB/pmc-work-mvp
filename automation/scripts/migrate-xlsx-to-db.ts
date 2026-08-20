import 'dotenv/config';
import XLSX from 'xlsx';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  products,
  productImages,
  platformListings,
  shippingRates,
  orders,
  orderItems,
  b2bBuyers,
  b2bInvoices,
} from '../src/db/schema.js';

// ============================================================
// Config
// ============================================================
const XLSX_PATH = 'C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx';
const BATCH_SIZE = 500;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// ============================================================
// SKU Generator
// ============================================================
let skuCounter = 0;
function nextSku(): string {
  skuCounter++;
  return `PMC-${String(skuCounter).padStart(5, '0')}`;
}

// ============================================================
// Helpers
// ============================================================
function toNum(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (s.includes('#VALUE') || s.includes('품절') || s === '품절?') return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? null : String(n);
}

function toInt(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = parseInt(String(val), 10);
  return isNaN(n) ? null : n;
}

function toStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

function classifyDashboardRow(row: unknown[]): number {
  const sku = String(row[1] || '').trim();
  const ebayStatus = String(row[16] || '').trim();
  const cost = String(row[4] || '').trim();

  if (!sku) return 5;
  if (sku.startsWith('TEST')) return 5;
  if (cost.includes('품절') || cost.includes('#VALUE')) return 3;
  if (ebayStatus.includes('품절')) return 3;
  if (/[\uac00-\ud7a3]/.test(sku)) return 4;
  if (ebayStatus.includes('등록됨')) return 1;
  if (/^\d{12,15}$/.test(sku) || /^SHOPIFY-/.test(sku)) return 2;
  return 5;
}

function mapEbayStatus(val: string): string {
  if (val.includes('등록됨') || val === '등록완료') return 'active';
  if (val.includes('품절')) return 'ended';
  return 'draft';
}

function mapProductStatus(tier: number, ebayStatus: string): string {
  if (tier === 3 || ebayStatus.includes('품절')) return 'soldout';
  if (tier === 1) return 'active';
  return 'pending';
}

async function batchInsert<T extends Record<string, unknown>>(
  table: any,
  rows: T[],
  label: string,
): Promise<{ ids: number[] }> {
  const allIds: number[] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const result = await db.insert(table).values(batch as any).returning({ id: table.id });
    allIds.push(...result.map((r: any) => r.id));
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
  console.log();
  return { ids: allIds };
}

// ============================================================
// Main Migration
// ============================================================
async function migrate() {
  console.log('Reading XLSX...');
  const wb = XLSX.readFile(XLSX_PATH);

  function sheet(name: string): unknown[][] {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
  }

  const summary: Record<string, number> = {};

  // ============================================================
  // Step 1: Shipping Rates
  // ============================================================
  console.log('\n=== Step 1: Shipping Rates ===');
  const shipRows = sheet('Shipping Rates');
  const shipValues: any[] = [];
  for (let i = 1; i < shipRows.length; i++) {
    const r = shipRows[i];
    const carrier = toStr(r[0]);
    const weight = toNum(r[2]);
    const rate = toNum(r[3]);
    if (!carrier || !weight || !rate) continue;
    shipValues.push({
      carrier,
      minWeight: weight,
      maxWeight: weight,
      rate,
      currency: 'KRW',
      destination: toStr(r[1]) || 'US',
      isActive: true,
    });
  }
  await batchInsert(shippingRates, shipValues, 'Shipping Rates');
  summary['shipping_rates'] = shipValues.length;

  // ============================================================
  // Step 2: Dashboard → Products + eBay/Shopify Listings
  // ============================================================
  console.log('\n=== Step 2: Dashboard Products ===');
  const dashRows = sheet('최종 Dashboard');
  console.log(`  Total rows: ${dashRows.length - 1}`);

  // Sort by tier for PMC numbering
  type DashEntry = { idx: number; tier: number; row: unknown[] };
  const entries: DashEntry[] = [];
  for (let i = 1; i < dashRows.length; i++) {
    const tier = classifyDashboardRow(dashRows[i]);
    entries.push({ idx: i, tier, row: dashRows[i] });
  }
  entries.sort((a, b) => a.tier - b.tier || a.idx - b.idx);

  const tierCounts: Record<number, number> = {};
  const productValues: any[] = [];
  const ebayListingQueue: { productIdx: number; row: unknown[] }[] = [];
  const shopifyListingQueue: { productIdx: number; row: unknown[] }[] = [];
  const imageQueue: { productIdx: number; url: string }[] = [];

  // Maps for cross-referencing later
  const ebayItemIdToProductIdx = new Map<string, number>();
  const legacySkuToProductIdx = new Map<string, number>();

  for (const entry of entries) {
    const r = entry.row;
    const legacySku = toStr(r[1]);
    const title = toStr(r[2]);
    if (!title) continue; // skip rows with no title

    const weightKg = toNum(r[3]);
    const weightG = weightKg ? String(parseFloat(weightKg) * 1000) : null;
    const costPrice = toNum(r[4]);
    const ebayStatus = String(r[16] || '').trim();
    const shopifyStatus = String(r[17] || '').trim();
    const sourcePlatform = toStr(r[18]);
    const sortOrder = toInt(r[20]);
    const ebayItemId = toStr(r[13]);

    // Build competitors array
    const competitors: any[] = [];
    if (toStr(r[21])) competitors.push({ name: toStr(r[21]), itemId: toStr(r[22]), price: toNum(r[23]), shipping: toNum(r[24]) });
    if (toStr(r[25])) competitors.push({ name: toStr(r[25]), itemId: toStr(r[26]), price: toNum(r[27]), shipping: toNum(r[28]) });
    if (toStr(r[29])) competitors.push({ name: toStr(r[29]), itemId: toStr(r[30]), price: toNum(r[31]), shipping: toNum(r[32]) });

    const sku = nextSku();
    tierCounts[entry.tier] = (tierCounts[entry.tier] || 0) + 1;

    const productIdx = productValues.length;
    productValues.push({
      sku,
      title,
      costPrice,
      costCurrency: 'KRW',
      weight: weightG,
      weightUnit: 'g',
      status: mapProductStatus(entry.tier, ebayStatus),
      metadata: {
        legacySku: legacySku,
        sourcePlatform,
        sortOrder,
        tier: entry.tier,
        ...(competitors.length > 0 && { competitors }),
      },
    });

    if (legacySku) legacySkuToProductIdx.set(legacySku, productIdx);

    // Queue eBay listing
    if (ebayItemId) {
      ebayItemIdToProductIdx.set(ebayItemId, productIdx);
      ebayListingQueue.push({ productIdx, row: r });
    }

    // Queue Shopify listing
    if (shopifyStatus && !shopifyStatus.includes('미등록') && shopifyStatus !== '') {
      shopifyListingQueue.push({ productIdx, row: r });
    }

    // Queue image
    const imgUrl = toStr(r[0]);
    if (imgUrl && imgUrl.startsWith('http')) {
      imageQueue.push({ productIdx, url: imgUrl });
    }
  }

  // Insert products
  const { ids: productIds } = await batchInsert(products, productValues, 'Products');
  summary['products_dashboard'] = productIds.length;
  console.log('  Tier distribution:', JSON.stringify(tierCounts));

  // Insert eBay listings
  console.log('  Inserting eBay listings...');
  const ebayListings: any[] = [];
  for (const q of ebayListingQueue) {
    const r = q.row;
    const productId = productIds[q.productIdx];
    const ebayStatus = String(r[16] || '').trim();
    ebayListings.push({
      productId,
      platform: 'ebay',
      platformItemId: toStr(r[13]),
      status: mapEbayStatus(ebayStatus),
      price: toNum(r[9]),
      currency: 'USD',
      platformData: {
        shippingUSD: toNum(r[10]),
        feeKRW: toNum(r[6]),
        taxKRW: toNum(r[7]),
        totalCostKRW: toNum(r[8]),
        profitKRW: toNum(r[11]),
        marginPercent: toNum(r[12]),
        salesCount: toInt(r[14]),
        stockCount: toInt(r[15]),
      },
    });
  }
  await batchInsert(platformListings, ebayListings, 'eBay Listings');
  summary['listings_ebay'] = ebayListings.length;

  // Insert Shopify listings from Dashboard
  console.log('  Inserting Shopify listings from Dashboard...');
  const shopifyListings: any[] = [];
  for (const q of shopifyListingQueue) {
    const r = q.row;
    const productId = productIds[q.productIdx];
    const legacySku = toStr(r[1]);
    const shopifyPrice = toNum(r[33]);
    shopifyListings.push({
      productId,
      platform: 'shopify',
      platformItemId: legacySku?.startsWith('SHOPIFY-') ? legacySku.replace('SHOPIFY-', '') : null,
      platformSku: legacySku,
      status: 'draft',
      price: shopifyPrice,
      currency: 'USD',
    });
  }
  if (shopifyListings.length > 0) {
    await batchInsert(platformListings, shopifyListings, 'Shopify Listings (Dashboard)');
  }
  summary['listings_shopify_dashboard'] = shopifyListings.length;

  // ============================================================
  // Step 3: eBay Products sheet → enrich existing listings
  // ============================================================
  console.log('\n=== Step 3: eBay Products Enrichment ===');
  const ebayRows = sheet('eBay Products');
  let ebayEnriched = 0;
  let ebayNew = 0;
  const newEbayProducts: any[] = [];

  for (let i = 1; i < ebayRows.length; i++) {
    const r = ebayRows[i];
    const itemId = String(r[2] || '').trim();
    if (!itemId) continue;

    // Check if already imported via Dashboard
    if (ebayItemIdToProductIdx.has(itemId)) {
      ebayEnriched++;
      continue; // already have this product
    }

    // New product not in Dashboard
    const title = toStr(r[1]);
    if (!title) continue;

    const sku = nextSku();
    newEbayProducts.push({
      product: {
        sku,
        title,
        status: 'pending',
        metadata: { legacySku: toStr(r[0]), source: 'ebay_products_sheet', tier: 2 },
      },
      listing: {
        platform: 'ebay',
        platformItemId: itemId,
        status: 'active',
        price: toNum(r[3]),
        currency: toStr(r[5]) || 'USD',
        platformData: {
          shippingUSD: toNum(r[4]),
          type: toStr(r[8]),
          feePercent: toNum(r[11]),
          imageUrl: toStr(r[13]),
        },
      },
    });
  }

  if (newEbayProducts.length > 0) {
    const prodVals = newEbayProducts.map((p) => p.product);
    const { ids: newProdIds } = await batchInsert(products, prodVals, 'New eBay Products');
    const listVals = newEbayProducts.map((p, i) => ({ ...p.listing, productId: newProdIds[i] }));
    await batchInsert(platformListings, listVals, 'New eBay Listings');
    ebayNew = newEbayProducts.length;
  }
  summary['ebay_enriched'] = ebayEnriched;
  summary['ebay_new'] = ebayNew;

  // ============================================================
  // Step 4: Shopify sheet → enrich/add listings
  // ============================================================
  console.log('\n=== Step 4: Shopify Sheet ===');
  const shopRows = sheet('Shopify');
  let shopEnriched = 0;
  let shopNew = 0;

  for (let i = 1; i < shopRows.length; i++) {
    const r = shopRows[i];
    const shopSku = toStr(r[0]);
    if (!shopSku) continue;

    // Check if product exists by legacy SKU
    if (legacySkuToProductIdx.has(shopSku)) {
      shopEnriched++;
      continue; // already have a listing from Dashboard
    }

    // New Shopify-only product
    const title = toStr(r[1]);
    if (!title) continue;

    // These are rare — most should already be in Dashboard
    shopNew++;
  }
  summary['shopify_enriched'] = shopEnriched;
  summary['shopify_new_skipped'] = shopNew; // skipping new Shopify products for now (they're all in Dashboard)

  // ============================================================
  // Step 5: Naver Products
  // ============================================================
  console.log('\n=== Step 5: Naver Products ===');
  const naverRows = sheet('Naver Products');
  const naverProducts: any[] = [];
  const naverListings: any[] = [];

  for (let i = 1; i < naverRows.length; i++) {
    const r = naverRows[i];
    const naverId = String(r[0] || '').trim();
    const title = toStr(r[1]);
    if (!title) continue;

    const sku = nextSku();
    const prodIdx = naverProducts.length;
    naverProducts.push({
      sku,
      title,
      titleKo: title, // Naver titles are Korean
      costPrice: toNum(r[2]),
      costCurrency: 'KRW',
      status: String(r[4] || '') === 'ON' ? 'active' : 'discontinued',
      metadata: { legacySku: naverId, source: 'naver_sheet', tier: 6 },
    });
    naverListings.push({
      _prodIdx: prodIdx,
      platform: 'naver',
      platformItemId: naverId,
      status: String(r[4] || '') === 'ON' ? 'active' : 'ended',
      price: toNum(r[2]),
      currency: 'KRW',
      platformData: {
        stock: toInt(r[3]),
        categoryId: toStr(r[5]),
        feePercent: toNum(r[7]),
        imageUrl: toStr(r[9]),
      },
    });
  }

  if (naverProducts.length > 0) {
    const { ids: naverProdIds } = await batchInsert(products, naverProducts, 'Naver Products');
    const naverListVals = naverListings.map((l) => {
      const { _prodIdx, ...rest } = l;
      return { ...rest, productId: naverProdIds[_prodIdx] };
    });
    await batchInsert(platformListings, naverListVals, 'Naver Listings');
  }
  summary['products_naver'] = naverProducts.length;
  summary['listings_naver'] = naverListings.length;

  // ============================================================
  // Step 6: Alibaba Products
  // ============================================================
  console.log('\n=== Step 6: Alibaba Products ===');
  const aliRows = sheet('Alibaba Products');
  const aliProducts: any[] = [];
  const aliListings: any[] = [];

  for (let i = 1; i < aliRows.length; i++) {
    const r = aliRows[i];
    const aliId = String(r[0] || '').trim();
    const title = toStr(r[1]);
    if (!title) continue;

    const sku = nextSku();
    const prodIdx = aliProducts.length;
    aliProducts.push({
      sku,
      title,
      status: String(r[3] || '') === 'approved' ? 'active' : 'pending',
      metadata: { legacySku: aliId, source: 'alibaba_sheet', tier: 7 },
    });
    aliListings.push({
      _prodIdx: prodIdx,
      platform: 'alibaba',
      platformItemId: aliId,
      status: String(r[3] || '') === 'approved' ? 'active' : 'draft',
      platformData: {
        categoryId: toStr(r[4]),
        feePercent: toNum(r[6]),
        imageUrl: toStr(r[8]),
        url: toStr(r[9]),
      },
    });
  }

  if (aliProducts.length > 0) {
    const { ids: aliProdIds } = await batchInsert(products, aliProducts, 'Alibaba Products');
    const aliListVals = aliListings.map((l) => {
      const { _prodIdx, ...rest } = l;
      return { ...rest, productId: aliProdIds[_prodIdx] };
    });
    await batchInsert(platformListings, aliListVals, 'Alibaba Listings');
  }
  summary['products_alibaba'] = aliProducts.length;
  summary['listings_alibaba'] = aliListings.length;

  // ============================================================
  // Step 7: Product Images
  // ============================================================
  console.log('\n=== Step 7: Product Images ===');
  const imgValues: any[] = [];
  for (const q of imageQueue) {
    imgValues.push({
      productId: productIds[q.productIdx],
      url: q.url,
      position: 0,
    });
  }
  if (imgValues.length > 0) {
    await batchInsert(productImages, imgValues, 'Images');
  }
  summary['images'] = imgValues.length;

  // ============================================================
  // Step 8: Orders
  // ============================================================
  console.log('\n=== Step 8: Orders ===');
  const orderRows = sheet('주문 배송');
  const orderValues: any[] = [];

  for (let i = 1; i < orderRows.length; i++) {
    const r = orderRows[i];
    const platform = toStr(r[1]);
    if (!platform) continue;

    // Excel date serial → JS Date
    let orderedAt: Date | null = null;
    const dateVal = r[0];
    if (typeof dateVal === 'number') {
      orderedAt = new Date((dateVal - 25569) * 86400 * 1000);
    }

    orderValues.push({
      platform: platform.toLowerCase(),
      platformOrderId: toStr(r[2]),
      buyerName: toStr(r[8]),
      buyerEmail: toStr(r[19]),
      shippingAddress: {
        street: toStr(r[13]),
        city: toStr(r[14]),
        province: toStr(r[15]),
        zipCode: toStr(r[16]),
        phone: toStr(r[17]),
        countryCode: toStr(r[18]),
      },
      totalAmount: toNum(r[6]),
      currency: toStr(r[7]) || 'USD',
      status: (toStr(r[12]) || 'pending').toLowerCase(),
      orderedAt,
      metadata: {
        sku: toStr(r[3]),
        productName: toStr(r[4]),
        quantity: toInt(r[5]),
      },
    });
  }

  if (orderValues.length > 0) {
    await batchInsert(orders, orderValues, 'Orders');
  }
  summary['orders'] = orderValues.length;

  // ============================================================
  // Step 9: B2B Buyers
  // ============================================================
  console.log('\n=== Step 9: B2B Buyers ===');
  const buyerRows = sheet('B2B Buyers');
  const buyerValues: any[] = [];

  for (let i = 1; i < buyerRows.length; i++) {
    const r = buyerRows[i];
    const name = toStr(r[1]);
    if (!name) continue;
    buyerValues.push({
      buyerId: toStr(r[0]),
      name,
      email: toStr(r[3]),
      phone: toStr(r[5]),
      country: toStr(r[7]),
      currency: toStr(r[8]) || 'USD',
      paymentTerms: toStr(r[9]),
      metadata: {
        contact: toStr(r[2]),
        whatsapp: toStr(r[4]),
        address: toStr(r[6]),
        notes: toStr(r[10]),
        totalOrders: toInt(r[11]),
        totalRevenue: toNum(r[12]),
      },
    });
  }

  if (buyerValues.length > 0) {
    await batchInsert(b2bBuyers, buyerValues, 'B2B Buyers');
  }
  summary['b2b_buyers'] = buyerValues.length;

  // ============================================================
  // Step 10: B2B Invoices
  // ============================================================
  console.log('\n=== Step 10: B2B Invoices ===');
  const invRows = sheet('B2B Invoices');
  const invValues: any[] = [];

  for (let i = 1; i < invRows.length; i++) {
    const r = invRows[i];
    const invoiceNumber = toStr(r[0]);
    if (!invoiceNumber) continue;

    let issuedAt: Date | null = null;
    if (typeof r[3] === 'number') {
      issuedAt = new Date((r[3] as number - 25569) * 86400 * 1000);
    }

    invValues.push({
      invoiceNumber,
      totalAmount: toNum(r[9]),
      currency: toStr(r[10]) || 'USD',
      status: (toStr(r[11]) || 'draft').toLowerCase(),
      items: r[5], // JSON string from sheet
      issuedAt,
      metadata: {
        buyerId: toStr(r[1]),
        buyerName: toStr(r[2]),
        subtotal: toNum(r[6]),
        tax: toNum(r[7]),
        shipping: toNum(r[8]),
        driveFileId: toStr(r[12]),
        driveUrl: toStr(r[13]),
      },
    });
  }

  if (invValues.length > 0) {
    await batchInsert(b2bInvoices, invValues, 'B2B Invoices');
  }
  summary['b2b_invoices'] = invValues.length;

  // ============================================================
  // Summary
  // ============================================================
  console.log('\n========================================');
  console.log('=== Migration Summary ===');
  console.log('========================================');
  console.log(`Total PMC SKUs generated: ${skuCounter}`);
  Object.entries(summary).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log('========================================');

  await pool.end();
  console.log('Done.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  pool.end();
  process.exit(1);
});
