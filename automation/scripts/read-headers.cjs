const XLSX = require('xlsx');
const wb = XLSX.readFile('C:/Users/inwon/Downloads/CCOREA_ItemData.xlsx');
const sheets = [
  'Shopify', 'eBay Products', 'Shipping Rates', 'Shipping Calculator',
  'Sync_Log', '최종 Dashboard', 'HK ㅊㅈ', 'HK ',
  'Alibaba Products', 'Naver Products', '주문 배송', 'B2B Buyers', 'B2B Invoices'
];
sheets.forEach(name => {
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) return;
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 });
  console.log('\n=== ' + name + ' ===');
  console.log('Headers:', JSON.stringify(data[0]));
  if (data[1]) console.log('Row 1:', JSON.stringify(data[1]));
});
