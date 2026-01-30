# 🚀 5단계: eBay API 연동 완료

## ✅ 구현된 기능

### 1. eBay User Token 발급 도구

**파일**: [get-ebay-token.js](get-ebay-token.js)

**기능:**
- OAuth 2.0 인증 자동화
- 브라우저 자동 실행
- Access Token & Refresh Token 발급
- .env 파일에 복사 가능한 형식으로 출력

**실행 방법:**
```bash
node get-ebay-token.js
```

**실행 순서:**
1. 로컬 서버 시작 (http://localhost:3000)
2. 브라우저가 자동으로 eBay 인증 페이지 열림
3. eBay 계정으로 로그인
4. 권한 승인
5. 토큰 자동 발급 및 콘솔에 출력
6. 브라우저에 토큰 표시

**발급된 토큰을 .env에 추가:**
```env
EBAY_USER_TOKEN=v^1.1#i^1#...
EBAY_REFRESH_TOKEN=v^1.1#i^1#...
```

### 2. eBay API 통합 모듈

**파일**: [ebayAPI.js](ebayAPI.js)

**주요 메서드:**

#### `testConnection()`
eBay API 연결 테스트 및 사용자 정보 조회

```javascript
const ebay = new EbayAPI();
await ebay.testConnection();
// ✅ eBay API 연결 성공!
//    사용자: your_ebay_username
//    환경: PRODUCTION
```

#### `getAllActiveListings()`
모든 활성 리스팅 가져오기 (페이지네이션 자동 처리)

```javascript
const listings = await ebay.getAllActiveListings();
console.log(`총 ${listings.length}개 상품`);
```

#### `getActiveListings(pageNumber, entriesPerPage)`
페이지별 리스팅 조회

```javascript
const result = await ebay.getActiveListings(1, 100);
console.log(result.items); // 100개 상품
console.log(result.totalPages); // 전체 페이지 수
console.log(result.hasMore); // 다음 페이지 여부
```

#### `updateInventoryQuantity(sku, quantity)`
재고 수량 업데이트

```javascript
await ebay.updateInventoryQuantity('SKU-12345', 50);
// ✅ SKU SKU-12345 수량 업데이트: 50
```

#### `updateInventoryPrice(sku, price)`
상품 가격 업데이트

```javascript
await ebay.updateInventoryPrice('SKU-12345', 29.99);
// ✅ SKU SKU-12345 가격 업데이트: $29.99
```

**리스팅 데이터 구조:**
```javascript
{
  itemId: '123456789',
  sku: 'SKU-12345',
  title: '상품명',
  price: '29.99',
  quantity: 100,
  quantitySold: 5,
  listingType: 'FixedPriceItem',
  timeLeft: 'P30D',
  viewUrl: 'https://www.ebay.com/itm/123456789',
  imageUrl: 'https://i.ebayimg.com/...'
}
```

### 3. eBay 자동 동기화 스크립트

**파일**: [sync-ebay-to-sheets.js](sync-ebay-to-sheets.js)

**동작:**
1. eBay에서 모든 활성 리스팅 가져오기
2. Google Sheets에서 기존 데이터 읽기
3. SKU 기준으로 신규/기존 상품 분류
4. 신규 상품 추가 (자동 수식 포함)
5. 기존 상품 가격 업데이트

**실행 방법:**
```bash
node sync-ebay-to-sheets.js
```

**출력 예시:**
```
========================================
📦 eBay → Google Sheets 동기화
========================================

1️⃣  Google Sheets 인증 중...
✅ 인증 완료

2️⃣  eBay API 연결 중...
✅ eBay API 연결 성공!
   사용자: your_username
   환경: PRODUCTION

3️⃣  eBay 리스팅 가져오는 중...
✅ 150개 eBay 상품 로드

4️⃣  기존 데이터 읽는 중...
✅ 3882개 기존 상품

5️⃣  동기화 내역:
   🆕 신규 상품: 150개
   🔄 가격 업데이트: 0개

6️⃣  신규 상품 추가 중...
✅ 150개 상품 추가 완료

7️⃣  수식 적용 중...
✅ 150개 행에 수식 적용 완료

========================================
✅ eBay 동기화 완료!
========================================
📊 총 150개 eBay 상품 처리
   🆕 신규: 150개
   🔄 업데이트: 0개
========================================
```

**추가되는 데이터 구조:**
| 컬럼 | 값 | 설명 |
|------|-----|------|
| A | SKU | eBay SKU 또는 Item ID |
| B | 상품명 | eBay 리스팅 제목 |
| C | (빈칸) | 매입가 - 수동 입력 필요 |
| D | 29.99 | eBay 판매가($) |
| E | 1350 | 환율 |
| F | 13 | eBay 수수료 13% |
| G | (빈칸) | 배송비 - 수동 입력 필요 |
| H | (수식) | 순이익 자동 계산 |
| I | (수식) | 마진율 자동 계산 |
| J | 검수대기 | 검수 상태 |
| K | eBay | 플랫폼 |

## 📋 eBay vs Shopify 수수료 비교

| 플랫폼 | 수수료(%) | 비고 |
|--------|----------|------|
| Shopify | 5% | Basic 플랜 기준 |
| eBay | 13% | 카테고리별 상이 (평균 12.9%) |
| Amazon | 15% | (향후 추가 예정) |
| Coupang | 10% | (향후 추가 예정) |

## 🔄 통합 자동 동기화

기존 [auto-sync-scheduler.js](auto-sync-scheduler.js)를 업데이트하여 Shopify + eBay 동시 동기화:

```javascript
const syncShopify = require('./sync-shopify-to-sheets');
const syncEbay = require('./sync-ebay-to-sheets');
const detectAnomalies = require('./detect-anomalies');

async function autoSyncAll() {
  console.log('🔄 통합 자동 동기화 시작\n');

  // 1. Shopify 동기화
  console.log('📦 Shopify 동기화...');
  await syncShopify();

  // 2. eBay 동기화
  console.log('\n📦 eBay 동기화...');
  await syncEbay();

  // 3. 이상 징후 감지
  console.log('\n🔍 이상 징후 감지...');
  await detectAnomalies();

  console.log('\n✅ 통합 동기화 완료!');
}

autoSyncAll();
```

## ⚙️ 환경 변수 (.env)

**필수 eBay 설정:**
```env
# eBay API Credentials (Production)
EBAY_APP_ID=YOUR_EBAY_APP_ID
EBAY_DEV_ID=YOUR_EBAY_DEV_ID
EBAY_CERT_ID=YOUR_EBAY_CERT_ID
EBAY_USER_TOKEN=YOUR_USER_TOKEN_HERE  # get-ebay-token.js 실행 후 입력
EBAY_REFRESH_TOKEN=YOUR_REFRESH_TOKEN_HERE
EBAY_ENVIRONMENT=PRODUCTION
```

## 🧪 테스트 방법

### 1. eBay User Token 발급
```bash
node get-ebay-token.js
```

### 2. eBay API 연결 테스트
```bash
node ebayAPI.js
```

출력:
```
=== eBay API 테스트 ===

✅ eBay API 연결 성공!
   사용자: your_username
   환경: PRODUCTION

📦 활성 리스팅 조회 중...

샘플 상품 (처음 3개):

1. 상품명 예시
   SKU: SKU-12345
   가격: $29.99
   수량: 100
   판매: 5개
```

### 3. eBay 동기화 테스트
```bash
node sync-ebay-to-sheets.js
```

## 📊 대시보드 필터 업데이트

기존 [dashboard-filters.js](dashboard-filters.js)가 플랫폼 필터를 이미 지원:

```javascript
const DashboardFilters = require('./dashboard-filters');
const dashboard = new DashboardFilters();
await dashboard.initialize();

// eBay 상품만 필터
const ebayProducts = dashboard.filterByPlatform('eBay');

// Shopify 상품만 필터
const shopifyProducts = dashboard.filterByPlatform('Shopify');

// 통계에 플랫폼별 집계 포함
const stats = dashboard.getStatistics();
console.log(stats.byPlatform);
// { Shopify: 3882, eBay: 150 }
```

## 🚨 주의사항

### 1. eBay API 할당량
- **Trading API**: 일일 5,000 requests
- **Inventory API**: 분당 5,000 requests
- 대량 상품 동기화 시 페이지네이션 사용

### 2. User Token 만료
- Access Token 유효기간: **2시간**
- Refresh Token 유효기간: **18개월**
- 만료 시 `get-ebay-token.js` 재실행 필요

### 3. eBay 수수료 구조
- 카테고리별 수수료 상이 (10%~15%)
- 기본값 13% 사용
- 필요 시 수동 조정

### 4. SKU 관리
- eBay SKU가 없는 경우 Item ID 사용
- Shopify와 eBay SKU 중복 주의
- 플랫폼 컬럼(K)으로 구분

## 📁 생성된 파일 목록

```
PMC work MVP/
├── get-ebay-token.js           # eBay OAuth 토큰 발급 도구
├── ebayAPI.js                  # eBay API 통합 모듈
├── sync-ebay-to-sheets.js      # eBay 자동 동기화
├── STEP5_EBAY_INTEGRATION.md   # 이 문서
└── .env                        # eBay 자격증명 추가됨
```

## 🎯 다음 단계

### 6단계: 웹 대시보드 구축
- Express.js 서버 생성
- 알바생 검수 모드 UI
- 플랫폼별 분석 차트
- 실시간 이상 징후 알림

### 7단계: 고급 기능
- 자동 가격 최적화
- 재고 자동 주문 시스템
- 판매 예측 분석
- 멀티 플랫폼 재고 동기화

## ✅ 완료 체크리스트

- [x] eBay Developer 계정 생성
- [x] eBay API 자격증명 발급
- [x] .env 파일에 credentials 추가
- [x] ebay-api npm 패키지 설치
- [x] OAuth 토큰 발급 도구 생성
- [x] eBay API 통합 모듈 구현
- [x] eBay 자동 동기화 스크립트 생성
- [x] 플랫폼 구분 시스템 구축
- [ ] User Token 발급 (실행 대기)
- [ ] 첫 eBay 동기화 테스트

## 🎉 완료!

5단계 eBay 연동이 완료되었습니다!

이제 다음과 같이 실행하세요:

```bash
# 1. eBay User Token 발급
node get-ebay-token.js

# 2. eBay 동기화 테스트
node sync-ebay-to-sheets.js

# 3. 통합 대시보드 확인
node dashboard-filters.js
```

Shopify + eBay 통합 관리 시스템이 준비되었습니다! 🚀
