const XLSX = require('xlsx');
const wb = XLSX.readFile('C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx');

// 1. 최종 Dashboard - SKU 샘플 (eBay Item ID가 SKU로 쓰이는지 확인)
console.log('=== 최종 Dashboard: SKU vs eBay Item ID ===');
const dash = XLSX.utils.sheet_to_json(wb.Sheets['최종 Dashboard'], { header: 1 });
console.log('Headers:', dash[0].join(' | '));
console.log('Total rows:', dash.length - 1);
// SKU(col1) vs eBay Item ID(col13) 비교
let sameCount = 0, diffCount = 0, noItemId = 0;
const dashSKUs = new Set();
for (let i = 1; i < Math.min(dash.length, 200); i++) {
  const sku = String(dash[i][1] || '');
  const itemId = String(dash[i][13] || '');
  dashSKUs.add(sku);
  if (!itemId || itemId === 'undefined') noItemId++;
  else if (sku === itemId) sameCount++;
  else diffCount++;
}
console.log('SKU === eBay Item ID:', sameCount, '| Different:', diffCount, '| No Item ID:', noItemId);
// 다른 경우 예시
for (let i = 1; i < dash.length && diffCount > 0; i++) {
  const sku = String(dash[i][1] || '');
  const itemId = String(dash[i][13] || '');
  if (itemId && itemId !== 'undefined' && sku !== itemId) {
    console.log('  Example diff: SKU=' + sku + ' ItemID=' + itemId);
    break;
  }
}

// 2. eBay Products - SKU/ItemID 확인
console.log('\n=== eBay Products ===');
const ebay = XLSX.utils.sheet_to_json(wb.Sheets['eBay Products'], { header: 1 });
console.log('Headers:', ebay[0].join(' | '));
const ebaySKUs = new Set();
const ebayItemIDs = new Set();
for (let i = 1; i < ebay.length; i++) {
  ebaySKUs.add(String(ebay[i][0] || ''));
  ebayItemIDs.add(String(ebay[i][2] || ''));
}
console.log('Unique SKUs:', ebaySKUs.size, '| Unique Item IDs:', ebayItemIDs.size);

// 3. Shopify - SKU 확인
console.log('\n=== Shopify ===');
const shop = XLSX.utils.sheet_to_json(wb.Sheets['Shopify'], { header: 1 });
console.log('Headers:', shop[0].join(' | '));
const shopSKUs = new Set();
for (let i = 1; i < shop.length; i++) {
  shopSKUs.add(String(shop[i][0] || ''));
}
console.log('Unique SKUs:', shopSKUs.size);

// 4. 교차 확인: Dashboard SKU가 eBay/Shopify에 있는지
console.log('\n=== Cross References ===');
// Dashboard의 전체 SKU
const allDashSKUs = new Set();
for (let i = 1; i < dash.length; i++) {
  allDashSKUs.add(String(dash[i][1] || ''));
}
let dashInEbay = 0, dashInShopify = 0;
for (const sku of allDashSKUs) {
  if (ebaySKUs.has(sku) || ebayItemIDs.has(sku)) dashInEbay++;
  if (shopSKUs.has(sku)) dashInShopify++;
}
console.log('Dashboard SKUs total:', allDashSKUs.size);
console.log('Dashboard SKU in eBay (SKU or ItemID):', dashInEbay);
console.log('Dashboard SKU in Shopify:', dashInShopify);

// eBay SKU가 Dashboard에 있는지
let ebayInDash = 0;
for (const sku of ebaySKUs) {
  if (allDashSKUs.has(sku)) ebayInDash++;
}
console.log('eBay SKU in Dashboard:', ebayInDash + '/' + ebaySKUs.size);

// Shopify SKU가 Dashboard에 있는지
let shopInDash = 0;
for (const sku of shopSKUs) {
  if (allDashSKUs.has(sku)) shopInDash++;
}
console.log('Shopify SKU in Dashboard:', shopInDash + '/' + shopSKUs.size);

// 5. 주문배송 - SKU 교차
console.log('\n=== 주문 배송 ===');
const orders = XLSX.utils.sheet_to_json(wb.Sheets['주문 배송'], { header: 1 });
console.log('Headers:', orders[0].join(' | '));
console.log('Sample row:', JSON.stringify(orders[1]));
const orderSKUs = new Set();
for (let i = 1; i < orders.length; i++) {
  orderSKUs.add(String(orders[i][3] || ''));
}
let orderInDash = 0;
for (const sku of orderSKUs) {
  if (allDashSKUs.has(sku)) orderInDash++;
}
console.log('Order SKUs in Dashboard:', orderInDash + '/' + orderSKUs.size);

// 6. HK 시트 - 어떤 키로 연결되는지
console.log('\n=== HK ㅊㅈ ===');
const hk1 = XLSX.utils.sheet_to_json(wb.Sheets['HK ㅊㅈ'], { header: 1 });
console.log('Row 0 (meta?):', JSON.stringify(hk1[0]));
console.log('Row 1 (headers?):', JSON.stringify(hk1[1]));
if (hk1[2]) console.log('Row 2 (data):', JSON.stringify(hk1[2]));

console.log('\n=== HK  ===');
const hk2 = XLSX.utils.sheet_to_json(wb.Sheets['HK '], { header: 1 });
console.log('Row 0:', JSON.stringify(hk2[0]));
console.log('Row 1:', JSON.stringify(hk2[1]));
if (hk2[2]) console.log('Row 2:', JSON.stringify(hk2[2]));

// 7. Naver Products - 키 확인
console.log('\n=== Naver Products ===');
const naver = XLSX.utils.sheet_to_json(wb.Sheets['Naver Products'], { header: 1 });
console.log('Sample rows:');
console.log('Row 1:', JSON.stringify(naver[1]));
console.log('Row 2:', JSON.stringify(naver[2]));

// 8. Alibaba Products - 키 확인
console.log('\n=== Alibaba Products ===');
const ali = XLSX.utils.sheet_to_json(wb.Sheets['Alibaba Products'], { header: 1 });
console.log('Sample:', JSON.stringify(ali[1]));
console.log('Sample:', JSON.stringify(ali[2]));
