require('dotenv').config();
const axios = require('axios');

async function testGetUser() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const devId = process.env.EBAY_DEV_ID;
  const userToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/ws/api.dll';

  console.log('=== GetUser API 디버그 테스트 ===\n');
  console.log('📋 Credentials:');
  console.log(`  App ID: ${appId}`);
  console.log(`  Dev ID: ${devId}`);
  console.log(`  Cert ID: ${certId}`);
  console.log(`  Token 길이: ${userToken.length} characters`);
  console.log(`  Token: ${userToken}\n`);

  const headers = {
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1271',
    'X-EBAY-API-DEV-NAME': devId,
    'X-EBAY-API-APP-NAME': appId,
    'X-EBAY-API-CERT-NAME': certId,
    'X-EBAY-API-CALL-NAME': 'GetUser',
    'X-EBAY-API-SITEID': '0',
    'Content-Type': 'text/xml'
  };

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${userToken}</eBayAuthToken>
  </RequesterCredentials>
</GetUserRequest>`;

  console.log('📤 요청 헤더:');
  console.log(JSON.stringify(headers, null, 2));
  console.log('\n📤 요청 XML:');
  console.log(xml);
  console.log('\n' + '='.repeat(80) + '\n');

  try {
    console.log('📡 API 호출 중: POST ' + apiUrl + '\n');
    const response = await axios.post(apiUrl, xml, { headers });

    console.log('📥 응답 상태: 200 OK\n');
    console.log('📥 응답 XML:');
    console.log('='.repeat(80));
    console.log(response.data);
    console.log('='.repeat(80));

    // Ack 확인
    const ackMatch = response.data.match(/<Ack>(.*?)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : 'Unknown';

    if (ack === 'Success') {
      const userIdMatch = response.data.match(/<UserID>(.*?)<\/UserID>/);
      const userId = userIdMatch ? userIdMatch[1] : 'Unknown';
      console.log(`\n✅ 성공! UserID: ${userId}`);
      console.log(`\n이 토큰은 "${userId}" 계정의 것입니다.`);
      console.log(`Active Listing을 가진 계정이 맞는지 확인해주세요!\n`);
    } else {
      console.log(`\n❌ 실패: ${ack}`);
      const errorMatch = response.data.match(/<LongMessage>(.*?)<\/LongMessage>/);
      const errorCodeMatch = response.data.match(/<ErrorCode>(.*?)<\/ErrorCode>/);
      if (errorMatch) {
        console.log(`   에러 메시지: ${errorMatch[1]}`);
      }
      if (errorCodeMatch) {
        console.log(`   에러 코드: ${errorCodeMatch[1]}`);
      }
    }

  } catch (error) {
    console.error('\n❌ HTTP 호출 실패:', error.message);
    if (error.response) {
      console.log('\n응답 상태:', error.response.status);
      console.log('응답 데이터:');
      console.log(error.response.data);
    }
  }
}

testGetUser();
