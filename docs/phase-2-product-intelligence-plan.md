# Hermes v1 Phase 2 — Product Intelligence Plan

## 목표

Phase 1 Market Intelligence가 경쟁셀러/가격/배송/재고 변화를 감시했다면, Phase 2 Product Intelligence는 내부 상품 포트폴리오를 SKU 단위로 분석해 “무엇을 더 밀고, 무엇을 고치고, 무엇을 보류할지”를 추천한다.

Hermes v1 정책은 그대로 유지한다.

- eBay 가격 변경 API 호출 없음
- marketplace write 없음
- Telegram 버튼은 상세보기/리포트 중심
- 실행 결과는 분석/추천/보고서만 제공

## 입력 데이터

우선순위 순서:

1. `ebay_products`: 내 eBay 리스팅 snapshot
2. `orders`: 최근 30일 판매/매출 집계
3. `competitorDashboard`: 기존 `product_matches` + `competitor_listings` 기반 경쟁가 상태
4. `sku_scores`: 있으면 기존 SKU score/classification 참조
5. `daily_reports`: 테이블이 있으면 report 저장, 없으면 markdown fallback만 출력

## 산출물

`Product Intelligence Report` markdown:

- 포트폴리오 요약
- 확장 후보 SKU
- 리스팅 품질 점검 후보
- 가격/마진 검토 후보
- 재고 리스크 SKU
- Dead stock / 보류 후보
- 데이터 보강 필요 SKU

## 분류 기준 v0

| 분류 | 기준 | 추천 |
|---|---|---|
| scale_candidate | 최근 30일 판매 > 0, 경쟁가 winning/competitive, 재고 있음 | 재고/광고/노출 확대 후보 |
| listing_quality_candidate | 최근 30일 판매 0, 경쟁가 winning/competitive | 가격보다 타이틀/이미지/키워드 점검 |
| price_or_margin_review | 경쟁가 losing | 자동 인하 금지, 마진/원가 확인 후 판단 |
| stock_risk | 최근 30일 판매 > 0, 재고 2개 이하 | 재입고/소싱 검토 |
| dead_stock_candidate | 재고 있음, 최근 30일 판매 0, 경쟁력 낮음 | bundle/콘텐츠/보류 검토 |
| data_gap | title/price/sku 등 핵심 데이터 부족 | 데이터 보강 |

## 구현 범위

이번 Phase 2 MVP는 read-only report generator다.

추가 파일:

- `src/services/hermesProductIntelligence.js`

수정 파일:

- `scripts/hermes-market-intelligence.js`: `product` command 추가
- `src/web/routes/competitorSystem.js`: Product Intelligence API 추가
- `src/services/scheduler.js`: 08:10 KST daily Product Intelligence schedule 추가
- `README.md`: Product Intelligence 실행 절차 추가

명령어:

```bash
npm run hermes:market -- product --days=30
npm run hermes:market -- product --days=30 --telegram
```

API:

```text
POST /api/competitor-system/product-intelligence/run
  body: { "days": 30, "sendTelegram": true }

GET /api/competitor-system/product-intelligence/latest

GET /api/competitor-system/product-intelligence/preview?days=30&limit=30
```

스케줄:

- 매일 08:10 KST: `runProductIntelligence({ days: 30, sendTelegram: true })`

## 저장/fallback

`daily_reports` 테이블이 있으면 `report_type='product_intelligence'` 로 upsert한다.
Migration 058 적용 전처럼 `daily_reports`가 없거나 저장이 실패해도 markdown 생성은 계속된다.

## 다음 확장 후보

- SKU별 COGS/실마진 연결
- 판매 채널별 전환율/노출 데이터 연결
- 이미지 품질/타이틀 keyword score
- Opportunity Inbox 자동 draft 생성
- Telegram에서 SKU 상세보기 callback 연결
