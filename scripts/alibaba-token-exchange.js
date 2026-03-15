/**
 * Alibaba OAuth code → token 교환 스크립트
 *
 * 사용법:
 *   node scripts/alibaba-token-exchange.js <code>
 *
 * code 얻는 방법:
 *   1. 브라우저에서 아래 URL 열기:
 *      node -e "require('dotenv').config({path:'config/.env'}); const k=process.env.ALIBABA_APP_KEY; console.log('https://auth.alibaba.com/oauth/authorize?response_type=code&client_id='+k+'&redirect_uri=https%3A%2F%2Fccorea.com%2Falibaba%2Fcallback&view=web&sp=ICBU')"
 *   2. Alibaba 로그인
 *   3. 리다이렉트 실패해도 브라우저 주소창에서 ?code=XXXX 부분 복사
 *   4. node scripts/alibaba-token-exchange.js XXXX
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const code = process.argv[2];
if (!code) {
  console.error('사용법: node scripts/alibaba-token-exchange.js <code>');
  process.exit(1);
}

const appKey = process.env.ALIBABA_APP_KEY;
const appSecret = process.env.ALIBABA_APP_SECRET;
const envPath = path.join(__dirname, '../config/.env');

async function main() {
  const apiPath = '/auth/token/create';
  const timestamp = Date.now().toString();
  const params = {
    app_key: appKey,
    timestamp,
    sign_method: 'sha256',
    code,
  };

  const sorted = Object.keys(params).sort();
  let baseString = apiPath;
  for (const key of sorted) baseString += key + params[key];
  params.sign = crypto.createHmac('sha256', appSecret).update(baseString).digest('hex').toUpperCase();

  console.log('Alibaba token 교환 중...');
  const r = await axios.post('https://openapi-api.alibaba.com/rest' + apiPath, null, { params, timeout: 15000 });
  const data = r.data;
  console.log('응답:', JSON.stringify(data, null, 2));

  if (!data.access_token) {
    console.error('❌ access_token 없음. 응답:', JSON.stringify(data));
    process.exit(1);
  }

  let env = fs.readFileSync(envPath, 'utf8');
  env = env.replace(/ALIBABA_ACCESS_TOKEN=.*/, 'ALIBABA_ACCESS_TOKEN=' + data.access_token);
  if (data.refresh_token) {
    env = env.replace(/ALIBABA_REFRESH_TOKEN=.*/, 'ALIBABA_REFRESH_TOKEN=' + data.refresh_token);
  }
  fs.writeFileSync(envPath, env);

  console.log('\n✅ Alibaba 토큰 저장 완료!');
  console.log('access_token:', data.access_token.substring(0, 20) + '...');
  if (data.expire_time) {
    console.log('만료 시간:', new Date(data.expire_time * 1000).toLocaleString('ko-KR'));
  }
}

main().catch(e => {
  console.error('❌ 오류:', e.response?.data || e.message);
  process.exit(1);
});
