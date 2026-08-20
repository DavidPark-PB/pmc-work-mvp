import 'dotenv/config';
import XLSX from 'xlsx';
import axios from 'axios';

const XLSX_PATH = 'C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============================================================
// Excel Parser
// ============================================================
function loadExcel() {
  console.log('--- 엑셀 로드 ---');
  const wb = XLSX.readFile(XLSX_PATH);

  function sheet(name: string): unknown[][] {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
  }

  // eBay: 최종 Dashboard에서 ItemID(col 13) 추출
  const dashRows = sheet('최종 Dashboard');
  const xlsxEbay = new Map<string, { title: string; price: string; legacySku: string; rowIdx: number }>();

  for (let i = 1; i < dashRows.length; i++) {
    const r = dashRows[i];
    const ebayItemId = String(r[13] || '').trim();
    const title = String(r[2] || '').trim();
    const price = String(r[9] || '').trim(); // eBay 판매가
    const legacySku = String(r[1] || '').trim();

    if (ebayItemId && /^\d{10,15}$/.test(ebayItemId)) {
      xlsxEbay.set(ebayItemId, { title, price, legacySku, rowIdx: i });
    }
  }

  console.log(`  엑셀 eBay ItemID: ${xlsxEbay.size}개`);

  // Shopify: Shopify 시트에서 SKU 추출
  const shopifySheetNames = wb.SheetNames.filter(n =>
    n.toLowerCase().includes('shopify')
  );
  console.log(`  Shopify 시트: ${shopifySheetNames.join(', ') || '없음'}`);

  const xlsxShopify = new Map<string, { title: string; price: string; rowIdx: number }>();

  for (const sheetName of shopifySheetNames) {
    const rows = sheet(sheetName);
    // 헤더에서 SKU, Title, Price 컬럼 찾기
    if (rows.length < 2) continue;
    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const skuCol = header.findIndex(h => h.includes('sku') || h.includes('handle'));
    const titleCol = header.findIndex(h => h.includes('title') || h.includes('상품명'));
    const priceCol = header.findIndex(h => h.includes('price') || h.includes('가격'));

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const sku = String(r[skuCol] || '').trim();
      const title = titleCol >= 0 ? String(r[titleCol] || '').trim() : '';
      const price = priceCol >= 0 ? String(r[priceCol] || '').trim() : '';

      if (sku) {
        xlsxShopify.set(sku, { title, price, rowIdx: i });
      }
    }
  }

  // Dashboard에서도 Shopify SKU 추출 (col 1 = legacySku가 Shopify SKU)
  const xlsxShopifyFromDash = new Map<string, { title: string; price: string; rowIdx: number }>();
  for (let i = 1; i < dashRows.length; i++) {
    const r = dashRows[i];
    const legacySku = String(r[1] || '').trim();
    const shopifyStatus = String(r[17] || '').trim();
    const title = String(r[2] || '').trim();
    const shopifyPrice = String(r[33] || '').trim();

    if (legacySku && shopifyStatus && !shopifyStatus.includes('미등록')) {
      xlsxShopifyFromDash.set(legacySku, { title, price: shopifyPrice, rowIdx: i });
    }
  }

  console.log(`  엑셀 Shopify SKU (시트): ${xlsxShopify.size}개`);
  console.log(`  엑셀 Shopify SKU (Dashboard): ${xlsxShopifyFromDash.size}개`);

  return { xlsxEbay, xlsxShopify, xlsxShopifyFromDash, dashRowCount: dashRows.length - 1 };
}

