# Hermes Phase 1A — Platform Sync / eBay Connector

## 목적

Phase 1A의 목적은 기존 eBay 연동을 새로 만들지 않고, 기존 인증/조회 코드를 재사용해 Hermes가 플랫폼 데이터를 공통 Canonical Model JSON으로 읽을 수 있는 첫 번째 Platform Connector 구조를 만드는 것이다.

이번 단계는 read-only 검증 단계다.

- DB write 없음
- marketplace write API 호출 없음
- 가격/재고 변경 없음
- JSON 출력으로 Canonical Model shape 검증 우선

## Connector 위치

Connector 위치는 `src/connectors/ebay/index.js`로 결정했다.

이유:

1. 기존 `src/api/ebayAPI.js`는 eBay API low-level wrapper 역할을 이미 하고 있다.
2. 기존 `src/services/productSync.js`, `src/services/orderSync.js`는 DB/Google Sheets 저장까지 포함한 운영 sync 서비스다.
3. Hermes v2 Platform Sync는 플랫폼별 데이터를 동일한 Canonical Model로 변환하는 adapter layer가 필요하다.
4. 따라서 `src/connectors/<platform>/index.js` 구조로 두면 Shopify/Naver/Shopee/Coupang/Qoo10 connector를 같은 패턴으로 확장하기 쉽다.

## 기존 인증 재사용 방식

새 인증 로직은 만들지 않는다.

`src/connectors/ebay/index.js`는 `src/api/ebayAPI.js`의 `EbayAPI` class만 사용한다.

기존 인증 흐름:

1. `EbayAPI` constructor가 env seed 값을 읽는다.
   - `EBAY_APP_ID`
   - `EBAY_CERT_ID`
   - `EBAY_DEV_ID`
   - `EBAY_USER_TOKEN`
   - `EBAY_REFRESH_TOKEN`
2. 실제 API 호출 직전 `_ensureToken()`이 `tokenStore.loadToken('ebay')`를 호출한다.
3. `tokenStore`는 Supabase `platform_tokens` 테이블에서 eBay access/refresh token을 로드한다.
4. Trading API 호출 중 토큰 만료/무효가 감지되면 `refreshAccessToken()`이 refresh token으로 갱신한다.
5. 갱신된 token은 `tokenStore.saveToken('ebay', ...)`로 다시 `platform_tokens`에 저장된다.

Phase 1A connector는 이 흐름을 그대로 재사용한다.

## 사용 중인 기존 eBay read API

### Products / Inventory

`syncProducts()`와 `syncInventory()`는 기존 `EbayAPI.getActiveListings()`를 사용한다.

내부 API:

- Trading API `GetMyeBaySelling`
- ActiveList
- DetailLevel `ReturnAll`

### Orders

`syncOrders({ days })`는 기존 `EbayAPI.getSellerTransactions(days)`를 사용한다.

내부 API:

- Trading API `GetSellerTransactions`
- `ModTimeFrom` / `ModTimeTo`
- `IncludeContainingOrder=true`
- days는 eBay 제한에 맞춰 최대 30일로 제한한다.

## Canonical Model 정의

### canonical_products

```json
{
  "platform": "ebay",
  "platform_listing_id": "...",
  "internal_sku": "...",
  "title": "...",
  "price": 0,
  "currency": "USD",
  "status": "...",
  "raw": {}
}
```

Mapping:

- `platform`: 고정값 `ebay`
- `platform_listing_id`: eBay ItemID
- `internal_sku`: eBay SKU, 없으면 ItemID fallback
- `title`: listing title
- `price`: current price
- `currency`: 현재 기존 parser에 currency가 없으면 `USD`
- `status`: active/out_of_stock/ended normalize
- `raw`: 기존 eBay parser 결과 원본

### canonical_orders

```json
{
  "platform": "ebay",
  "platform_order_id": "...",
  "internal_sku": "...",
  "quantity": 0,
  "sold_price": 0,
  "currency": "USD",
  "buyer_country": "...",
  "ordered_at": "...",
  "raw": {}
}
```

