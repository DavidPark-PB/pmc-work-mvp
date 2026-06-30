# Hermes Phase 2A — Market Agent v1

## 목적

Phase 2A의 목적은 SKU Context와 Signal Engine 결과를 기반으로 read-only market analysis를 생성하는 것이다.

Market Agent는 전체 SKU Context를 AI에 넘기지 않는다. 토큰 사용을 줄이기 위해 가격 판단에 필요한 signal과 숫자 필드만 전달한다.

- DB write 없음
- marketplace write API 호출 없음
- 가격 변경 없음
- 재고 변경 없음
- 가격 관련 signal이 없으면 AI 호출 없음

## 구현 위치

Agent:

```text
src/agents/marketAgent.js
```

CLI:

```text
scripts/hermes-agent.js
```

npm script:

```bash
npm run hermes:agent
```

## 실행 명령어

단일 SKU market analysis:

```bash
npm run hermes:agent -- market --sku=202551129453
```

## AI 호출 조건

Market Agent는 `buildSkuContext({ sku })` 결과를 입력으로 받는다.

다만 Claude API에는 아래 필드만 전달한다.

```json
{
  "signals": [],
  "current_price": 0,
  "lowest_competitor_price": 0,
  "price_gap_pct": 0
}
```

AI 호출은 아래 signal 중 하나가 있을 때만 수행한다.

- `competitor_lower_price`
- `price_attack`

위 signal이 없으면 Claude API를 호출하지 않고 rule-based 결과를 반환한다.

```json
{
  "recommendation": "hold",
  "source": "rule_based"
}
```

## Claude model

Phase 2A는 기존 `src/services/aiMatcher.js`의 Anthropic SDK 호출 패턴을 재사용한다.

사용 모델은 아래 하나로 고정한다.

```text
claude-haiku-4-5
```

새로운 인증 로직은 만들지 않는다. 기존 환경 변수 `ANTHROPIC_API_KEY`를 사용한다.

## 출력 형식

```json
{
  "sku": "202551129453",
  "market_analysis": {
    "price_position": "above_market",
    "competitor_count": 1,
    "lowest_competitor_price": 41.55,
    "price_gap_pct": 15.03,
    "recommendation": "lower_price",
    "reasoning": "Competitor pressure is significant, but any change requires human review.",
    "source": "ai"
  }
}
```

`source` 값:

- `rule_based`: 가격 관련 signal이 없어 AI 호출을 생략함
- `ai`: 가격 관련 signal이 있어 Claude Haiku 분석을 수행함

## 안전 원칙

- Market Agent는 analysis JSON만 출력한다.
- Market Agent는 DB insert/update/upsert/delete를 수행하지 않는다.
- Market Agent는 eBay/Shopify marketplace write API를 호출하지 않는다.
- Market Agent는 가격 또는 재고 값을 변경하지 않는다.
- AI에는 전체 SKU Context, title, raw_refs, competitor listing 배열을 전달하지 않는다.

## Validation

```bash
node --check src/agents/marketAgent.js
npm run hermes:agent -- market --sku=202551129453
git diff --stat
```

Rule-based path는 가격 관련 signal이 없는 context로 확인한다.

AI path는 `price_attack` 또는 `competitor_lower_price` signal이 있는 context에서만 실행된다.
