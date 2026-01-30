# 🚀 eBay OAuth 완전 자동화 배포 체크리스트

## 준비물 확인

- [x] ccorea.com 서버 접속 정보
- [x] SSH 접근 권한
- [x] Node.js 설치 확인
- [x] PM2 또는 Forever 설치
- [x] Nginx 설정 권한
- [ ] SSL 인증서 (Let's Encrypt 등)

## 📦 Step 1: 서버에 파일 업로드

서버에 디렉토리 생성:
```bash
ssh user@ccorea.com
mkdir -p /var/www/ebay-oauth
cd /var/www/ebay-oauth
```

다음 파일들을 서버에 업로드:
- [ ] `ebay-oauth-server.js`
- [ ] `.env` (토큰 제외)
- [ ] `package.json`
- [ ] `ebayAPI.js` (선택사항)

## 💻 Step 2: 서버 설정

### 2.1 의존성 설치
```bash
cd /var/www/ebay-oauth
npm install
```

### 2.2 .env 파일 설정
```bash
nano .env
```

다음 내용 확인/수정:
```env
EBAY_APP_ID=YOUR_EBAY_APP_ID
EBAY_DEV_ID=YOUR_EBAY_DEV_ID
EBAY_CERT_ID=YOUR_EBAY_CERT_ID
EBAY_USER_TOKEN=
EBAY_REFRESH_TOKEN=
EBAY_RUNAME=YOUR_EBAY_RUNAME
EBAY_ENVIRONMENT=PRODUCTION
EBAY_CALLBACK_URL=https://ccorea.com/api/ebay/callback
PORT=3001
```

### 2.3 파일 권한 설정
```bash
chmod 600 .env
chmod 755 ebay-oauth-server.js
```

## 🔧 Step 3: PM2로 서버 시작

```bash
# PM2 설치 (없다면)
npm install -g pm2

# 서버 시작
pm2 start ebay-oauth-server.js --name ebay-oauth

# 자동 시작 설정
pm2 startup
pm2 save

# 상태 확인
pm2 status
pm2 logs ebay-oauth
```

## 🌐 Step 4: Nginx 리버스 프록시 설정

```bash
sudo nano /etc/nginx/sites-available/ccorea.com
```

다음 내용 추가:
```nginx
server {
    listen 443 ssl;
    server_name ccorea.com;

    # SSL 인증서 (기존 설정 사용)
    ssl_certificate /etc/letsencrypt/live/ccorea.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ccorea.com/privkey.pem;

    # eBay OAuth API
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

    # 기존 설정 유지...
}
```

Nginx 재시작:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 🔑 Step 5: eBay Developer Portal 설정

1. https://developer.ebay.com/ 접속
2. My Account → Application Keys
3. Production App 선택
4. RuName 설정:

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

5. **Save** 클릭

## 🎯 Step 6: OAuth 인증 완료

브라우저에서:
```
https://ccorea.com/api/ebay/auth
```

1. eBay 계정 로그인
2. 권한 승인
3. 성공 메시지 확인

## ✅ Step 7: 테스트

### 7.1 토큰 상태 확인
```bash
curl https://ccorea.com/api/ebay/status
```

예상 출력:
```json
{
  "status": "active",
  "expires_at": "2026-01-10T14:49:10.308Z",
  "time_left_seconds": 7200,
  "time_left_hours": "2.00"
}
```

### 7.2 Health Check
```bash
curl https://ccorea.com/health
```

### 7.3 로컬에서 동기화 테스트
```bash
# 로컬 PC에서
cd "c:\Users\tooni\PMC work MVP"
node auto-sync-scheduler.js
```

## 🔄 Step 8: 로컬 .env 동기화

서버에서 토큰 확인:
```bash
cat /var/www/ebay-oauth/ebay-tokens.json
```

로컬 `.env` 파일 업데이트:
- `EBAY_USER_TOKEN=` (서버의 access_token 복사)
- `EBAY_REFRESH_TOKEN=` (서버의 refresh_token 복사)

## 📊 Step 9: 모니터링 설정

```bash
# 로그 확인
pm2 logs ebay-oauth --lines 100

# 모니터링 대시보드
pm2 monit

# 자동 재시작 확인
pm2 restart ebay-oauth
```

## 🎉 완료 확인

- [ ] OAuth 서버 정상 실행 중
- [ ] Nginx 리버스 프록시 작동
- [ ] eBay Developer Portal RuName 설정 완료
- [ ] 첫 OAuth 인증 완료
- [ ] 토큰 자동 갱신 작동 (1시간 후 로그 확인)
- [ ] 로컬에서 동기화 테스트 성공

## 🚨 트러블슈팅

### 문제: 서버가 시작되지 않음
```bash
pm2 logs ebay-oauth
# 에러 메시지 확인 후 수정
pm2 restart ebay-oauth
```

### 문제: Nginx 502 Bad Gateway
```bash
# 포트 확인
netstat -tulpn | grep 3001

# PM2 상태 확인
pm2 status

# Nginx 에러 로그
sudo tail -f /var/log/nginx/error.log
```

### 문제: OAuth 콜백 에러
- eBay Developer Portal의 RuName URL 재확인
- Nginx 설정 `/api/ebay/` 경로 확인
- 서버 로그에서 에러 확인

### 문제: SSL 인증서 관련
```bash
# Let's Encrypt 인증서 확인
sudo certbot certificates

# 인증서 갱신
sudo certbot renew
sudo systemctl reload nginx
```

## 📝 유지보수

### 정기 점검 (월 1회)
- [ ] PM2 상태 확인: `pm2 status`
- [ ] 디스크 공간 확인: `df -h`
- [ ] 토큰 갱신 로그 확인
- [ ] SSL 인증서 만료일 확인

### 토큰 수동 갱신 (필요시)
```bash
curl -X POST https://ccorea.com/api/ebay/refresh
```

## 🎊 자동화 완성!

이제 eBay 토큰이 완전히 자동으로 관리됩니다:
- ✅ 1시간마다 토큰 만료 체크
- ✅ 만료 5분 전 자동 갱신
- ✅ 서버 재시작 시 자동 시작
- ✅ .env 파일 자동 업데이트

더 이상 수동 작업 필요 없음! 🚀