// ============================================================
// eBay API
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
// Shopify API
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
// Main Comparison
// ============================================================
async function compare() {
  console.log('=== 엑셀(1) vs API(3) 정합성 비교 ===\n');

  const { xlsxEbay, xlsxShopify, xlsxShopifyFromDash } = loadExcel();

  // --- eBay ---
  console.log('\n--- eBay 연결 ---');
  const ebay = new EbayClient();
  const ebayOk = await ebay.testConnection();
  if (!ebayOk) {
    console.error('eBay 연결 실패. 토큰 확인 필요.');
    return;
  }

  console.log('\n--- eBay API 로드 ---');
  const apiEbay = await ebay.getAllActiveListings();
  console.log(`  API active: ${apiEbay.size}개`);

  // 대조: 엑셀 eBay vs API eBay
  console.log('\n=== eBay: 엑셀 vs API ===');
  let ebayBothMatch = 0;    // 엑셀에도 있고 API에도 있음
  let ebayXlsxOnly = 0;     // 엑셀에만 있음 (API에 없음 = ended)
  let ebayApiOnly = 0;       // API에만 있음 (엑셀에 없음 = 신규 or 누락)
  let ebayPriceDiff = 0;

  const xlsxOnlyItems: string[] = [];
  const apiOnlyItems: { itemId: string; title: string; sku: string }[] = [];

  for (const [itemId, xlsxData] of xlsxEbay) {
    const apiData = apiEbay.get(itemId);
    if (apiData) {
      ebayBothMatch++;
      const xlsxPrice = parseFloat(xlsxData.price);
      const apiPrice = parseFloat(apiData.price);
      if (!isNaN(xlsxPrice) && !isNaN(apiPrice) && Math.abs(xlsxPrice - apiPrice) > 0.01) {
        ebayPriceDiff++;
      }
    } else {
      ebayXlsxOnly++;
      xlsxOnlyItems.push(itemId);
    }
  }

  for (const [itemId, apiData] of apiEbay) {
    if (!xlsxEbay.has(itemId)) {
      ebayApiOnly++;
      if (apiOnlyItems.length < 20) {
        apiOnlyItems.push({ itemId, title: apiData.title, sku: apiData.sku });
      }
    }
  }

  console.log(`  엑셀: ${xlsxEbay.size}개 / API: ${apiEbay.size}개`);
  console.log(`  양쪽 모두 있음: ${ebayBothMatch}개`);
  console.log(`  엑셀에만 있음 (API에 없음 = 이미 ended): ${ebayXlsxOnly}개`);
  console.log(`  API에만 있음 (엑셀에 없음 = 신규): ${ebayApiOnly}개`);
  console.log(`  가격 차이: ${ebayPriceDiff}개`);

  if (xlsxOnlyItems.length > 0 && xlsxOnlyItems.length <= 20) {
    console.log(`\n  엑셀에만 있는 ItemID (샘플):`);
    for (const id of xlsxOnlyItems.slice(0, 10)) {
      const d = xlsxEbay.get(id)!;
      console.log(`    ${id} - ${d.title?.substring(0, 50)}`);
    }
  }

  if (apiOnlyItems.length > 0) {
    console.log(`\n  API에만 있는 리스팅 (샘플 ${Math.min(10, apiOnlyItems.length)}개):`);
    for (const item of apiOnlyItems.slice(0, 10)) {
      console.log(`    ${item.itemId} - SKU: ${item.sku} - ${item.title?.substring(0, 50)}`);
    }
  }

  // --- Shopify ---
  console.log('\n--- Shopify API 로드 ---');
  const shopify = new ShopifyClient();
  const apiShopify = await shopify.getAllProducts();
  console.log(`  API active: ${apiShopify.size}개`);

  // Shopify는 Shopify 시트 기준으로 비교 (Dashboard는 대부분 '미등록'이라 쓸모없음)
  const xlsxShopifyAll = xlsxShopify.size > 0 ? xlsxShopify : xlsxShopifyFromDash;
  const xlsxSource = xlsxShopify.size > 0 ? 'Shopify시트' : 'Dashboard';

  console.log(`\n=== Shopify: 엑셀(${xlsxSource}) vs API ===`);
  let shopBothMatch = 0;
  let shopXlsxOnly = 0;
  let shopApiOnly = 0;
  let shopPriceDiff = 0;

  for (const [sku, xlsxData] of xlsxShopifyAll) {
    const apiData = apiShopify.get(sku);
    if (apiData) {
      shopBothMatch++;
      const xlsxPrice = parseFloat(xlsxData.price);
      const apiPrice = parseFloat(apiData.price);
      if (!isNaN(xlsxPrice) && !isNaN(apiPrice) && Math.abs(xlsxPrice - apiPrice) > 0.01) {
        shopPriceDiff++;
      }
    } else {
      shopXlsxOnly++;
    }
  }

  for (const [sku] of apiShopify) {
    if (!xlsxShopifyAll.has(sku)) {
      shopApiOnly++;
    }
  }

  console.log(`  엑셀: ${xlsxShopifyAll.size}개 / API: ${apiShopify.size}개`);
  console.log(`  양쪽 모두 있음: ${shopBothMatch}개`);
  console.log(`  엑셀에만 있음 (API에 없음): ${shopXlsxOnly}개`);
  console.log(`  API에만 있음 (엑셀에 없음): ${shopApiOnly}개`);
  console.log(`  가격 차이: ${shopPriceDiff}개`);

  // === 최종 판정 ===
  console.log('\n========================================');
  console.log('=== 최종 판정 ===');
  console.log('========================================');

  console.log(`\neBay:`);
  console.log(`  엑셀 ${xlsxEbay.size}개 중 ${ebayBothMatch}개가 API에도 존재 (${(ebayBothMatch / xlsxEbay.size * 100).toFixed(1)}%)`);
  console.log(`  API에만 있는 ${ebayApiOnly}개 = 엑셀 작성 이후 새로 등록된 리스팅`);
  console.log(`  엑셀에만 있는 ${ebayXlsxOnly}개 = eBay에서 종료/삭제된 리스팅`);

  console.log(`\nShopify:`);
  console.log(`  엑셀 ${xlsxShopifyAll.size}개 중 ${shopBothMatch}개가 API에도 존재 (${(shopBothMatch / (xlsxShopifyAll.size || 1) * 100).toFixed(1)}%)`);
  console.log(`  API에만 있는 ${shopApiOnly}개 = 엑셀 작성 이후 새로 등록된 상품`);
  console.log(`  엑셀에만 있는 ${shopXlsxOnly}개 = Shopify에서 삭제된 상품`);

  const totalApiItems = apiEbay.size + apiShopify.size;
  console.log(`\n결론: API 기준 총 ${totalApiItems}개 (eBay ${apiEbay.size} + Shopify ${apiShopify.size})`);
  console.log(`  → DB를 API(3) 기준으로 갱신하면 가장 정확함`);
}

compare().catch(e => { console.error(e); process.exit(1); });
