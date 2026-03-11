import 'dotenv/config';
import axios from 'axios';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { products, platformListings } from '../src/db/schema.js';
import { eq, and, sql, inArray } from 'drizzle-orm';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============================================================
// eBay Trading API Client
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

    // OAuth token detection
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
      console.log(`  eBay 연결 성공: ${userId}`);
      return true;
    } catch (e: any) {
      console.error(`  eBay 연결 실패: ${e.message}`);
      return false;
    }
  }

  async getAllActiveListings(): Promise<EbayItem[]> {
    const items: EbayItem[] = [];
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

      // Check for errors
      const ack = this.extract(res, 'Ack');
      if (ack === 'Failure') {
        const err = this.extract(res, 'ShortMessage');
        console.error(`  eBay API 에러: ${err}`);
        break;
      }

      // Parse items
      const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
      let match;
      while ((match = itemRegex.exec(res)) !== null) {
        const xml = match[1];
        items.push({
          itemId: this.extract(xml, 'ItemID'),
          sku: this.extract(xml, 'SKU'),
          title: this.extract(xml, 'Title'),
          price: this.extract(xml, 'CurrentPrice'),
          quantity: parseInt(this.extract(xml, 'Quantity')) || 0,
          quantitySold: parseInt(this.extract(xml, 'QuantitySold')) || 0,
        });
      }

      const totalPages = parseInt(this.extract(res, 'TotalNumberOfPages')) || 1;
      process.stdout.write(`\r  eBay 페이지 ${page}/${totalPages}: ${items.length}개`);
      hasMore = page < totalPages;
      page++;

      if (hasMore) await sleep(500);
    }
    console.log();
    return items;
  }
}

interface EbayItem {
  itemId: string;
  sku: string;
  title: string;
  price: string;
  quantity: number;
  quantitySold: number;
}