Mapping:

- `platform_order_id`: eBay OrderID, 없으면 TransactionID fallback
- `internal_sku`: transaction SKU
- `quantity`: QuantityPurchased
- `sold_price`: TransactionPrice
- `currency`: 현재 기존 parser에 currency가 없으면 `USD`
- `buyer_country`: ShippingAddress.Country
- `ordered_at`: Transaction CreatedDate
- `raw`: transaction parser 결과. 단, CLI 출력에서 불필요한 PII 노출을 피하기 위해 buyer/user/email/name/address/phone 필드는 `[redacted]`로 마스킹한다.

### canonical_inventory

```json
{
  "platform": "ebay",
  "platform_listing_id": "...",
  "internal_sku": "...",
  "available_quantity": 0,
  "sold_quantity": 0,
  "stock_status": "...",
  "raw": {}
}
```

Mapping:

- `available_quantity`: ActiveList Quantity
- `sold_quantity`: ActiveList QuantitySold
- `stock_status`: quantity/status 기반 `in_stock`, `out_of_stock`, `active`, `ended`
- `raw`: 기존 eBay parser 결과 원본

## 실행 명령어

```bash
npm run hermes:sync -- ebay products
npm run hermes:sync -- ebay products --limit=5

npm run hermes:sync -- ebay orders --days=30
npm run hermes:sync -- ebay orders --days=30 --limit=5

npm run hermes:sync -- ebay inventory
npm run hermes:sync -- ebay inventory --limit=5

npm run hermes:sync -- ebay all
npm run hermes:sync -- ebay all --days=30 --limit=5
```

출력은 JSON이다.

```json
{
  "platform": "ebay",
  "resource": "products",
  "count": 5,
  "data": []
}
```

`all`은 다음 구조를 출력한다.

```json
{
  "platform": "ebay",
  "resource": "all",
  "data": {
    "products": [],
    "orders": [],
    "inventory": []
  }
}
```

## 저장 설계 제안

Phase 1A에서는 저장하지 않는다.

후속 단계에서 DB 저장이 필요하면 새 canonical mirror table을 추가하는 방식이 안전하다.

예시:

- `canonical_products`
- `canonical_orders`
- `canonical_inventory`
- 또는 단일 `platform_sync_snapshots` 테이블

권장 컬럼:

- `platform`
- `resource_type`
- `platform_id`
- `internal_sku`
- `canonical_payload jsonb`
- `raw_payload jsonb` (주문 raw는 저장 전 PII redaction 필수)
- `synced_at`
- unique key: `(platform, resource_type, platform_id)`

기존 운영 테이블인 `ebay_products`, `orders`, `sku_master`, `sku_listing_link`, `inventory_purchases`는 Phase 1A에서 수정하지 않는다.

## 다음 플랫폼 확장 방식

동일한 구조를 플랫폼별로 추가한다.

```text
src/connectors/ebay/index.js
src/connectors/shopify/index.js
src/connectors/naver/index.js
src/connectors/shopee/index.js
src/connectors/coupang/index.js
src/connectors/qoo10/index.js
```

각 connector는 다음 함수를 제공한다.

```js
async function syncProducts(options = {}) {}
async function syncOrders({ days = 30 } = {}) {}
async function syncInventory(options = {}) {}
```

Hermes v2에서는 이 connector layer 위에 `Platform Sync Orchestrator`를 두고, 모든 플랫폼 데이터를 SKU 중심 context로 합치는 방향이 적합하다.

## 안전 원칙

- 기존 `EbayAPI` 인증/토큰 갱신 재사용
- `tokenStore` 재사용
- `GetMyeBaySelling`, `GetSellerTransactions` 등 read API만 사용
- `ReviseInventoryStatus`, `ReviseFixedPriceItem`, `AddFixedPriceItem`, `EndFixedPriceItem` 호출 금지
- Phase 1A는 JSON 출력/검증만 수행
