# Hermes Phase 1B — SKU Context Builder v1

## 목적

Phase 1B의 목적은 Phase 1A eBay Connector가 만든 canonical JSON을 SKU 중심의 단일 context로 합치는 것이다.

Hermes v2에서 모든 분석/추천/업무 생성의 기준은 플랫폼 listing이 아니라 내부 SKU여야 한다. SKU Context Builder v1은 그 첫 번째 read-only context layer다.

이번 단계는 검증 단계다.

- JSON 출력만 수행
- DB write 없음
- marketplace write API 호출 없음
- 가격/재고 변경 없음
- Opportunity Inbox 생성 없음

## 구현 위치

서비스:

```text
src/services/skuContextBuilder.js
```

CLI:

```text
scripts/hermes-context.js
```

npm script:

```bash
npm run hermes:context
```

## 필수 함수

```js
async function buildSkuContext({ sku }) {}
function buildSkuContextFromCanonical({ sku, products, orders, inventory }) {}
async function buildSkuContexts({ limit }) {}
```

### buildSkuContextFromCanonical

순수 변환 함수다.

입력:

- `sku`
- canonical products
- canonical orders
- canonical inventory
- optional competitors

출력:

- SKU Context v1 JSON

### buildSkuContext

단일 SKU용 함수다.

동작 순서:

1. eBay Connector에서 read-only canonical snapshot을 가져온다.
   - `syncAll({ days: 30, limit: 200 })`
2. 해당 SKU가 connector snapshot 안에 있으면 connector 결과로 context를 만든다.
3. 없으면 기존 DB mirror table을 read-only fallback으로 조회한다.
   - `ebay_products`
   - `orders`
   - `product_matches`
   - `competitor_listings`
4. 저장하지 않고 JSON만 반환한다.

### buildSkuContexts

샘플 context 생성용 함수다.

동작:

1. eBay Connector에서 `limit`개 canonical products/orders/inventory를 가져온다.
2. canonical products의 SKU 목록을 기준으로 context 배열을 만든다.
3. 저장하지 않고 JSON만 반환한다.

## 입력 데이터

### Primary input — eBay Connector canonical output

Phase 1A의 `src/connectors/ebay/index.js`를 사용한다.

- `syncProducts()`
- `syncOrders({ days: 30 })`
- `syncInventory()`
- `syncAll({ days: 30, limit })`

이 connector는 기존 `src/api/ebayAPI.js`와 `src/services/tokenStore.js` 인증 흐름을 재사용한다.

사용되는 eBay read API:

- `GetMyeBaySelling`
- `GetSellerTransactions`

### DB fallback input

단일 SKU 조회에서 connector snapshot에 SKU가 없을 경우 기존 DB mirror table을 읽는다.

#### ebay_products

사용 컬럼 예시:

- `sku`
- `item_id`
- `title`
- `price_usd`
- `sales_count`
- `stock`
- `ebay_api_stock`가 있으면 우선 사용
- `status`

#### orders

사용 컬럼 예시:

- `order_no`
- `platform`
- `sku`
- `quantity`
- `payment_amount`
- `currency`
- `country`
- `country_code`
- `status`
- `order_date`

`orders`는 최근 30일만 집계한다.

#### product_matches

사용 컬럼 예시:

- `our_sku`
- `our_item_id`
- `competitor_item_id`
- `seller_id`
- `confidence`
- `status`

`approved`, `pending` mapping을 읽는다.

#### competitor_listings

사용 컬럼 예시:

- `seller_id`
- `ebay_item_id`
- `title`
- `price`
- `shipping`
- `total_price`
- `quantity`
- `sold`
- `status`
- `last_seen`

## 출력 JSON 스펙

```json
{
  "sku": "...",
  "platforms": {
    "ebay": {
      "listing_id": "...",
      "title": "...",
      "price": 0,
      "currency": "USD",
      "status": "active",
      "available_quantity": 0,
      "sold_quantity": 0
    }
  },
  "sales": {
    "orders_30d": 0,
    "units_30d": 0,
    "revenue_30d": 0
  },
  "inventory": {
    "total_available": 0,
    "stock_status": "in_stock"
  },
  "pricing": {
    "current_price": 0,
    "estimated_margin_pct": null,
    "needs_cost_data": true
  },
  "competitors": [],
  "signals": [],
  "raw_refs": {}
}
```

## signals v1

현재 v1은 최소 신호만 만든다.

예시:

- `missing_listing`
- `stock_risk`
- `no_recent_sales`
- `needs_cost_data`
- `competitor_lower_price`

signals는 아직 업무를 만들지 않는다. 후속 단계에서 Opportunity Inbox와 연결한다.

## 실행 명령어

단일 SKU context:

```bash
npm run hermes:context -- sku <SKU>
```

예시:

```bash
npm run hermes:context -- sku 202551129453
```

샘플 context:

```bash
npm run hermes:context -- sample --limit=5
```

## 현재 v1 한계

1. eBay 중심이다.
   - Shopify/Naver/Shopee/Coupang/Qoo10 context는 아직 없다.

2. 내부 원가 데이터가 아직 연결되지 않았다.
   - `estimated_margin_pct`는 `null`
   - `needs_cost_data`는 `true`

3. connector snapshot은 안전을 위해 limit 기반이다.
   - 단일 SKU가 connector snapshot에 없으면 DB fallback을 사용한다.

4. 주문 데이터는 SKU가 비어 있으면 SKU context에 붙지 않는다.
   - eBay listing 중 SKU가 비어 있는 데이터는 ItemID fallback을 사용한다.

5. competitor data는 DB fallback에서만 붙는다.
   - Phase 1A canonical model에는 competitor canonical stream이 아직 없다.

6. 저장하지 않는다.
   - Phase 1B는 JSON shape 검증 단계다.

## 다음 단계 — Opportunity Inbox 연결 방식

Phase 1C 또는 v2 확장에서는 SKU Context를 Opportunity Inbox 후보로 변환한다.

예시 mapping:

- `stock_risk` → 재고/발주 검토 Opportunity
- `no_recent_sales` → Dead stock / listing 개선 Opportunity
- `needs_cost_data` → 원가 데이터 보강 Task
- `competitor_lower_price` → 가격/리스팅 경쟁력 검토 Opportunity
- `missing_listing` → 플랫폼 listing 연결/매핑 Task

권장 흐름:

1. SKU Context Builder가 SKU별 context를 만든다.
2. Rule-based Opportunity Detector가 context.signals를 읽는다.
3. 중복 방지 key를 만든다.
4. Opportunity Inbox에 후보를 생성한다.
5. 사장님 승인 후에만 task/draft/automation으로 넘어간다.

## 안전 원칙

- `skuContextBuilder`는 DB read만 수행한다.
- `insert`, `update`, `upsert`, `delete`를 호출하지 않는다.
- eBay Connector의 read-only API만 사용한다.
- `ReviseInventoryStatus`, `ReviseFixedPriceItem`, `AddFixedPriceItem`, `EndFixedPriceItem` 호출 금지.
- 가격/재고 변경 금지.
