# eBay OAuth 완전 자동화 배포 가이드

## 개요

이 가이드는 `ccorea.com` 서버에 eBay OAuth 자동 갱신 시스템을 배포하는 방법을 설명합니다.

## 필요 사항

- ✅ Node.js 설치된 웹서버 (ccorea.com)
- ✅ HTTPS 지원 (필수)
- ✅ PM2 또는 Forever (서버 프로세스 관리)

## 1단계: 서버에 파일 업로드

다음 파일들을 `ccorea.com` 서버에 업로드:

```
/var/www/ebay-oauth/
├── ebay-oauth-server.js
├── .env
├── package.json
└── ebayAPI.js (선택사항)
```

## 2단계: package.json 생성

```json
{
  "name": "ebay-oauth-server",
  "version": "1.0.0",
  "description": "eBay OAuth Token Auto-Refresh Server",
  "main": "ebay-oauth-server.js",
  "scripts": {
    "start": "node ebay-oauth-server.js",
    "dev": "nodemon ebay-oauth-server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.6.0",
    "dotenv": "^16.3.1"
  }
}
```

## 3단계: .env 파일 설정

```env
# eBay API Credentials (Production)
EBAY_APP_ID=YOUR_EBAY_APP_ID
EBAY_DEV_ID=YOUR_EBAY_DEV_ID
EBAY_CERT_ID=YOUR_EBAY_CERT_ID
EBAY_USER_TOKEN=
EBAY_REFRESH_TOKEN=
EBAY_RUNAME=YOUR_EBAY_RUNAME
EBAY_ENVIRONMENT=PRODUCTION

# OAuth Callback URL (배포 후 실제 URL로 변경)
EBAY_CALLBACK_URL=https://ccorea.com/api/ebay/callback

# Server Port
PORT=3001
```

## 4단계: 서버에서 설치 및 실행

```bash
# 디렉토리 이동
cd /var/www/ebay-oauth

# 의존성 설치
npm install

# PM2로 서버 시작 (자동 재시작)
pm2 start ebay-oauth-server.js --name ebay-oauth

# PM2 자동 시작 설정
pm2 startup
pm2 save

# 서버 상태 확인
pm2 status
pm2 logs ebay-oauth
```

## 5단계: Nginx 리버스 프록시 설정

`/etc/nginx/sites-available/ccorea.com`에 추가:

```nginx
server {
    listen 443 ssl;
    server_name ccorea.com;

    # SSL 인증서 설정
    ssl_certificate /etc/letsencrypt/live/ccorea.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ccorea.com/privkey.pem;

    # eBay OAuth 엔드포인트
    location /api/ebay/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 기존 설정...
}
```

Nginx 재시작:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 6단계: eBay Developer Portal RuName 업데이트

https://developer.ebay.com/ → My Account → Application Keys

**Your auth accepted URL:**
```
https://ccorea.com/api/ebay/callback
```

**Your auth declined URL:**
```
https://ccorea.com/api/ebay/callback
```

**Your privacy policy URL:**
```
https://ccorea.com/policies/privacy-policy
```

**Save** 버튼 클릭

## 7단계: OAuth 인증 완료

브라우저에서 다음 URL 접속:
```
https://ccorea.com/api/ebay/auth
```

1. eBay 계정으로 로그인
2. 권한 승인
3. 자동으로 콜백 처리
4. Access Token과 Refresh Token 저장됨

## 8단계: 로컬 환경 설정

로컬 `.env` 파일을 서버의 최신 토큰으로 동기화:

```bash
# 서버에서 토큰 확인
curl https://ccorea.com/api/ebay/status

# 또는 서버 파일 직접 확인
cat /var/www/ebay-oauth/ebay-tokens.json
```

로컬 `.env` 파일 업데이트:
```env
EBAY_USER_TOKEN=<서버의_access_token>
EBAY_REFRESH_TOKEN=<서버의_refresh_token>
```

## 자동화 완료!

이제 다음이 자동으로 실행됩니다:

✅ **1시간마다** 토큰 만료 체크
✅ **만료 5분 전** 자동 갱신
✅ **서버 재시작 시** 자동 시작 (PM2)
✅ **토큰 갱신 후** .env 파일 자동 업데이트

## API 엔드포인트

### 1. OAuth 인증 시작
```
GET https://ccorea.com/api/ebay/auth
```

### 2. 토큰 상태 확인
```bash
curl https://ccorea.com/api/ebay/status
```

응답 예시:
```json
{
  "status": "active",
  "expires_at": "2026-01-10T14:49:10.308Z",
  "time_left_seconds": 7200,
  "time_left_hours": "2.00",
  "updated_at": "2026-01-10T12:49:10.308Z"
}
```

### 3. 수동 토큰 갱신
```bash
curl -X POST https://ccorea.com/api/ebay/refresh
```

### 4. Health Check
```bash
curl https://ccorea.com/health
```

## 로컬 동기화 자동화

로컬에서도 자동으로 서버의 최신 토큰을 가져오는 스크립트:

**`sync-ebay-token.js`**:
```javascript
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

async function syncToken() {
  try {
    // 서버에서 토큰 파일 다운로드 (예: SFTP 또는 API)
    const response = await axios.get('https://ccorea.com/api/ebay/tokens', {
      auth: {
        username: 'your-username',
        password: 'your-password'
      }
    });

    const tokens = response.data;

    // .env 업데이트
    let envContent = fs.readFileSync('.env', 'utf8');
    envContent = envContent.replace(/EBAY_USER_TOKEN=.*/, `EBAY_USER_TOKEN=${tokens.access_token}`);
    envContent = envContent.replace(/EBAY_REFRESH_TOKEN=.*/, `EBAY_REFRESH_TOKEN=${tokens.refresh_token}`);
    fs.writeFileSync('.env', envContent);

    console.log('✅ 토큰 동기화 완료');
  } catch (error) {
    console.error('❌ 토큰 동기화 실패:', error.message);
  }
}

syncToken();
```

## 모니터링

### PM2 모니터링
```bash
pm2 logs ebay-oauth --lines 100
pm2 monit
```

### 토큰 갱신 로그 확인
```bash
tail -f /var/www/ebay-oauth/logs/token-refresh.log
```

## 트러블슈팅

### 문제: 토큰이 갱신되지 않음
```bash
# 서버 로그 확인
pm2 logs ebay-oauth

# 서버 재시작
pm2 restart ebay-oauth

# 토큰 수동 갱신
curl -X POST https://ccorea.com/api/ebay/refresh
```

### 문제: OAuth 콜백 에러
- Nginx 설정 확인: `sudo nginx -t`
- 방화벽 확인: 포트 3001 열려 있는지
- eBay Developer Portal RuName 설정 재확인

### 문제: HTTPS 인증서 만료
```bash
# Let's Encrypt 갱신
sudo certbot renew
sudo systemctl reload nginx
```

## 보안 고려사항

1. **토큰 파일 권한**: `ebay-tokens.json` 파일은 600 권한으로 설정
   ```bash
   chmod 600 ebay-tokens.json
   ```

2. **.env 파일 보호**: Git에 커밋하지 않도록 .gitignore 추가
   ```
   .env
   ebay-tokens.json
   ```

3. **API 엔드포인트 보호**: 필요시 Basic Auth 또는 API Key 추가

## 완료!

이제 eBay OAuth 토큰이 완전히 자동으로 관리됩니다! 🎉

더 이상 2시간마다 수동으로 토큰을 갱신할 필요가 없습니다.
