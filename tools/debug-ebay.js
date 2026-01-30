require('dotenv').config();
const axios = require('axios');

async function debugEbayAPI() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const devId = process.env.EBAY_DEV_ID;
  const userToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/ws/api.dll';

  console.log('=== eBay API 디버그 모드 ===\n');

  // 1. GetUser 테스트
  console.log('1️⃣  GetUser API 호출...\n');

  const getUserXml = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${userToken}</eBayAuthToken>
  </RequesterCredentials>
</GetUserRequest>`;

  const headers = {
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1355',
    'X-EBAY-API-DEV-NAME': devId,
    'X-EBAY-API-APP-NAME': appId,
    'X-EBAY-API-CERT-NAME': certId,
    'X-EBAY-API-CALL-NAME': 'GetUser',
    'X-EBAY-API-SITEID': '0',
    'Content-Type': 'text/xml'
  };

  try {
    const response = await axios.post(apiUrl, getUserXml, { headers });
    console.log('📄 GetUser 전체 응답:\n');
    console.log(response.data.substring(0, 2000)); // 처음 2000자만 출력
    console.log('\n' + '='.repeat(80) + '\n');

    // UserID 추출
    const userIdMatch = response.data.match(/<UserID>(.*?)<\/UserID>/);
    const userId = userIdMatch ? userIdMatch[1] : 'Not Found';
    console.log(`✅ UserID: ${userId}\n`);

    // 2. GetMyeBaySelling 테스트
    console.log('2️⃣  GetMyeBaySelling API 호출...\n');

    const getSellingXml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${userToken}</eBayAuthToken>
  </RequesterCredentials>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>10</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    headers['X-EBAY-API-CALL-NAME'] = 'GetMyeBaySelling';

    const response2 = await axios.post(apiUrl, getSellingXml, { headers });
    console.log('📄 GetMyeBaySelling 전체 응답:\n');
    console.log(response2.data.substring(0, 3000)); // 처음 3000자 출력
    console.log('\n' + '='.repeat(80) + '\n');

    // 상품 개수 확인
    const totalMatch = response2.data.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
    const total = totalMatch ? totalMatch[1] : '0';
    console.log(`✅ 총 활성 리스팅: ${total}개\n`);

    // Ack 상태 확인
    const ackMatch = response2.data.match(/<Ack>(.*?)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : 'Unknown';
    console.log(`✅ API 응답 상태: ${ack}\n`);

    // 에러 확인
    const errorMatch = response2.data.match(/<Errors>(.*?)<\/Errors>/s);
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

debugEbayAPI();
