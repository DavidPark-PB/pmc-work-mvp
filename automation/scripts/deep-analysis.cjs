const XLSX = require('xlsx');
const wb = XLSX.readFile('C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx');

function toJson(sheetName, opts = {}) {
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, ...opts });
}

// ========================================
// 1. 최종 Dashboard 심층 분석
// ========================================
console.log('========================================');
console.log('1. 최종 Dashboard 심층 분석');
console.log('========================================');
const dash = toJson('최종 Dashboard');
const headers = dash[0];
console.log('컬럼 수:', headers.length);
console.log('데이터 행수:', dash.length - 1);

// SKU 분석
const skuMap = {};
const skuTypes = { ebayItemId: 0, korean: 0, shopifyFormat: 0, testData: 0, empty: 0, other: 0 };
for (let i = 1; i < dash.length; i++) {
  const sku = String(dash[i][1] || '').trim();
  if (!sku) { skuTypes.empty++; continue; }
  if (sku.startsWith('TEST')) { skuTypes.testData++; continue; }
  if (/^\d{12,15}$/.test(sku)) skuTypes.ebayItemId++;
  else if (/^SHOPIFY-/.test(sku)) skuTypes.shopifyFormat++;
  else if (/[\uac00-\ud7a3]/.test(sku)) skuTypes.korean++;
  else skuTypes.other++;

  if (!skuMap[sku]) skuMap[sku] = [];
  skuMap[sku].push(i);
}
console.log('\nSKU 유형 분포:', JSON.stringify(skuTypes, null, 2));

// 중복 SKU 확인
const dupes = Object.entries(skuMap).filter(([k, v]) => v.length > 1);
console.log('중복 SKU:', dupes.length);
if (dupes.length > 0) {
  dupes.slice(0, 5).forEach(([sku, rows]) => {
    console.log('  SKU=' + sku + ' rows=' + rows.join(','));
  });
}

// eBay 등록 상태 분포
const ebayStatus = {};
const shopifyStatus = {};
for (let i = 1; i < dash.length; i++) {
  const es = String(dash[i][16] || '').trim();
  const ss = String(dash[i][17] || '').trim();
  ebayStatus[es] = (ebayStatus[es] || 0) + 1;
  shopifyStatus[ss] = (shopifyStatus[ss] || 0) + 1;
}
console.log('\neBay 등록 상태:', JSON.stringify(ebayStatus));
console.log('Shopify 등록 상태:', JSON.stringify(shopifyStatus));

// 데이터 품질: 비어있거나 오류값
let nullWeight = 0, nullCost = 0, invalidCost = 0, nullPrice = 0, formulaError = 0;
for (let i = 1; i < dash.length; i++) {
  const weight = dash[i][3];
  const cost = dash[i][4];
  const price = dash[i][9];
  const totalCost = dash[i][8];

  if (weight === null || weight === undefined || weight === '') nullWeight++;
  if (cost === null || cost === undefined || cost === '') nullCost++;
  if (typeof cost === 'string' && (cost.includes('품절') || cost.includes('#'))) invalidCost++;
  if (price === null || price === undefined || price === '') nullPrice++;
  if (typeof totalCost === 'string' && totalCost.includes('#VALUE')) formulaError++;
}
console.log('\n데이터 품질:');
console.log('  무게 없음:', nullWeight);
console.log('  매입가 없음:', nullCost);
console.log('  매입가 오류(품절 등):', invalidCost);
console.log('  eBay 가격 없음:', nullPrice);
console.log('  수식 오류(#VALUE!):', formulaError);

// 플랫폼(소싱처) 분포
const platforms = {};
for (let i = 1; i < dash.length; i++) {
  const p = String(dash[i][18] || '').trim();
  if (p) platforms[p] = (platforms[p] || 0) + 1;
}
const sortedPlatforms = Object.entries(platforms).sort((a, b) => b[1] - a[1]);
console.log('\n소싱처 분포 (Top 20):');
sortedPlatforms.slice(0, 20).forEach(([p, c]) => console.log('  ' + p + ': ' + c));

// 정렬순위 분포
const sortOrders = {};
for (let i = 1; i < dash.length; i++) {
  const s = String(dash[i][20] || '');
  sortOrders[s] = (sortOrders[s] || 0) + 1;
}
console.log('\n정렬순위 분포:', JSON.stringify(sortOrders));

