# Hermes Phase 1C — Signal Engine v1

## 목적

Phase 1C의 목적은 Phase 1B SKU Context를 deterministic rule-based signal로 변환하는 것이다.

Hermes v2는 Monitoring → Analysis → Recommendation → Human Approval → Limited Automation 순서로 진화해야 한다. Signal Engine v1은 Analysis 계층의 첫 단계이며, 아직 업무 생성/가격 변경/재고 변경을 수행하지 않는다.

이번 단계는 검증 단계다.

- JSON 출력만 수행
- DB write 없음
- marketplace write API 호출 없음
- 가격/재고 변경 없음
- AI 호출 없음
- Opportunity Inbox 생성 없음

## 구현 위치

엔진:

```text
src/engines/signalEngine.js
```

SKU Context 연동:

```text
src/services/skuContextBuilder.js
```

CLI:

```text
scripts/hermes-signals.js
```

npm script:

```bash
npm run hermes:signals
```

## Signal format

모든 signal은 아래 shape을 따른다.

```json
{
  "type": "...",
  "severity": "...",
  "value": {},
  "detected_at": "ISO8601"
}
```

`detected_at`은 Signal Engine이 실행된 시점의 ISO8601 timestamp다.

## Required signal types

Signal Engine v1은 앱 로직 안에서 AI 호출 없이 아래 signal type을 생성한다.

### stock_risk

재고가 없거나 낮을 때 생성한다.

- `available_quantity <= 0`: `critical`
- `available_quantity <= 2`: `warning`

### dead_stock

재고가 있는데 최근 30일 주문이 없을 때 생성한다.

조건:

- `available_quantity > 0`
- `orders_30d === 0`

### no_recent_sales

최근 30일 주문이 없을 때 생성한다.

조건:

- `orders_30d === 0`

### competitor_lower_price

매핑된 active competitor listing 중 total price가 현재 eBay 가격보다 낮을 때 생성한다.

조건:

- `pricing.current_price > 0`
- competitor `total_price > 0`
- competitor `total_price < current_price`

### price_attack

경쟁 가격 하락 폭이 크거나 낮은 경쟁 listing이 여러 개 있을 때 생성한다.

조건 중 하나:

- 최저 competitor total price가 현재 가격보다 15% 이상 낮음
- 현재 가격보다 낮은 competitor listing이 3개 이상

### missing_cost

원가/마진 데이터가 연결되지 않았을 때 생성한다.

조건:

- `pricing.needs_cost_data === true`, 또는
- `pricing.estimated_margin_pct == null`

### listing_quality_low

기본 listing 품질 점수가 낮을 때 생성한다.

v1 점수는 SKU Context에 있는 eBay listing 필드만 사용한다.

감점 예시:

- listing id 없음
- title 없음
- title 길이가 짧음
- price 없음 또는 0
- listing status가 ended

점수가 70 미만이면 signal을 생성한다.

## SKU Context Builder 연동

Phase 1B의 `skuContextBuilder` 안에 있던 inline signal 생성 로직을 제거하고, `src/engines/signalEngine.js`의 `generateSignals(context)` 출력으로 `context.signals`를 채운다.

이로써 SKU Context Builder는 context 조립을 담당하고, Signal Engine은 signal 판정을 담당한다.

## 실행 명령어

단일 SKU signals:

```bash
npm run hermes:signals -- --sku=202551129453
```

샘플 signals:

```bash
npm run hermes:signals -- sample --limit=5
```

출력 예시:

```json
{
  "sku": "202551129453",
  "signals": [
    {
      "type": "missing_cost",
      "severity": "info",
      "value": {
        "needs_cost_data": true,
        "estimated_margin_pct": null
      },
      "detected_at": "2026-06-30T00:00:00.000Z"
    }
  ],
  "signal_count": 1,
  "raw_refs": {}
}
```

## 안전 원칙

- Signal Engine은 pure rule-based code다.
- Signal Engine은 AI SDK/API를 import하지 않는다.
- Signal Engine은 DB client를 import하지 않는다.
- Signal Engine은 marketplace connector/API를 import하지 않는다.
- Signal CLI는 SKU Context Builder를 읽고 JSON을 출력한다.
- 저장, 가격 변경, 재고 변경, listing 수정은 하지 않는다.

## Validation

```bash
node --check src/engines/signalEngine.js
node --check src/services/skuContextBuilder.js
node --check scripts/hermes-signals.js
npm run hermes:signals -- --sku=202551129453
npm run hermes:signals -- sample --limit=5
git diff --stat
```
