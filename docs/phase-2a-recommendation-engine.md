# Hermes Phase 2A — Recommendation Engine v1

## 목적

Phase 2A의 목적은 Phase 1B SKU Context와 Phase 1C Signal Engine output을 읽어, 사람이 검토할 수 있는 deterministic recommendation을 생성하는 것이다.

Hermes v2의 자동화 흐름은 Monitoring → Analysis → Recommendation → Human Approval → Limited Automation이다. Recommendation Engine v1은 Recommendation 단계의 첫 구현이며, 아직 Opportunity Inbox 저장, 가격 변경, 재고 변경, listing 수정, 자동 실행은 하지 않는다.

이번 단계는 검증 단계다.

- JSON 출력만 수행
- DB write 없음
- marketplace write API 호출 없음
- 가격/재고 변경 없음
- AI 호출 없음
- 자동 action 없음

## 구현 위치

엔진:

```text
src/engines/recommendationEngine.js
```

SKU Context 연동:

```text
src/services/skuContextBuilder.js
```

CLI:

```text
scripts/hermes-recommendations.js
```

npm script:

```bash
npm run hermes:recommendations
```

## Recommendation format

모든 recommendation은 아래 shape을 따른다.

```json
{
  "type": "...",
  "priority": "...",
  "reason": "...",
  "source_signals": ["..."],
  "suggested_action": "...",
  "requires_human_review": true,
  "created_at": "ISO8601"
}
```

`requires_human_review`는 v1에서 항상 `true`다. Recommendation Engine은 action을 실행하지 않고, 사람 검토용 제안만 만든다.

## 입력

Recommendation Engine v1은 SKU Context를 입력으로 받는다.

필수 전제:

1. SKU Context Builder가 context를 만든다.
2. Signal Engine이 `context.signals`를 채운다.
3. Recommendation Engine이 `context.signals`를 읽어 `context.recommendations`를 만든다.

Recommendation Engine은 signal을 새로 생성하지 않는다.

## Required recommendation types

### restock_review

source signal:

- `stock_risk`

재고 부족/품절 위험이 있을 때 생성한다. 재고 보충 검토가 필요하지만, 실제 발주/재고 변경은 하지 않는다.

### dead_stock_review

source signals:

- `dead_stock`
- `no_recent_sales`

재고가 있는데 최근 판매가 없거나, 최근 판매 없음 signal만 있을 때 생성한다. 판매 부진, listing 개선, promotion/clearance 검토를 제안한다.

### listing_quality_review

source signal:

- `listing_quality_low`

listing title/status/price 등 기본 품질이 낮을 때 생성한다. listing 개선안을 사람이 검토하도록 제안한다.

### price_or_margin_review

source signals:

- `price_attack`
- `competitor_lower_price`
- `missing_cost`

가격 경쟁 압력 또는 원가 데이터 누락 때문에 가격/마진 검토가 필요할 때 생성한다. 가격 변경은 자동으로 수행하지 않는다.

### cost_data_required

source signal:

- `missing_cost`

원가/마진 데이터가 없어 margin-aware 판단이 불가능할 때 생성한다.

### competition_watch

source signal:

- `competitor_lower_price`

경쟁 listing이 현재 가격보다 낮을 때 생성한다. 경쟁 상품 매칭 정확도와 total price를 검토하도록 제안한다.

### urgent_price_attack_review

source signals:

- `price_attack`
- optionally `competitor_lower_price`

큰 가격 격차 또는 다수의 낮은 경쟁 listing이 감지될 때 생성한다. 긴급 검토가 필요하지만, 사람 승인 전 자동 가격 변경은 금지한다.

## SKU Context Builder 연동

`src/services/skuContextBuilder.js`는 context 생성 후 다음 순서로 분석 결과를 붙인다.

```js
context.signals = generateSignals(context);
context.recommendations = generateRecommendations(context);
```

즉:

- Signal Engine은 signal 판정 담당
- Recommendation Engine은 signal 기반 recommendation 작성 담당
- SKU Context Builder는 SKU 중심 JSON 조립 담당

## 실행 명령어

단일 SKU recommendations:

```bash
npm run hermes:recommendations -- --sku=202551129453
```

샘플 recommendations:

```bash
npm run hermes:recommendations -- sample --limit=5
```

출력 예시:

```json
{
  "sku": "202551129453",
  "recommendations": [
    {
      "type": "cost_data_required",
      "priority": "medium",
      "reason": "Cost or margin data is missing, so margin-aware recommendations cannot be trusted yet.",
      "source_signals": ["missing_cost"],
      "suggested_action": "Add or verify SKU cost data before approving price, margin, or promotion decisions.",
      "requires_human_review": true,
      "created_at": "2026-06-30T00:00:00.000Z"
    }
  ],
  "recommendation_count": 1,
  "signals": [],
  "signal_count": 0,
  "raw_refs": {}
}
```

## 안전 원칙

- Recommendation Engine consumes `context.signals`; it does not generate signals.
- Recommendation Engine is pure rule-based code.
- Recommendation Engine does not import AI SDK/API modules.
- Recommendation Engine does not import DB clients.
- Recommendation Engine does not import marketplace connectors/APIs.
- Recommendation Engine only creates JSON recommendations.
- No DB writes.
- No marketplace writes.
- No automatic actions.
- Human approval is required for every recommendation.

## Validation

```bash
node --check src/engines/recommendationEngine.js
node --check src/services/skuContextBuilder.js
node --check scripts/hermes-recommendations.js
npm run hermes:recommendations -- --sku=202551129453
npm run hermes:recommendations -- sample --limit=5
git diff --stat
```