// ========================================
// 2. eBay Products 심층 분석
// ========================================
console.log('\n========================================');
console.log('2. eBay Products 심층 분석');
console.log('========================================');
const ebay = toJson('eBay Products');
console.log('컬럼:', ebay[0].join(' | '));
console.log('데이터 행수:', ebay.length - 1);

// SKU 분석
const ebaySKUvals = {};
for (let i = 1; i < ebay.length; i++) {
  const sku = String(ebay[i][0] || '').trim();
  ebaySKUvals[sku] = (ebaySKUvals[sku] || 0) + 1;
}
console.log('eBay SKU 값 분포 (Top 10):');
Object.entries(ebaySKUvals).sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([s, c]) => console.log('  "' + s + '": ' + c));

// Status 분포
const ebayStatuses = {};
for (let i = 1; i < ebay.length; i++) {
  const s = String(ebay[i][9] || '');
  ebayStatuses[s] = (ebayStatuses[s] || 0) + 1;
}
console.log('eBay Status 분포:', JSON.stringify(ebayStatuses));

// Type 분포
const ebayTypes = {};
for (let i = 1; i < ebay.length; i++) {
  const t = String(ebay[i][8] || '');
  ebayTypes[t] = (ebayTypes[t] || 0) + 1;
}
console.log('eBay Type 분포:', JSON.stringify(ebayTypes));

// Dashboard Item ID와 매칭 상세
const dashItemIDs = new Set();
for (let i = 1; i < dash.length; i++) {
  const id = String(dash[i][13] || '').trim();
  if (id) dashItemIDs.add(id);
}
const ebayItemIDs = new Set();
for (let i = 1; i < ebay.length; i++) {
  ebayItemIDs.add(String(ebay[i][2] || ''));
}
let ebayOnlyInEbay = 0, ebayInBoth = 0;
for (const id of ebayItemIDs) {
  if (dashItemIDs.has(id)) ebayInBoth++;
  else ebayOnlyInEbay++;
}
console.log('eBay ItemID in Dashboard:', ebayInBoth);
console.log('eBay ItemID only in eBay sheet:', ebayOnlyInEbay);

// ========================================
// 3. Shopify 심층 분석
// ========================================
console.log('\n========================================');
console.log('3. Shopify 심층 분석');
console.log('========================================');
const shop = toJson('Shopify');
console.log('컬럼:', shop[0].join(' | '));
console.log('데이터 행수:', shop.length - 1);

// SKU 패턴
const shopSKUTypes = { ebayId: 0, pmc: 0, shopify: 0, korean: 0, other: 0 };
for (let i = 1; i < shop.length; i++) {
  const sku = String(shop[i][0] || '').trim();
  if (/^\d{12,15}$/.test(sku)) shopSKUTypes.ebayId++;
  else if (/^PMC-/.test(sku)) shopSKUTypes.pmc++;
  else if (/^SHOPIFY-/.test(sku)) shopSKUTypes.shopify++;
  else if (/[\uac00-\ud7a3]/.test(sku)) shopSKUTypes.korean++;
  else shopSKUTypes.other++;
}
console.log('Shopify SKU 유형:', JSON.stringify(shopSKUTypes));

// 검수 상태 분포
const inspStatus = {};
for (let i = 1; i < shop.length; i++) {
  const s = String(shop[i][9] || '').trim();
  inspStatus[s] = (inspStatus[s] || 0) + 1;
}
console.log('검수 상태:', JSON.stringify(inspStatus));

// ========================================
// 4. Shipping Rates 심층 분석
// ========================================
console.log('\n========================================');
console.log('4. Shipping Rates 심층 분석');
console.log('========================================');
const ship = toJson('Shipping Rates');
console.log('컬럼:', ship[0].join(' | '));
console.log('행수:', ship.length - 1);

const carriers = {};
const countries = {};
for (let i = 1; i < ship.length; i++) {
  const c = String(ship[i][0] || '');
  const co = String(ship[i][1] || '');
  carriers[c] = (carriers[c] || 0) + 1;
  countries[co] = (countries[co] || 0) + 1;
}
console.log('Carrier 분포:', JSON.stringify(carriers));
console.log('Country 분포:', JSON.stringify(countries));

