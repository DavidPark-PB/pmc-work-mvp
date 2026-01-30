# eBay 연동 빠른 시작 가이드

## 🎯 목표

eBay 활성 리스팅을 Google Sheets에 자동 동기화하여 Shopify와 함께 통합 관리

## 📋 사전 준비

✅ eBay Developer 계정 생성 완료
✅ eBay Production API 자격증명 발급 완료
✅ .env 파일에 eBay credentials 추가 완료

현재 .env 파일 상태:
```env
EBAY_APP_ID=YOUR_EBAY_APP_ID
EBAY_DEV_ID=YOUR_EBAY_DEV_ID
EBAY_CERT_ID=YOUR_EBAY_CERT_ID
EBAY_USER_TOKEN=YOUR_USER_TOKEN_HERE  # ⚠️ 아직 발급 필요
EBAY_ENVIRONMENT=PRODUCTION
```

## 🚀 3단계로 시작하기

### 1단계: eBay User Token 발급 (필수, 최초 1회)

```bash
node get-ebay-token.js
```

**진행 순서:**
1. 명령어 실행 → 로컬 서버 시작
2. 브라우저가 자동으로 eBay 로그인 페이지 열림
3. eBay 판매자 계정으로 로그인
4. 권한 승인 버튼 클릭
5. 브라우저에 토큰 표시됨
6. 콘솔에 출력된 내용을 복사

**콘솔 출력 예시:**
```
🎉 eBay User Token 발급 성공!

📝 .env 파일에 다음 내용을 추가하세요:

EBAY_USER_TOKEN=v^1.1#i^1#p^3#f^0#r^1#I^3#t^Ul4xM...
EBAY_REFRESH_TOKEN=v^1.1#i^1#p^3#r^1#I^3#t^Ul4x...
```

**중요:** 출력된 토큰을 `.env` 파일에 복사하세요!

### 2단계: eBay API 연결 테스트

```bash
node ebayAPI.js
```

**성공 출력:**
```
=== eBay API 테스트 ===

✅ eBay API 연결 성공!
   사용자: your_ebay_username
   환경: PRODUCTION

📦 활성 리스팅 조회 중...
✅ 150개 상품 로드 완료

샘플 상품 (처음 3개):

1. Product Name Example
   SKU: SKU-12345
   가격: $29.99
   수량: 100
   판매: 5개
```

**실패 시:**
```
⚠️ User Token이 설정되지 않았습니다.
   get-ebay-token.js를 실행하여 토큰을 발급받으세요.
```
→ 1단계로 돌아가서 토큰 발급

### 3단계: eBay 상품 동기화

```bash
node sync-ebay-to-sheets.js
```

**동작:**
- eBay 활성 리스팅 전체 조회
- Google Sheets에 신규 상품 추가
- 기존 상품 가격 업데이트
- 자동으로 순이익/마진율 계산 수식 추가

**성공 출력:**
```
========================================
📦 eBay → Google Sheets 동기화
========================================

1️⃣ Google Sheets 인증 중...
✅ 인증 완료

2️⃣ eBay API 연결 중...
✅ eBay API 연결 성공!

3️⃣ eBay 리스팅 가져오는 중...
✅ 150개 eBay 상품 로드

4️⃣ 기존 데이터 읽는 중...
✅ 3882개 기존 상품

5️⃣ 동기화 내역:
   🆕 신규 상품: 150개
   🔄 가격 업데이트: 0개

6️⃣ 신규 상품 추가 중...
✅ 150개 상품 추가 완료

7️⃣ 수식 적용 중...
✅ 150개 행에 수식 적용 완료

========================================
✅ eBay 동기화 완료!
========================================
```

## 📊 Google Sheets 확인

동기화 후 스프레드시트를 열어보세요:
https://docs.google.com/spreadsheets/d/1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M

**eBay 상품 특징:**
- **K열 (플랫폼)**: `eBay`로 표시
- **F열 (수수료)**: `13%` (eBay 기본 수수료)
- **J열 (검수 상태)**: `검수대기`로 시작
- **C열 (매입가)**: 빈칸 - 수동 입력 필요
- **G열 (배송비)**: 빈칸 - 수동 입력 필요

## 🔄 자동화 설정

### 통합 자동 동기화 (Shopify + eBay)

```bash
node auto-sync-scheduler.js
```

**동작 순서:**
1. Shopify 상품 동기화
2. eBay 상품 동기화
3. 이상 징후 자동 감지
4. 로그 파일 기록 (sync-log.json)

### Windows Task Scheduler로 자동 실행

1. `auto-sync.bat` 더블클릭하여 실행 테스트
2. 작업 스케줄러에 등록:
   - 트리거: 매일 새벽 3시
   - 실행: `C:\Users\tooni\PMC work MVP\auto-sync.bat`

자세한 설정 방법: [APPS_SCRIPT_TRIGGER.md](APPS_SCRIPT_TRIGGER.md)

## ❓ 문제 해결

### 문제 1: "User Token이 설정되지 않았습니다"

**원인:** .env 파일에 `EBAY_USER_TOKEN`이 없거나 잘못됨

**해결:**
```bash
node get-ebay-token.js
```
출력된 토큰을 `.env` 파일에 복사

### 문제 2: "eBay API 연결 실패: Invalid token"

**원인:** Access Token 만료 (유효기간 2시간)

**해결:**
```bash
node get-ebay-token.js
```
새 토큰 발급 받기

### 문제 3: "활성 리스팅이 없습니다"

**원인:** eBay 계정에 활성 상품이 없음

**확인:**
1. eBay.com → My eBay → Selling → Active listings 확인
2. 최소 1개 이상 활성 상품 필요

### 문제 4: 동기화 후 수식이 작동하지 않음

**원인:** C열(매입가) 또는 G열(배송비)이 비어있음

**해결:**
- 매입가와 배송비를 수동으로 입력
- 입력 후 자동으로 순이익/마진율 계산됨

## 📖 추가 문서

- **전체 기능 설명**: [STEP5_EBAY_INTEGRATION.md](STEP5_EBAY_INTEGRATION.md)
- **자동 트리거 설정**: [APPS_SCRIPT_TRIGGER.md](APPS_SCRIPT_TRIGGER.md)
- **대시보드 사용법**: [STEP4_SUMMARY.md](STEP4_SUMMARY.md)

## 🎉 완료!

이제 Shopify + eBay 통합 관리 시스템이 준비되었습니다!

**다음 작업:**
1. eBay 상품의 매입가(C열), 배송비(G열) 수동 입력
2. 검수 상태(J열) 업데이트
3. `dashboard-filters.js`로 플랫폼별 통계 확인

```bash
# 대시보드 필터 테스트
node dashboard-filters.js
```

**플랫폼별 필터 예시:**
```javascript
const DashboardFilters = require('./dashboard-filters');
const dashboard = new DashboardFilters();
await dashboard.initialize();

// eBay 상품만
const ebay = dashboard.filterByPlatform('eBay');

// Shopify 상품만
const shopify = dashboard.filterByPlatform('Shopify');

// 전체 통계
const stats = dashboard.getStatistics();
console.log(stats.byPlatform);
// { Shopify: 3882, eBay: 150 }
```

질문이나 문제가 있으면 [STEP5_EBAY_INTEGRATION.md](STEP5_EBAY_INTEGRATION.md) 참고!
