# Hermes v1 eBay Market Intelligence — Implementation Plan & Runbook

## 조사 결과

요청한 v1 데이터 모델 기준으로 현재 코드/DB 상태는 다음과 같다.

| v1 모델 | 현재 상태 | 조치 |
|---|---|---|
| competitor_sellers | migration 057에 존재 | 그대로 사용 |
| competitor_listings | migration 057에 존재 | crawler 컬럼 불일치 수정 |
| my_listings | 없음 | migration 058에 신규 추가, ebay_products에서 read-only snapshot sync |
| sku_mappings | 없음 | migration 058에 신규 추가, product_matches에서 backfill/sync |
| price_snapshots | 없음 | migration 058에 신규 추가, crawler가 경쟁상품 snapshot 기록 |
| market_alerts | 없음 | migration 058에 신규 추가, 가격/상태/신규 alert 저장 |
| daily_reports | 없음 | migration 058에 신규 추가, Daily Report 저장 |

기존 테이블 중 재사용되는 것:

- ebay_products: 우리 eBay 리스팅 원본 DB snapshot
- product_matches: 기존 AI/수동 SKU 매핑
- competitor_price_history: 기존 경쟁사 가격 이력
- competitor_alerts: 기존 repricing pipeline alert. v1에서는 새 market_alerts를 사용

## 구현 방향

Hermes v1은 eBay Market Intelligence 리포트봇이다.

금지:

- eBay 가격 변경 API 호출
- Telegram 가격 승인 버튼
- dryRun=false live repricing

허용:

- 경쟁셀러 수집
- 가격/배송/상태 스냅샷 저장
- 이전 snapshot과 비교
- market_alerts 생성
- Telegram alert 전송
- Daily Report 생성/전송
- Telegram 버튼은 상세보기만

## 수동 실행 명령

### 1. v1 snapshot/mapping sync

```bash
node scripts/hermes-market-intelligence.js sync
```

### 2. 최근 24시간 alert 생성

```bash
node scripts/hermes-market-intelligence.js alerts --hours=24
```

Telegram 즉시 알림 포함:

```bash
node scripts/hermes-market-intelligence.js alerts --hours=24 --telegram
```

### 3. Daily Report 생성

```bash
node scripts/hermes-market-intelligence.js daily --hours=24
```

Telegram 전송 포함:

```bash
node scripts/hermes-market-intelligence.js daily --hours=24 --telegram
```

### 4. API 수동 실행

```bash
# market_alerts 생성
POST /api/competitor-system/market/alerts/generate
body: { "hours": 24, "sendTelegram": false }

# daily report 생성
POST /api/competitor-system/market/daily-report/run
body: { "hours": 24, "sendTelegram": true }

# 최근 alert 조회
GET /api/competitor-system/market/alerts?limit=100

# 최근 daily report 조회
GET /api/competitor-system/market/daily-report/latest
```

## 스케줄

server.js에서 `src/services/scheduler.js`의 `start()`가 실행된다.

현재 v1 관련 스케줄:

- 매일 01:00 KST: competitorCrawler 실행
- 매일 01:30 KST: aiMatcher 실행
- 매일 08:00 KST: Hermes v1 Daily Market Report 생성 및 Telegram 전송
- 기존 repricing pipeline은 v1 safety lock으로 dry-run/report only

## 환경변수

필수/권장:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_REFRESH_TOKEN=...
EBAY_USER_TOKEN=...          # tokenStore가 DB에서 로드할 수도 있음
SCRAPER_API_KEY=...          # eBay seller listing scrape 안정화용 권장
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
APP_PUBLIC_URL=https://pmc-work-mvp-production.up.railway.app
```

## 필요한 eBay API 권한

v1은 read-only 중심이다.

필요:

- Browse API item read
- Browse API search/read
- Sell/Trading API active listing read 또는 기존 token 기반 active listing 조회

불필요/금지:

- price revise/update 권한 사용
- ReviseInventoryStatus / ReviseFixedPriceItem 기반 가격 변경

코드상 가격 변경 경로는 이전 커밋에서 Hermes v1 safety lock으로 비활성화되어 있다.

## Daily Report 형식

생성되는 report는 아래 섹션을 포함한다.

- 오늘 시장 요약
- 가격 하락 TOP 10
- 가격 상승 TOP 10
- 품절/재입고 상품
- 신규 경쟁상품
- 내가 더 비싼 SKU
- 내가 더 싼데도 안 팔리는 SKU
- 가격 유지 추천 SKU
- 가격 변경 금지 SKU

판매량 데이터가 아직 연결되지 않은 경우 “내가 더 싼데도 안 팔리는 SKU”는 가격상 winning 후보를 listing-quality 점검 후보로 표시한다.