// Weight range
let minW = Infinity, maxW = 0;
for (let i = 1; i < ship.length; i++) {
  const w = Number(ship[i][2]) || 0;
  if (w < minW) minW = w;
  if (w > maxW) maxW = w;
}
console.log('Weight range:', minW + 'g ~', maxW + 'g');

// Sample rates
console.log('Sample rates:');
for (let i = 1; i < Math.min(ship.length, 6); i++) {
  console.log('  ' + ship[i].join(' | '));
}

// ========================================
// 5. Naver Products 심층 분석
// ========================================
console.log('\n========================================');
console.log('5. Naver Products 심층 분석');
console.log('========================================');
const naver = toJson('Naver Products');
console.log('컬럼:', naver[0].join(' | '));
console.log('행수:', naver.length - 1);

const naverStatuses = {};
for (let i = 1; i < naver.length; i++) {
  const s = String(naver[i][4] || '');
  naverStatuses[s] = (naverStatuses[s] || 0) + 1;
}
console.log('Naver 상태:', JSON.stringify(naverStatuses));

// Dashboard 상품과 겹치는지 - 상품명 기반 확인
const dashTitles = new Set();
for (let i = 1; i < dash.length; i++) {
  const t = String(dash[i][2] || '').trim().toLowerCase();
  if (t) dashTitles.add(t);
}
let naverMatchTitle = 0;
for (let i = 1; i < Math.min(naver.length, 500); i++) {
  const t = String(naver[i][1] || '').trim().toLowerCase();
  if (dashTitles.has(t)) naverMatchTitle++;
}
console.log('Naver 상품명 Dashboard 매칭 (처음 500개 중):', naverMatchTitle);

// ========================================
// 6. Alibaba Products 심층 분석
// ========================================
console.log('\n========================================');
console.log('6. Alibaba Products 심층 분석');
console.log('========================================');
const ali = toJson('Alibaba Products');
console.log('컬럼:', ali[0].join(' | '));
console.log('행수:', ali.length - 1);

const aliStatuses = {};
for (let i = 1; i < ali.length; i++) {
  const s = String(ali[i][3] || '');
  aliStatuses[s] = (aliStatuses[s] || 0) + 1;
}
console.log('Alibaba 상태:', JSON.stringify(aliStatuses));

// ========================================
// 7. 주문 배송 심층 분석
// ========================================
console.log('\n========================================');
console.log('7. 주문 배송 심층 분석');
console.log('========================================');
const orders = toJson('주문 배송');
console.log('컬럼:', orders[0].join(' | '));
console.log('행수:', orders.length - 1);

const orderPlatforms = {};
const orderStatuses = {};
const orderCountries = {};
for (let i = 1; i < orders.length; i++) {
  const p = String(orders[i][1] || '');
  const s = String(orders[i][12] || '');
  const c = String(orders[i][18] || '');
  orderPlatforms[p] = (orderPlatforms[p] || 0) + 1;
  orderStatuses[s] = (orderStatuses[s] || 0) + 1;
  if (c) orderCountries[c] = (orderCountries[c] || 0) + 1;
}
console.log('주문 플랫폼:', JSON.stringify(orderPlatforms));
console.log('주문 상태:', JSON.stringify(orderStatuses));
console.log('주문 국가:', JSON.stringify(orderCountries));

// ========================================
// 8. B2B 심층 분석
// ========================================
console.log('\n========================================');
console.log('8. B2B Buyers + Invoices');
console.log('========================================');
const buyers = toJson('B2B Buyers');
console.log('Buyers 행수:', buyers.length - 1);
console.log('Sample buyer:', JSON.stringify(buyers[1]));

const invoices = toJson('B2B Invoices');
console.log('Invoices 행수:', invoices.length - 1);
const invStatuses = {};
for (let i = 1; i < invoices.length; i++) {
  const s = String(invoices[i][11] || '');
  invStatuses[s] = (invStatuses[s] || 0) + 1;
}
console.log('Invoice 상태:', JSON.stringify(invStatuses));

// ========================================
// 9. Shipping Calculator
// ========================================
console.log('\n========================================');
console.log('9. Shipping Calculator');
console.log('========================================');
const calc = toJson('Shipping Calculator');
for (let i = 0; i < calc.length; i++) {
  console.log('Row ' + i + ':', JSON.stringify(calc[i]));
}
