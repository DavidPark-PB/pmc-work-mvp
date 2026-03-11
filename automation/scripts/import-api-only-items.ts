import 'dotenv/config';
import axios from 'axios';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { products, platformListings } from '../src/db/schema.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BATCH_SIZE = 100;

// ============================================================
// DB
// ============================================================
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// ============================================================
// eBay Client (from compare-xlsx-vs-api.ts)
// ============================================================
class EbayClient {
  private apiUrl: string;
  private userToken: string;
  private headers: Record<string, string>;

  constructor() {
    this.userToken = process.env.EBAY_USER_TOKEN || '';
    const env = process.env.EBAY_ENVIRONMENT || 'PRODUCTION';
    this.apiUrl = env === 'PRODUCTION'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';

    this.headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1355',
      'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
      'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID || '',
      'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID || '',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml',
    };

    if (this.userToken.length > 200) {
      this.headers['X-EBAY-API-IAF-TOKEN'] = this.userToken;
    }
  }

  private async call(callName: string, body: string): Promise<string> {
    const isOAuth = this.userToken.length > 200;
    const credentialsXml = isOAuth ? '' : `
      <RequesterCredentials>
        <eBayAuthToken>${this.userToken}</eBayAuthToken>
      </RequesterCredentials>`;

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentialsXml}
  ${body}
</${callName}Request>`;

    const res = await axios.post(this.apiUrl, xml, {
      headers: { ...this.headers, 'X-EBAY-API-CALL-NAME': callName },
      timeout: 30000,
    });
    return res.data;
  }

  private extract(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : '';
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await this.call('GetUser', '');
      const userId = this.extract(res, 'UserID');
      console.log(`  eBay 연결: ${userId}`);
      return true;
    } catch (e: any) {
      console.error(`  eBay 연결 실패: ${e.message}`);
      return false;
    }
  }

  async getAllActiveListings(): Promise<Map<string, { title: string; price: string; sku: string; quantity: number; quantitySold: number }>> {
    const items = new Map<string, { title: string; price: string; sku: string; quantity: number; quantitySold: number }>();
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const body = `
        <ActiveList>
          <Include>true</Include>
          <Pagination>
            <EntriesPerPage>200</EntriesPerPage>
            <PageNumber>${page}</PageNumber>
          </Pagination>
        </ActiveList>
        <DetailLevel>ReturnAll</DetailLevel>`;

      const res = await this.call('GetMyeBaySelling', body);
      const ack = this.extract(res, 'Ack');
      if (ack === 'Failure') {
        console.error(`  eBay API 에러: ${this.extract(res, 'ShortMessage')}`);
        break;
      }

      const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
      let match;
      while ((match = itemRegex.exec(res)) !== null) {
        const xml = match[1];
        const itemId = this.extract(xml, 'ItemID');
        items.set(itemId, {
          title: this.extract(xml, 'Title'),
          price: this.extract(xml, 'CurrentPrice'),
          sku: this.extract(xml, 'SKU'),
          quantity: parseInt(this.extract(xml, 'Quantity')) || 0,
          quantitySold: parseInt(this.extract(xml, 'QuantitySold')) || 0,
        });
      }

      const totalPages = parseInt(this.extract(res, 'TotalNumberOfPages')) || 1;
      process.stdout.write(`\r  eBay 페이지 ${page}/${totalPages}: ${items.size}개`);
      hasMore = page < totalPages;
      page++;
      if (hasMore) await sleep(500);
    }
    console.log();
    return items;
  }
}

// ============================================================
// Shopify Client (from compare-xlsx-vs-api.ts)
// ============================================================
class ShopifyClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor() {
    const store = process.env.SHOPIFY_STORE_URL || '';
    const version = process.env.SHOPIFY_API_VERSION || '2024-01';
    this.baseUrl = `https://${store}/admin/api/${version}`;
    this.headers = {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN || '',
      'Content-Type': 'application/json',
    };
  }

  async getAllProducts(): Promise<Map<string, { title: string; price: string; productId: string; variantId: string }>> {
    const variants = new Map<string, { title: string; price: string; productId: string; variantId: string }>();
    let url: string | null = `${this.baseUrl}/products.json?limit=250&status=active`;

    while (url) {
      const res = await axios.get(url, { headers: this.headers, timeout: 30000 });
      for (const product of res.data.products) {
        for (const variant of product.variants) {
          const sku = variant.sku || `SHOPIFY-${variant.id}`;
          variants.set(sku, {
            title: product.title + (variant.title !== 'Default Title' ? ` - ${variant.title}` : ''),
            price: variant.price,
            productId: String(product.id),
            variantId: String(variant.id),
          });
        }
      }
      process.stdout.write(`\r  Shopify: ${variants.size}개 variants`);
      const link = res.headers.link;
      url = null;
      if (link) {
        for (const l of link.split(',')) {
          if (l.includes('rel="next"')) {
            const m = l.match(/<([^>]+)>/);
            if (m) url = m[1];
          }
        }
      }
      if (url) await sleep(500);
    }
    console.log();
    return variants;
  }
}

