# Hermes v1 Phase 3 — Listing Intelligence Plan

## 목표

Phase 3 Listing Intelligence는 Phase 2 Product Intelligence 결과를 기반으로 eBay 리스팅 자체의 품질을 점수화하고 개선 우선순위를 추천한다.

Hermes v1 안전 정책은 유지한다.

- 자동 가격 변경 금지
- marketplace write API 호출 금지
- Telegram 가격 승인 버튼 금지
- 분석/추천/리포트만 제공

## 입력 우선순위

Product Intelligence 후보를 다음 우선순위로 Listing Intelligence 분석에 반영한다.

1. 리스팅 품질 점검 후보
2. Dead stock 후보
3. 데이터 보강 필요 후보
4. 가격/마진 검토 후보

현재 1차 구현은 `hermesProductIntelligence.buildProductIntelligenceReport({ save:false })` 결과를 기반으로 후보군을 가져온다.

## Listing Quality Score 모델

| 항목 | max | 현재 계산 방식 |
|---|---:|---|
| title_keyword_score | 15 | title 주요 키워드 수 + 브랜드/상품 키워드 heuristic |
| title_length_score | 10 | eBay title 60~80자 권장 기준 |
| image_count_score | 10 | `ebay_products.image_url` 대표 이미지 존재 여부. 추가 이미지 수는 미연동이므로 partial |
| image_quality_proxy_score | 10 | image_url https/thumbnail 여부 기반 proxy |
| item_specifics_score | 10 | 내 eBay item specifics 미연동 → `needs_data` |
| shipping_score | 10 | `shipping_usd` 기준 무료/저가/고가 배송 점수 |
| return_policy_score | 5 | return policy 미연동 → `needs_data` |
| price_position_score | 10 | competitorDashboard priceStatus winning/competitive/losing |
| sales_velocity_score | 10 | 최근 N일 `orders` 판매량 |
| competitor_gap_score | 10 | 경쟁가 gap 상태 |

불가능한 항목은 `null` 또는 `needs_data`로 처리한다.

## 리포트 섹션

- 오늘 개선 우선 SKU TOP 20
- 내가 더 싼데도 안 팔리는 SKU
- 내가 더 비싼데도 팔리는 SKU
- 제목 개선 필요 SKU
- Item Specific 보강 필요 SKU
- 이미지 보강 필요 SKU
- 배송/반품 조건 점검 SKU
- Dead stock 우선 처리 SKU
- 데이터 부족 SKU

## 구현 파일

신규:

- `src/services/hermesListingIntelligence.js`
- `docs/phase-3-listing-intelligence-plan.md`

수정:

- `scripts/hermes-market-intelligence.js`
- `src/web/routes/competitorSystem.js`
- `src/services/scheduler.js`
- `README.md`
- `docs/hermes-v1-market-intelligence-runbook.md`

## CLI

```bash
npm run hermes:market -- listing --days=30
npm run hermes:market -- listing --days=30 --telegram
```

## API

```text
POST /api/competitor-system/listing-intelligence/run
  body: { "days": 30, "sendTelegram": true }

GET /api/competitor-system/listing-intelligence/latest

GET /api/competitor-system/listing-intelligence/preview?days=30&limit=30
```

## Scheduler

- 매일 08:20 KST: `runListingIntelligence({ days: 30, sendTelegram: true })`
- Product Intelligence 08:10 이후 발송

## 저장/fallback

`daily_reports` 테이블이 있으면 `report_type='listing_intelligence'`로 저장한다.
테이블이 없거나 저장 실패 시에도 markdown 생성/Telegram 전송은 계속 가능하다.

## 다음 확장 후보

- eBay Inventory/Trading API read-only detail로 image count, item specifics, return policy 수집
- title keyword dictionary를 카테고리별로 분리
- 이미지 실제 해상도/배경/중복 여부 scoring
- SKU 상세보기 Telegram callback
- Opportunity Inbox 개선 task 자동 draft 생성
