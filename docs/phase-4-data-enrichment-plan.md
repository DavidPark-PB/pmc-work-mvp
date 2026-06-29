# Hermes v1 Phase 4 — Listing Data Enrichment Plan

## 목표

Listing Intelligence의 `needs_data` 항목을 줄이기 위해 내 eBay listing detail을 read-only로 수집해 DB에 캐시한다.

안전 정책:

- eBay marketplace write API 호출 금지
- 가격 변경/수량 변경/리스팅 수정 금지
- Telegram 가격 승인 버튼 금지
- 저장 대상은 내부 Supabase enrichment cache만 해당

## 현재 테이블 필드 점검

### `ebay_products`

현재 확인된 기본 필드:

- `sku`
- `item_id`
- `title`
- `price_usd`
- `shipping_usd`
- `sales_count`
- `stock`
- `status`
- `fee_rate`
- `image_url`
- `created_at`
- `updated_at`

부족한 detail 필드:

- `item_specifics`
- `image_count`
- `image_urls`
- `return_policy`
- `shipping_policy`
- `handling_time`
- `estimated_delivery`
- `category_id`
- `category_name`
- `condition`
- `sold_quantity` 별도 detail cache
- `watch_count`
- `view_count`
- `promotion_status`

### `competitor_listings`

현재 확인된 필드:

- `seller_id`
- `ebay_item_id`
- `title`
- `price`
- `shipping`
- `total_price`
- `quantity`
- `sold`
- `image_url`
- `url`
- `category`
- `item_specifics`
- `status`
- `first_seen`
- `last_seen`

부족하거나 세분화되지 않은 detail 필드:

- `image_count`
- `image_urls`
- `return_policy`
- `shipping_policy`
- `handling_time`
- `estimated_delivery`
- `category_id`
- `category_name`
- `condition`
- `watch_count`
- `view_count`
- `promotion_status`

## 저장 구조 선택

기존 `ebay_products`를 직접 확장하지 않고 additive cache table을 추가한다.

이유:

1. 운영 동기화 테이블과 분석 cache를 분리해 안전하다.
2. migration rollback이 쉽다.
3. 내 listing과 경쟁 listing을 같은 구조로 확장 가능하다.
4. marketplace write workflow를 만들지 않는다.

Migration:

- `supabase/migrations/059_hermes_listing_enrichment.sql`

테이블:

- `listing_details`: category/condition/sold/watch/view/image_count/handling/promotion/raw cache
- `listing_images`: image URL 목록
- `listing_item_specifics`: item specifics key-value
- `listing_policies`: return/shipping/payment policy cache
- `listing_enrichment_errors`: 실패 로그

## 사용 API

현재 프로젝트에서 확인된 사용 가능 API:

- Trading API: `src/api/ebayAPI.js`의 `callTradingAPI()`
- Trading API read method: `GetMyeBaySelling`, `GetSellerTransactions`, `GetOrders`, `GetSuggestedCategories`
- Shopping API: `callShoppingAPI()`, `GetSingleItem`, `GetMultipleItems`
- Browse API: `_fetchViaBrowseAPI()`, seller search fallback

Phase 4 1차 구현은 내 listing detail에 가장 적합한 Trading API `GetItem`을 사용한다.

수집 필드:

- ItemSpecifics → `listing_item_specifics`
- PictureDetails/PictureURL → `listing_images`, `listing_details.image_count`
- ReturnPolicy → `listing_policies.return_policy`
- ShippingDetails/DispatchTimeMax → `listing_policies.shipping_policy`, `handling_time`
- PrimaryCategory → `category_id`, `category_name`
- ConditionID/ConditionDisplayName → condition fields
- SellingStatus/QuantitySold → `sold_quantity`
- WatchCount/HitCount → 있으면 저장, 없으면 null

## CLI

```bash
npm run hermes:market -- enrich-listings --limit=50
npm run hermes:market -- enrich-listings --sku=<SKU>
npm run hermes:market -- enrich-listings --missing-only
```

`--missing-only`는 `listing_details`에 없는 item만 우선 수집한다. Migration 059가 아직 적용되지 않았으면 필터/저장이 실패할 수 있으나, 명령은 실패 항목을 summary로 출력한다.

## Listing Intelligence 연동

`src/services/hermesListingIntelligence.js`는 enrichment cache를 읽어 아래 점수를 실제 데이터로 계산한다.

- `item_specifics_score`
- `image_count_score`
- `return_policy_score`
- `shipping_score`
- `category_score`

Enrichment cache가 없으면 기존처럼 `needs_data` 또는 partial로 fallback한다.

## Rate limit / retry

- item별 2회 retry
- 기본 item 간 delay 400ms
- 실패는 `listing_enrichment_errors`에 저장 시도
- API 실패가 있어도 전체 배치를 중단하지 않고 다음 item 진행

## 검증

```bash
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js

npm run hermes:market -- enrich-listings --limit=5
npm run hermes:market -- listing --days=30
```

금지 패턴 확인:

```bash
grep -RIn "updateItem(.*price\|ReviseFixedPriceItem\|ReviseInventoryStatus\|runAutoRepricer(false)\|pipeline:run_live\|reprice:approve" \
  src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js
```
