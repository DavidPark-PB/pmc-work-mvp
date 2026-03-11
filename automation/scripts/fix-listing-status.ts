import 'dotenv/config';
import XLSX from 'xlsx';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { products, platformListings } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';

const XLSX_PATH = 'C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx';
const BATCH_SIZE = 50;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

function toNum(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? null : String(n);
}

async function fix() {
  console.log('=== Phase 1.5: 리스팅 상태 교정 ===\n');

  // ============================================================
  // Step 1: eBay 상태 확인 (이미 완료)
  // ============================================================
  console.log('--- Step 1: eBay 상태 확인 ---');
  const ebayCheck = await db.execute(sql`
    SELECT status, count(*)::int as cnt FROM platform_listings
    WHERE platform = 'ebay' GROUP BY status
  `);
  for (const row of ebayCheck.rows) {
    console.log(`  ebay ${row.status}: ${row.cnt}`);
  }

  // ============================================================
  // Step 2: 기존 Shopify 리스팅 전부 삭제 (잘못된 데이터 + 부분 삽입분)
  // ============================================================
  console.log('\n--- Step 2: 기존 Shopify 리스팅 삭제 ---');
  const delResult = await db.delete(platformListings)
    .where(eq(platformListings.platform, 'shopify'));
  console.log(`  삭제: ${delResult.rowCount}개`);

  // ============================================================
  // Step 3: Shopify 시트 → platform_listings INSERT
  // ============================================================
  console.log('\n--- Step 3: Shopify 시트 → platform_listings ---');
  const wb = XLSX.readFile(XLSX_PATH);
  const shopRows = XLSX.utils.sheet_to_json(wb.Sheets['Shopify'], { header: 1 }) as unknown[][];
  console.log(`  Shopify 시트 행수: ${shopRows.length - 1}`);

  // Build legacySku → productId map
  console.log('  products 테이블 로딩...');
  const allProducts = await db.select({
    id: products.id,
    legacySku: sql<string>`metadata->>'legacySku'`,
  }).from(products);

  const skuToProductId = new Map<string, number>();
  for (const p of allProducts) {
    if (p.legacySku) {
      skuToProductId.set(p.legacySku, p.id);
    }
  }
  console.log(`  legacySku 매핑: ${skuToProductId.size}개`);

  // Process Shopify rows — deduplicate by productId (unique constraint)
  const seenProductIds = new Set<number>();
  const shopifyListings: any[] = [];
  let matched = 0;
  let unmatched = 0;
  let duplicates = 0;

  for (let i = 1; i < shopRows.length; i++) {
    const r = shopRows[i];
    const sku = String(r[0] || '').trim();
    if (!sku) continue;

    const productId = skuToProductId.get(sku);
    if (!productId) {
      unmatched++;
      continue;
    }

    if (seenProductIds.has(productId)) {
      duplicates++;
      continue;
    }
    seenProductIds.add(productId);
    matched++;

    shopifyListings.push({
      productId,
      platform: 'shopify',
      platformSku: sku,
      platformItemId: sku.startsWith('SHOPIFY-') ? sku.replace('SHOPIFY-', '') : null,
      status: 'active',
      price: toNum(r[3]),
      currency: 'USD',
      platformData: {
        title: String(r[1] || '').trim() || null,
        costKRW: toNum(r[2]),
        exchangeRate: toNum(r[4]),
        feePercent: toNum(r[5]),
        shippingKRW: toNum(r[6]),
        profitKRW: toNum(r[7]),
        marginPercent: toNum(r[8]),
        inspectionStatus: String(r[9] || '').trim() || null,
        weight: toNum(r[11]),
        weightUnit: String(r[12] || '').trim() || null,
      },
    });
  }

  console.log(`  매칭: ${matched}개 / 미매칭: ${unmatched}개 / 중복: ${duplicates}개`);

  // Batch insert
  if (shopifyListings.length > 0) {
    for (let i = 0; i < shopifyListings.length; i += BATCH_SIZE) {
      const batch = shopifyListings.slice(i, i + BATCH_SIZE);
      await db.insert(platformListings).values(batch as any);
      process.stdout.write(`\r  INSERT: ${Math.min(i + BATCH_SIZE, shopifyListings.length)}/${shopifyListings.length}`);
    }
    console.log();
  }
  console.log(`  Shopify 리스팅 생성: ${shopifyListings.length}개`);

  // ============================================================
  // Step 4: products.status 연쇄 교정
  // ============================================================
  console.log('\n--- Step 4: products.status 연쇄 교정 ---');
  const prodResult = await db.execute(sql`
    UPDATE products SET status = 'active', updated_at = NOW()
    WHERE id IN (
      SELECT DISTINCT product_id FROM platform_listings WHERE status = 'active'
    ) AND status != 'active'
  `);
  console.log(`  products.status → active: ${prodResult.rowCount}개 교정`);

  // ============================================================
  // Step 5: 검증
  // ============================================================
  console.log('\n--- Step 5: 검증 ---');
  const listingCounts = await db.execute(sql`
    SELECT platform, status, count(*)::int as cnt
    FROM platform_listings
    GROUP BY platform, status
    ORDER BY platform, status
  `);
  console.log('\n  플랫폼별 리스팅:');
  for (const row of listingCounts.rows) {
    console.log(`    ${row.platform} ${row.status}: ${row.cnt}`);
  }

  const productCounts = await db.execute(sql`
    SELECT status, count(*)::int as cnt
    FROM products
    GROUP BY status
    ORDER BY status
  `);
  console.log('\n  상품 상태:');
  for (const row of productCounts.rows) {
    console.log(`    ${row.status}: ${row.cnt}`);
  }

  const multiPlatform = await db.execute(sql`
    SELECT count(*)::int as cnt FROM (
      SELECT product_id FROM platform_listings
      WHERE status = 'active'
      GROUP BY product_id
      HAVING count(DISTINCT platform) > 1
    ) t
  `);
  console.log(`\n  멀티플랫폼 상품 (active): ${multiPlatform.rows[0].cnt}개`);

  await pool.end();
  console.log('\n=== 교정 완료 ===');
}

fix().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