// ============================================================
// Shopify Admin API Client
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

  async testConnection(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.baseUrl}/products/count.json`, {
        headers: this.headers, timeout: 10000,
      });
      console.log(`  Shopify 연결 성공: ${res.data.count}개 상품`);
      return true;
    } catch (e: any) {
      console.error(`  Shopify 연결 실패: ${e.message}`);
      return false;
    }
  }

  async getAllProducts(): Promise<ShopifyVariant[]> {
    const variants: ShopifyVariant[] = [];
    let url: string | null = `${this.baseUrl}/products.json?limit=250&status=active`;

    while (url) {
      const res = await axios.get(url, { headers: this.headers, timeout: 30000 });

      for (const product of res.data.products) {
        for (const variant of product.variants) {
          const sku = variant.sku || `SHOPIFY-${variant.id}`;
          variants.push({
            productId: String(product.id),
            variantId: String(variant.id),
            sku,
            title: product.title + (variant.title !== 'Default Title' ? ` - ${variant.title}` : ''),
            price: variant.price,
            status: product.status,
          });
        }
      }

      process.stdout.write(`\r  Shopify: ${variants.length}개 variants 로드됨`);

      // Parse Link header for next page
      const link = res.headers.link;
      url = null;
      if (link) {
        const links = link.split(',');
        for (const l of links) {
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

interface ShopifyVariant {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  price: string;
  status: string;
}

// ============================================================
// Main Verification
// ============================================================
async function verify() {
  console.log('=== Phase 1.6: API 비교대조 ===\n');

  // --- Connection Test ---
  console.log('--- 연결 테스트 ---');
  const ebay = new EbayClient();
  const shopify = new ShopifyClient();

  const ebayOk = await ebay.testConnection();
  const shopifyOk = await shopify.testConnection();

  if (!ebayOk || !shopifyOk) {
    console.error('연결 실패. .env 확인 필요.');
    await pool.end();
    return;
  }

  // ============================================================
  // eBay 비교대조
  // ============================================================
  console.log('\n--- eBay API 비교대조 ---');
  const apiEbayItems = await ebay.getAllActiveListings();
  console.log(`  API active: ${apiEbayItems.length}개`);

  // 안전장치: API가 0개인데 DB에 많으면 중단
  const dbEbayActiveCount = await db.execute(sql`
    SELECT count(*)::int as cnt FROM platform_listings WHERE platform = 'ebay' AND status = 'active'
  `);
  const dbEbayActiveNum = (dbEbayActiveCount.rows[0] as any).cnt;
  if (apiEbayItems.length === 0 && dbEbayActiveNum > 100) {
    console.error(`\n  ⚠️ 안전장치 발동! API 0개 vs DB active ${dbEbayActiveNum}개`);
    console.error('  eBay API 인증 실패 가능성. eBay 교정 건너뜀.\n');
    // Shopify만 진행
  }

  // DB에서 eBay 리스팅 조회
  const dbEbayListings = await db.select({
    id: platformListings.id,
    productId: platformListings.productId,
    platformItemId: platformListings.platformItemId,
    status: platformListings.status,
    price: platformListings.price,
  }).from(platformListings).where(eq(platformListings.platform, 'ebay'));

  const dbEbayMap = new Map<string, typeof dbEbayListings[0]>();
  for (const l of dbEbayListings) {
    if (l.platformItemId) dbEbayMap.set(l.platformItemId, l);
  }
  console.log(`  DB total: ${dbEbayListings.length}개 (active: ${dbEbayListings.filter(l => l.status === 'active').length})`);

  // 대조 (API가 유효한 경우만)
  const ebayApiValid = !(apiEbayItems.length === 0 && dbEbayActiveNum > 100);

  if (ebayApiValid) {
    const apiEbayIds = new Set(apiEbayItems.map(i => i.itemId));
    let ebayMatch = 0, ebayApiOnly = 0, ebayDbOnly = 0, ebayPriceDiff = 0;
    const ebayToEnd: number[] = [];      // DB에만 있음 → ended
    const ebayToActivate: number[] = []; // DB에 있지만 ended → active

    for (const item of apiEbayItems) {
      const dbEntry = dbEbayMap.get(item.itemId);
      if (dbEntry) {
        ebayMatch++;
        if (dbEntry.status === 'ended') {
          ebayToActivate.push(dbEntry.id);
        }
        // 가격 비교
        const apiPrice = parseFloat(item.price);
        const dbPrice = dbEntry.price ? parseFloat(dbEntry.price) : 0;
        if (Math.abs(apiPrice - dbPrice) > 0.01) ebayPriceDiff++;
      } else {
        ebayApiOnly++;
      }
    }

    for (const [itemId, dbEntry] of dbEbayMap) {
      if (!apiEbayIds.has(itemId) && dbEntry.status === 'active') {
        ebayDbOnly++;
        ebayToEnd.push(dbEntry.id);
      }
    }

    console.log(`\n  eBay 대조 결과:`);
    console.log(`    일치: ${ebayMatch}개`);
    console.log(`    API에만 있음 (DB 누락): ${ebayApiOnly}개`);
    console.log(`    DB active이지만 API에 없음 (ended 처리 대상): ${ebayDbOnly}개`);
    console.log(`    가격 차이: ${ebayPriceDiff}개`);
    console.log(`    ended→active 복원 대상: ${ebayToActivate.length}개`);

    // eBay 교정 적용
    if (ebayToEnd.length > 0) {
      for (let i = 0; i < ebayToEnd.length; i += 100) {
        const batch = ebayToEnd.slice(i, i + 100);
        await db.update(platformListings)
          .set({ status: 'ended', updatedAt: new Date() })
          .where(inArray(platformListings.id, batch));
      }
      console.log(`    → ${ebayToEnd.length}개 active→ended 교정`);
    }

    if (ebayToActivate.length > 0) {
      for (let i = 0; i < ebayToActivate.length; i += 100) {
        const batch = ebayToActivate.slice(i, i + 100);
        await db.update(platformListings)
          .set({ status: 'active', updatedAt: new Date() })
          .where(inArray(platformListings.id, batch));
      }
      console.log(`    → ${ebayToActivate.length}개 ended→active 복원`);
    }
  }

  // ============================================================
  // Shopify 비교대조
  // ============================================================
  console.log('\n--- Shopify API 비교대조 ---');
  const apiShopifyVariants = await shopify.getAllProducts();
  console.log(`  API variants: ${apiShopifyVariants.length}개`);

  // DB에서 Shopify 리스팅 조회
  const dbShopifyListings = await db.select({
    id: platformListings.id,
    productId: platformListings.productId,
    platformSku: platformListings.platformSku,
    platformItemId: platformListings.platformItemId,
    status: platformListings.status,
    price: platformListings.price,
  }).from(platformListings).where(eq(platformListings.platform, 'shopify'));

  const dbShopifyMap = new Map<string, typeof dbShopifyListings[0]>();
  for (const l of dbShopifyListings) {
    if (l.platformSku) dbShopifyMap.set(l.platformSku, l);
  }
  console.log(`  DB total: ${dbShopifyListings.length}개`);

  // 대조
  const apiShopifySkus = new Set(apiShopifyVariants.map(v => v.sku));
  let shopMatch = 0, shopApiOnly = 0, shopDbOnly = 0, shopPriceDiff = 0;
  const shopToEnd: number[] = [];

  for (const variant of apiShopifyVariants) {
    const dbEntry = dbShopifyMap.get(variant.sku);
    if (dbEntry) {
      shopMatch++;
      const apiPrice = parseFloat(variant.price);
      const dbPrice = dbEntry.price ? parseFloat(dbEntry.price) : 0;
      if (Math.abs(apiPrice - dbPrice) > 0.01) shopPriceDiff++;
    } else {
      shopApiOnly++;
    }
  }

  for (const [sku, dbEntry] of dbShopifyMap) {
    if (!apiShopifySkus.has(sku) && dbEntry.status === 'active') {
      shopDbOnly++;
      shopToEnd.push(dbEntry.id);
    }
  }

  console.log(`\n  Shopify 대조 결과:`);
  console.log(`    일치: ${shopMatch}개`);
  console.log(`    API에만 있음 (DB 누락): ${shopApiOnly}개`);
  console.log(`    DB active이지만 API에 없음 (ended 처리 대상): ${shopDbOnly}개`);
  console.log(`    가격 차이: ${shopPriceDiff}개`);

  // Shopify 교정 적용
  if (shopToEnd.length > 0) {
    for (let i = 0; i < shopToEnd.length; i += 100) {
      const batch = shopToEnd.slice(i, i + 100);
      await db.update(platformListings)
        .set({ status: 'ended', updatedAt: new Date() })
        .where(inArray(platformListings.id, batch));
    }
    console.log(`    → ${shopToEnd.length}개 active→ended 교정`);
  }

  // ============================================================
  // products.status 연쇄 교정
  // ============================================================
  console.log('\n--- products.status 연쇄 교정 ---');
  // active 리스팅이 하나도 없는 상품은 더 이상 active가 아님
  const deactivated = await db.execute(sql`
    UPDATE products SET status = 'ended', updated_at = NOW()
    WHERE status = 'active'
    AND id NOT IN (
      SELECT DISTINCT product_id FROM platform_listings WHERE status = 'active'
    )
  `);
  console.log(`  products active→ended: ${deactivated.rowCount}개`);

  // ============================================================
  // 최종 검증
  // ============================================================
  console.log('\n--- 최종 결과 ---');
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
    FROM products GROUP BY status ORDER BY status
  `);
  console.log('\n  상품 상태:');
  for (const row of productCounts.rows) {
    console.log(`    ${row.status}: ${row.cnt}`);
  }

  await pool.end();
  console.log('\n=== 비교대조 완료 ===');
}

verify().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
