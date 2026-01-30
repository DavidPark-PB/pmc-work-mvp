require('dotenv').config();
const axios = require('axios');

/**
 * OAuth redirect_uri 포맷 테스트
 * eBay OAuth는 redirect_uri가 정확히 일치해야 함
 */

async function testTokenExchange(authorizationCode, redirectUri, description) {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const tokenUrl = 'https://api.ebay.com/identity/v1/oauth2/token';

  const data = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: redirectUri
  });

  console.log(`\n테스트 ${description}`);
  console.log('redirect_uri:', redirectUri);

  try {
    const response = await axios.post(tokenUrl, data, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    });

    console.log('✅ 성공!');
    console.log('Access Token:', response.data.access_token.substring(0, 50) + '...');
    console.log('Refresh Token:', response.data.refresh_token);
    return response.data;

  } catch (error) {
    console.log('❌ 실패:', error.response?.data?.error_description || error.message);
    return null;
  }
}

async function testAllFormats(authCode) {
  console.log('=== OAuth redirect_uri 포맷 테스트 ===\n');
  console.log('Authorization Code:', authCode.substring(0, 60) + '...\n');

  // eBay RuName의 여러 가능한 포맷 테스트
  const formats = [
    {
      uri: 'PMC_Corporation-PMCCorpo-Produc-kqprbe',
      desc: '1: RuName 그대로'
    },
    {
      uri: 'PMC Corporation-PMCCorpo-Produc-kqprbe',
      desc: '2: RuName (언더스코어 제거)'
    },
    {
      uri: 'https://www.ccorea.com',
      desc: '3: 실제 웹사이트 URL'
    },
    {
      uri: 'http://www.ccorea.com',
      desc: '4: HTTP 웹사이트 URL'
    }
  ];

  for (const format of formats) {
    const result = await testAllFormats(authCode, format.uri, format.desc);
    if (result) {
      console.log('\n\n🎉 성공한 포맷을 찾았습니다!');
      console.log('redirect_uri:', format.uri);
      return result;
    }
    // 다음 테스트 전 잠시 대기
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n\n❌ 모든 포맷이 실패했습니다.');
  console.log('\n💡 해결 방법:');
  console.log('1. eBay Developer Portal에서 RuName 설정을 확인하세요');
  console.log('2. OAuth consent URL 생성 시 사용한 redirect_uri를 확인하세요');
  console.log('3. Authorization code는 5분 후 만료되므로 새로 발급받아야 합니다');

  return null;
}

// 실행
const authCode = process.argv[2];

if (!authCode) {
  console.error('❌ Authorization Code를 제공해야 합니다.');
  console.log('\n사용법: node test-oauth-formats.js <AUTHORIZATION_CODE>');
  process.exit(1);
}

testAllFormats(authCode);
