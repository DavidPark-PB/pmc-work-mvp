/**
 * Shopee Shop-Level OAuth 인증 도구
 *
 * 실행: npx tsx scripts/shopee-oauth.ts
 *
 * 1. 로컬 서버(9090)를 띄움
 * 2. 브라우저 인증 URL 출력
 * 3. 브라우저에서 각 shop 인증 후 토큰 자동 저장
 */
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import 'dotenv/config';

const PARTNER_ID = Number(process.env.SHOPEE_PARTNER_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY!;
const BASE_URL = 'https://partner.shopeemobile.com';
const REDIRECT_URL = 'http://ccorea.com/shopee/callback';
const ENV_PATH = path.join(process.cwd(), '.env');

function signPublic(path: string, ts: number) {
  return crypto.createHmac('sha256', PARTNER_KEY)
    .update(`${PARTNER_ID}${path}${ts}`)
    .digest('hex');
}

function getAuthUrl(): string {
  const apiPath = '/api/v2/shop/auth_partner';
  const ts = Math.floor(Date.now() / 1000);
  const sign = signPublic(apiPath, ts);
  return `${BASE_URL}${apiPath}?partner_id=${PARTNER_ID}&timestamp=${ts}&sign=${sign}&redirect=${encodeURIComponent(REDIRECT_URL)}`;
}

async function exchangeCodeForToken(code: string, shopId: number): Promise<{
  accessToken: string;
  refreshToken: string;
  expireIn: number;
}> {
  const apiPath = '/api/v2/auth/token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = signPublic(apiPath, ts);
  const url = `${BASE_URL}${apiPath}?partner_id=${PARTNER_ID}&timestamp=${ts}&sign=${sign}`;

  const res = await axios.post(url, {
    code,
    shop_id: shopId,
    partner_id: PARTNER_ID,
  }, { timeout: 15000 });

  const data = res.data;
  if (data.error) throw new Error(`Token exchange 실패: ${data.error} - ${data.message}`);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expireIn: data.expire_in,
  };
}

function updateEnv(shopId: number, accessToken: string, refreshToken: string) {
  let content = fs.readFileSync(ENV_PATH, 'utf-8');

  const shopLine = `SHOPEE_SHOP_${shopId}_ACCESS_TOKEN=${accessToken}\nSHOPEE_SHOP_${shopId}_REFRESH_TOKEN=${refreshToken}`;

  // 이미 있으면 교체, 없으면 Shopee 섹션 뒤에 추가
  const accessKey = `SHOPEE_SHOP_${shopId}_ACCESS_TOKEN`;
  if (content.includes(accessKey)) {
    content = content.replace(
      new RegExp(`${accessKey}=.*`),
      `${accessKey}=${accessToken}`,
    );
    content = content.replace(
      new RegExp(`SHOPEE_SHOP_${shopId}_REFRESH_TOKEN=.*`),
      `SHOPEE_SHOP_${shopId}_REFRESH_TOKEN=${refreshToken}`,
    );
  } else {
    content += `\n# Shop ${shopId} tokens\n${shopLine}\n`;
  }

  fs.writeFileSync(ENV_PATH, content);
  console.log(`\n✅ .env에 shop ${shopId} 토큰 저장 완료`);
  console.log(`   ACCESS : ${accessToken.substring(0, 30)}...`);
  console.log(`   REFRESH: ${refreshToken.substring(0, 30)}...`);
}

// ─── OAuth 서버 시작 ─────────────────────────────

const received = new Set<number>();

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/shopee/callback')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const params = new URL(req.url, 'http://localhost:9090').searchParams;
  const code = params.get('code');
  const shopId = parseInt(params.get('shop_id') || '0');

  if (!code || !shopId) {
    res.writeHead(400);
    res.end('code 또는 shop_id 없음');
    return;
  }

  console.log(`\n🔑 shop_id ${shopId} 인증 코드 수신, 토큰 교환 중...`);

  try {
    const { accessToken, refreshToken, expireIn } = await exchangeCodeForToken(code, shopId);
    updateEnv(shopId, accessToken, refreshToken);
    received.add(shopId);

    const expireHours = Math.round(expireIn / 3600);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px">
        <h2>✅ Shop ${shopId} 인증 완료!</h2>
        <p>토큰 만료: ${expireHours}시간 후</p>
        <p>이 창을 닫고 다음 shop을 인증하세요.</p>
      </body></html>
    `);

    console.log(`\n현재 완료된 shop: ${[...received].join(', ')}`);
    console.log(`남은 shop: ${[582202068,599866677,599866810,599866876,1675323577].filter(s => !received.has(s)).join(', ') || '없음 (전체 완료!)'}`);

  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body><h2>❌ 실패: ${(e as Error).message}</h2></body></html>`);
    console.error('토큰 교환 실패:', (e as Error).message);
  }
});

server.listen(9090, () => {
  const authUrl = getAuthUrl();
  console.log('\n=== Shopee Shop OAuth 인증 ===\n');
  console.log('아래 URL을 브라우저에서 열고 각 shop을 인증하세요:');
  console.log('\n' + authUrl + '\n');
  console.log('인증 대상 shop_id 목록:');
  console.log('  582202068, 599866677, 599866810, 599866876, 1675323577');
  console.log('\n인증 완료 후 Ctrl+C로 종료하세요.\n');
});
