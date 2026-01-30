require('dotenv').config();
const axios = require('axios');

async function debugAllListings() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const devId = process.env.EBAY_DEV_ID;
  const userToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/ws/api.dll';

  console.log('=== eBay 전체 리스팅 조회 ===\n');

  const headers = {
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1355',
    'X-EBAY-API-DEV-NAME': devId,
    'X-EBAY-API-APP-NAME': appId,
    'X-EBAY-API-CERT-NAME': certId,
    'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-IAF-TOKEN': userToken,
    'Content-Type': 'text/xml'
  };

  const lists = [
    { name: 'ActiveList', label: '활성 리스팅' },
    { name: 'ScheduledList', label: '예약 리스팅' },
    { name: 'UnsoldList', label: '판매종료 리스팅' },
    { name: 'SoldList', label: '판매완료 리스팅' }
  ];

  for (const list of lists) {
    try {
      console.log(`\n📦 ${list.label} 조회 중...\n`);

      const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${list.name}>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>10</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </${list.name}>
</GetMyeBaySellingRequest>`;

      const response = await axios.post(apiUrl, xml, { headers });

      // 총 개수 추출
      const totalMatch = response.data.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
      const total = totalMatch ? totalMatch[1] : '0';

      console.log(`✅ ${list.label}: ${total}개`);

      // 샘플 아이템 출력
      const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
      let match;
      let count = 0;

      while ((match = itemRegex.exec(response.data)) !== null && count < 3) {
        const itemXml = match[1];
        const titleMatch = itemXml.match(/<Title>(.*?)<\/Title>/);
        const skuMatch = itemXml.match(/<SKU>(.*?)<\/SKU>/);
        const title = titleMatch ? titleMatch[1] : 'No Title';
        const sku = skuMatch ? skuMatch[1] : 'No SKU';

        console.log(`   - ${sku}: ${title.substring(0, 50)}...`);
        count++;
      }

    } catch (error) {
      console.error(`❌ ${list.label} 조회 실패:`, error.message);
    }
  }

  console.log('\n='.repeat(80));
}

debugAllListings();
