require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const crypto = require('crypto');
const axios = require('axios');
const readline = require('readline');

const APP_KEY = process.env.ALIBABA_APP_KEY;
const APP_SECRET = process.env.ALIBABA_APP_SECRET;
const REDIRECT_URL = 'https://example.com/callback';

// IOP 서명 생성 (HMAC-SHA256, 대문자 HEX)
function generateSign(apiPath, params) {
  const sorted = Object.keys(params).sort();
  let baseString = apiPath;
  for (const key of sorted) {
    baseString += key + params[key];
  }
  return crypto.createHmac('sha256', APP_SECRET).update(baseString).digest('hex').toUpperCase();
}

// 인증코드 → Access Token 교환
async function getAccessToken(code) {
  const apiPath = '/auth/token/create';
  const timestamp = Date.now().toString();

  const params = {
    app_key: APP_KEY,
    timestamp: timestamp,
    sign_method: 'sha256',
    code: code,
  };
  params.sign = generateSign(apiPath, params);

  const url = `https://openapi-api.alibaba.com/rest${apiPath}`;
  const res = await axios.get(url, { params, timeout: 15000 });
  return res.data;
}

// 실행
const authUrl = `https://openapi-auth.alibaba.com/oauth/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URL)}&client_id=${APP_KEY}`;

console.log('=================================');
console.log('Alibaba.com ICBU 인증');
console.log('=================================');
console.log('\n1) 아래 URL을 브라우저에서 열어주세요:\n');
console.log(authUrl);
console.log('\n2) 로그인 후 승인하면 브라우저가 example.com으로 이동합니다.');
console.log('   주소창에서 code= 뒤의 값을 복사하세요.');
console.log('   예: https://example.com/callback?code=XXXXX\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('code 값을 입력하세요: ', async (code) => {
  rl.close();
  code = code.trim();
  if (!code) {
    console.log('code가 비어있습니다.');
    process.exit(1);
  }

  try {
    const tokenData = await getAccessToken(code);
    console.log('\n--- 결과 ---');
    console.log(JSON.stringify(tokenData, null, 2));

    if (tokenData.access_token) {
      console.log('\n.env에 아래 값을 입력하세요:');
      console.log(`ALIBABA_ACCESS_TOKEN=${tokenData.access_token}`);
    }
  } catch (err) {
    console.error('\n토큰 발급 실패:', err.response?.data || err.message);
  }
  process.exit(0);
});