// ============================================================
// Main: Import API-only items
// ============================================================
async function importApiOnlyItems() {
  console.log('=== API-only 아이템 DB 임포트 ===\n');

  // 1) 현재 DB에서 최대 SKU 번호 조회
  const maxSkuResult = await db.select({ sku: products.sku }).from(products).orderBy(products.sku).limit(1);
  const allProducts = await pool.query('SELECT MAX(CAST(SUBSTRING(sku FROM 5) AS INTEGER)) as max_num FROM products');
  let skuCounter = allProducts.rows[0].max_num || 19257;
  console.log(`현재 최대 SKU: PMC-${String(skuCounter).padStart(5, '0')}`);

  function nextSku(): string {
    skuCounter++;
    return `PMC-${String(skuCounter).padStart(5, '0')}`;
  }

  // 2) DB에서 기존 eBay platform_item_id 목록 조회
  console.log('\n--- DB 기존 리스팅 조회 ---');
  const existingEbayRows = await pool.query(
    `SELECT platform_item_id FROM platform_listings WHERE platform = 'ebay' AND platform_item_id IS NOT NULL`
  );
  const existingEbayIds = new Set(existingEbayRows.rows.map((r: any) => r.platform_item_id));
  console.log(`  DB eBay 리스팅: ${existingEbayIds.size}개`);

  const existingShopifyRows = await pool.query(
    `SELECT platform_sku FROM platform_listings WHERE platform = 'shopify' AND platform_sku IS NOT NULL`
  );
  const existingShopifySkus = new Set(existingShopifyRows.rows.map((r: any) => r.platform_sku));
  console.log(`  DB Shopify 리스팅: ${existingShopifySkus.size}개`);

  // 3) eBay API 호출
  console.log('\n--- eBay API 조회 ---');
  const ebay = new EbayClient();
  const ebayOk = await ebay.testConnection();
  if (!ebayOk) {
    console.error('eBay 연결 실패! 토큰 갱신 필요.');
    console.error('실행: npx tsx scripts/refresh-ebay-token.ts');
    // Shopify만 진행
  }

  let ebayApiItems: Map<string, { title: string; price: string; sku: string; quantity: number; quantitySold: number }>;
  if (ebayOk) {
    ebayApiItems = await ebay.getAllActiveListings();
    console.log(`  API active: ${ebayApiItems.size}개`);
  } else {
    ebayApiItems = new Map();
  }

  // 4) Shopify API 호출
  console.log('\n--- Shopify API 조회 ---');
  const shopify = new ShopifyClient();
  const shopifyApiItems = await shopify.getAllProducts();
  console.log(`  API active: ${shopifyApiItems.size}개`);

  // 5) eBay: API에만 있는 아이템 찾기
  console.log('\n=== eBay API-only 아이템 ===');
  const ebayApiOnly: { itemId: string; title: string; price: string; sku: string; quantity: number; quantitySold: number }[] = [];
  for (const [itemId, data] of ebayApiItems) {
    if (!existingEbayIds.has(itemId)) {
      ebayApiOnly.push({ itemId, ...data });
    }
  }
  console.log(`  API-only: ${ebayApiOnly.length}개 (API ${ebayApiItems.size} - DB ${existingEbayIds.size}에 있는것 제외)`);

  if (ebayApiOnly.length > 10) {
    console.log(`  샘플 10개:`);
    for (const item of ebayApiOnly.slice(0, 10)) {
      console.log(`    ${item.itemId} | SKU: ${item.sku || '없음'} | $${item.price} | ${item.title.substring(0, 50)}`);
    }
  }

  // 6) Shopify: API에만 있는 아이템 찾기
  console.log('\n=== Shopify API-only 아이템 ===');
  const shopifyApiOnly: { sku: string; title: string; price: string; productId: string; variantId: string }[] = [];
  for (const [sku, data] of shopifyApiItems) {
    if (!existingShopifySkus.has(sku)) {
      shopifyApiOnly.push({ sku, ...data });
    }
  }
  console.log(`  API-only: ${shopifyApiOnly.length}개 (API ${shopifyApiItems.size} - DB ${existingShopifySkus.size}에 있는것 제외)`);

  if (shopifyApiOnly.length > 0) {
    console.log(`  전체 목록:`);
    for (const item of shopifyApiOnly) {
      console.log(`    SKU: ${item.sku} | $${item.price} | ${item.title.substring(0, 60)}`);
    }
  }

  // 안전장치: 너무 많으면 중단
  if (ebayApiOnly.length > 500) {
    console.error(`\n!!! eBay API-only가 ${ebayApiOnly.length}개로 너무 많습니다.`);
    console.error('데이터 정합성 문제 가능. 수동 확인 필요.');
    await pool.end();
    return;
  }

  // 7) eBay API-only → DB INSERT
  if (ebayApiOnly.length > 0) {
    console.log(`\n--- eBay ${ebayApiOnly.length}개 INSERT ---`);
    let inserted = 0;

    for (let i = 0; i < ebayApiOnly.length; i += BATCH_SIZE) {
      const batch = ebayApiOnly.slice(i, i + BATCH_SIZE);

      // products INSERT
      const productRows = batch.map(item => ({
        sku: nextSku(),
        title: item.title,
        status: 'active',
        metadata: {
          source: 'ebay_api_import',
          ebayItemId: item.itemId,
          ebaySku: item.sku || null,
          importedAt: new Date().toISOString(),
        },
      }));

      const insertedProducts = await db.insert(products).values(productRows).returning({ id: products.id });

      // platform_listings INSERT
      const listingRows = batch.map((item, idx) => ({
        productId: insertedProducts[idx].id,
        platform: 'ebay' as const,
        platformItemId: item.itemId,
        platformSku: item.sku || null,
        status: 'active',
        price: item.price || null,
        currency: 'USD',
        lastSyncedAt: new Date(),
        platformData: {
          quantity: item.quantity,
          quantitySold: item.quantitySold,
          importSource: 'api_import',
        },
      }));

      await db.insert(platformListings).values(listingRows);
      inserted += batch.length;
      process.stdout.write(`\r  eBay INSERT: ${inserted}/${ebayApiOnly.length}`);
    }
    console.log();
    console.log(`  eBay ${inserted}개 완료 (products + platform_listings)`);
  }

  // 8) Shopify API-only → DB INSERT
  if (shopifyApiOnly.length > 0) {
    console.log(`\n--- Shopify ${shopifyApiOnly.length}개 INSERT ---`);
    let inserted = 0;

    for (let i = 0; i < shopifyApiOnly.length; i += BATCH_SIZE) {
      const batch = shopifyApiOnly.slice(i, i + BATCH_SIZE);

      // products INSERT
      const productRows = batch.map(item => ({
        sku: nextSku(),
        title: item.title,
        status: 'active',
        metadata: {
          source: 'shopify_api_import',
          shopifySku: item.sku,
          shopifyProductId: item.productId,
          shopifyVariantId: item.variantId,
          importedAt: new Date().toISOString(),
        },
      }));

      const insertedProducts = await db.insert(products).values(productRows).returning({ id: products.id });

      // platform_listings INSERT
      const listingRows = batch.map((item, idx) => ({
        productId: insertedProducts[idx].id,
        platform: 'shopify' as const,
        platformItemId: item.productId,
        platformSku: item.sku,
        status: 'active',
        price: item.price || null,
        currency: 'USD',
        lastSyncedAt: new Date(),
        platformData: {
          variantId: item.variantId,
          importSource: 'api_import',
        },
      }));

      await db.insert(platformListings).values(listingRows);
      inserted += batch.length;
      process.stdout.write(`\r  Shopify INSERT: ${inserted}/${shopifyApiOnly.length}`);
    }
    console.log();
    console.log(`  Shopify ${inserted}개 완료 (products + platform_listings)`);
  }

  // 9) 결과 검증
  console.log('\n=== 검증: 최종 DB 상태 ===');
  const finalResult = await pool.query(
    `SELECT platform, status, COUNT(*) as cnt FROM platform_listings GROUP BY platform, status ORDER BY platform, status`
  );
  for (const row of finalResult.rows) {
    console.log(`  ${row.platform} / ${row.status}: ${row.cnt}`);
  }

  const totalProducts = await pool.query('SELECT COUNT(*) as cnt FROM products');
  const maxSkuFinal = await pool.query('SELECT MAX(sku) as max_sku FROM products');
  console.log(`\n  총 products: ${totalProducts.rows[0].cnt}`);
  console.log(`  최대 SKU: ${maxSkuFinal.rows[0].max_sku}`);

  console.log('\n=== 완료 ===');
  await pool.end();
}

importApiOnlyItems().catch(e => {
  console.error('에러:', e);
  pool.end();
  process.exit(1);
});
