require('dotenv').config();
const eBayAPI = require('./ebayAPI');

/**
 * GetSellerList API 직접 테스트
 * 모든 활성 상품 가져오기
 */

async function testGetSellerList() {
  const ebay = new eBayAPI({
    devId: process.env.EBAY_DEV_ID,
    appId: process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    userToken: process.env.EBAY_USER_TOKEN,
    environment: process.env.EBAY_ENVIRONMENT
  });

  console.log('=== GetSellerList API 테스트 ===\n');

  // 최근 120일간의 모든 리스팅 조회
  const endTime = new Date();
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - 120); // 120일 전

  const requestBody = `
    <StartTimeFrom>${startTime.toISOString()}</StartTimeFrom>
    <StartTimeTo>${endTime.toISOString()}</StartTimeTo>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
    <GranularityLevel>Fine</GranularityLevel>
    <IncludeVariations>true</IncludeVariations>
  `;

  try {
    console.log('📅 조회 기간:', startTime.toISOString().split('T')[0], '~', endTime.toISOString().split('T')[0]);
    console.log('📦 요청 중...\n');

    const response = await ebay.callTradingAPI('GetSellerList', requestBody);

    console.log('✅ API 호출 성공!\n');
    console.log('전체 응답 (처음 3000자):\n');
    console.log(response.substring(0, 3000));
    console.log('\n' + '='.repeat(80) + '\n');

    // ItemArray 찾기
    const itemArrayMatch = response.match(/<ItemArray>([\s\S]*?)<\/ItemArray>/);
    if (itemArrayMatch) {
      const items = response.match(/<Item>/g);
      const itemCount = items ? items.length : 0;

      console.log(`📦 총 상품: ${itemCount}개\n`);

      if (itemCount > 0) {
        console.log('샘플 상품 정보 추출 중...\n');

        // 첫 번째 상품의 SKU와 Title 추출
        const firstItemMatch = response.match(/<Item>([\s\S]*?)<\/Item>/);
        if (firstItemMatch) {
          const itemData = firstItemMatch[1];
          const sku = itemData.match(/<SKU>(.*?)<\/SKU>/)?.[1] || 'N/A';
          const title = itemData.match(/<Title>(.*?)<\/Title>/)?.[1] || 'N/A';
          const itemID = itemData.match(/<ItemID>(.*?)<\/ItemID>/)?.[1] || 'N/A';

          console.log('첫 번째 상품:');
          console.log('  Item ID:', itemID);
          console.log('  SKU:', sku);
          console.log('  Title:', title);
        }
      }
    } else {
      console.log('❌ ItemArray를 찾을 수 없습니다.');

      // 에러 확인
      const errorMatch = response.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      if (errorMatch) {
        console.log('⚠️  에러:', errorMatch[1]);
      }
    }

  } catch (error) {
    console.error('❌ API 호출 실패:', error.message);
    if (error.response) {
      console.log('\n응답 데이터:', error.response.data.substring(0, 2000));
    }
  }
}

testGetSellerList();
