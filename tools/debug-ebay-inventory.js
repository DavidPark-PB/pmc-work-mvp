require('dotenv').config();
const axios = require('axios');

async function debugInventoryAPI() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const devId = process.env.EBAY_DEV_ID;
  const userToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/ws/api.dll';

  console.log('=== eBay GetSellerList API 테스트 ===\n');

  const headers = {
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1355',
    'X-EBAY-API-DEV-NAME': devId,
    'X-EBAY-API-APP-NAME': appId,
    'X-EBAY-API-CERT-NAME': certId,
    'X-EBAY-API-CALL-NAME': 'GetSellerList',
    'X-EBAY-API-SITEID': '0',
    'X-EBAY-API-IAF-TOKEN': userToken,
    'Content-Type': 'text/xml'
  };

  // GetSellerList: 모든 판매자 리스팅 조회
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>200</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
  <EndTimeFrom>2020-01-01T00:00:00.000Z</EndTimeFrom>
  <EndTimeTo>2030-12-31T23:59:59.000Z</EndTimeTo>
  <GranularityLevel>Fine</GranularityLevel>
</GetSellerListRequest>`;

  try {
    console.log('📡 GetSellerList API 호출 중...\n');
    const response = await axios.post(apiUrl, xml, { headers });

    // 응답 일부 출력
    console.log('📄 응답 샘플 (처음 3000자):\n');
    console.log(response.data.substring(0, 3000));
    console.log('\n' + '='.repeat(80) + '\n');

    // Ack 상태
    const ackMatch = response.data.match(/<Ack>(.*?)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : 'Unknown';
    console.log(`✅ API 응답 상태: ${ack}\n`);

    // 총 개수
    const totalMatch = response.data.match(/<ReturnedItemCountActual>(\d+)<\/ReturnedItemCountActual>/);
    const returnedCount = totalMatch ? totalMatch[1] : '0';

    const totalPagesMatch = response.data.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
    const totalPages = totalPagesMatch ? totalPagesMatch[1] : '0';

    const totalEntriesMatch = response.data.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
    const totalEntries = totalEntriesMatch ? totalEntriesMatch[1] : '0';

    console.log(`📦 이번 페이지 상품: ${returnedCount}개`);
    console.log(`📄 총 페이지: ${totalPages}페이지`);
    console.log(`🎯 총 상품 수: ${totalEntries}개\n`);

    // 샘플 상품 출력
    const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
    let match;
    let count = 0;

    console.log('📋 샘플 상품:\n');
    while ((match = itemRegex.exec(response.data)) !== null && count < 5) {
      const itemXml = match[1];
      const titleMatch = itemXml.match(/<Title>(.*?)<\/Title>/);
      const skuMatch = itemXml.match(/<SKU>(.*?)<\/SKU>/);
      const priceMatch = itemXml.match(/<CurrentPrice[^>]*>(.*?)<\/CurrentPrice>/);
      const itemIdMatch = itemXml.match(/<ItemID>(.*?)<\/ItemID>/);

      const title = titleMatch ? titleMatch[1] : 'No Title';
      const sku = skuMatch ? skuMatch[1] : 'No SKU';
      const price = priceMatch ? priceMatch[1] : '0';
      const itemId = itemIdMatch ? itemIdMatch[1] : 'No ID';

      console.log(`   ${count + 1}. [${sku}] ${title.substring(0, 60)}`);
      console.log(`      가격: $${price} | Item ID: ${itemId}\n`);
      count++;
    }

    // 에러 확인
    const errorMatch = response.data.match(/<Errors>([\s\S]*?)<\/Errors>/);
    if (errorMatch) {
      console.log('⚠️  에러 발견:');
      console.log(errorMatch[0]);
    }

  } catch (error) {
    console.error('❌ API 호출 실패:', error.message);
    if (error.response) {
      console.log('\n응답 데이터:');
      console.log(error.response.data);
    }
  }
}

debugInventoryAPI();
