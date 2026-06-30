# Hermes Phase 2B — Opportunity Candidate Builder v1

## 목적

Phase 2B의 목적은 SKU Context, Signal Engine output, Recommendation Engine output, Market Agent-style analysis를 읽어 사람이 검토할 수 있는 Opportunity Candidate JSON을 생성하는 것이다.

Hermes v2 자동화 흐름은 Monitoring → Analysis → Recommendation → Human Approval → Limited Automation이다. Opportunity Candidate Builder v1은 Recommendation 결과를 Opportunity Inbox에 넣기 전의 후보 객체로 변환하는 단계다.

이번 단계는 검증 단계다.

- JSON 출력만 수행
- DB write 없음
- marketplace write API 호출 없음
- 가격/재고/listing 변경 없음
- AI 호출 없음
- 자동 action 없음
- Opportunity Inbox 저장 없음

## 구현 위치

Agent:

```text
src/agents/opportunityAgent.js
```

CLI:

```text
scripts/hermes-agent.js
```

npm script:

```bash
npm run hermes:agent -- opportunity --sku=<SKU>
```

## 입력

Opportunity Candidate Builder v1은 아래 데이터를 입력으로 사용한다.

1. `buildSkuContext({ sku })` 결과
2. `context.signals`
3. `context.recommendations`
4. Market Agent output 또는 Market Agent-style rule-based summary

중요: v1 CLI는 AI를 호출하지 않는다. Market Agent가 price signal에서 AI를 호출할 수 있으므로, Opportunity Agent CLI는 `runMarketAgent()`를 호출하지 않고 `extractMarketFacts()` 기반의 rule-based market summary만 만든다.

또한 CLI 경로는 `buildSkuContext({ sku, readOnly: true })`를 사용한다. 이 모드에서는 eBay connector sync를 건너뛰고 DB mirror read fallback만 사용한다. 읽기 전용 분석 중 OAuth token refresh가 발생해 `platform_tokens`에 저장되는 일을 막기 위한 가드다.

## Candidate format

모든 candidate는 아래 shape을 따른다.

```json
{
  "sku": "...",
  "type": "...",
  "priority": "...",
  "title": "...",
  "reason": "...",
  "source_signals": [],
  "source_recommendations": [],
  "market_analysis": {},
  "requires_human_review": true,
  "created_at": "ISO8601"
}
```

`requires_human_review`는 v1에서 항상 `true`다. Candidate Builder는 action을 실행하지 않고, 사람 검토용 후보만 만든다.

## Recommendation → Opportunity mapping

| Recommendation type | Opportunity candidate type |
| --- | --- |
| `restock_review` | `inventory_restock_review` |
| `dead_stock_review` | `dead_stock_review` |
| `listing_quality_review` | `listing_quality_review` |
| `price_or_margin_review` | `price_or_margin_review` |
| `cost_data_required` | `cost_data_completion` |
| `competition_watch` | `competition_watch` |
| `urgent_price_attack_review` | `urgent_price_attack_review` |

Recommendation이 있으면 candidate는 recommendation을 source로 삼는다.

예외 fallback:

- `price_attack` signal이 있는데 `urgent_price_attack_review` recommendation이 없으면 urgent candidate를 만든다.
- `competitor_lower_price` signal이 있는데 `competition_watch` recommendation이 없으면 competition watch candidate를 만든다.

## Market analysis

`market_analysis`는 Market Agent output의 `market_analysis` 객체를 그대로 받을 수 있다.

CLI 경로에서는 AI 호출을 피하기 위해 rule-based summary를 생성한다.

예시:

```json
{
  "price_position": "above_market",
  "competitor_count": 2,
  "lowest_competitor_price": 19.99,
  "price_gap_pct": 15.2,
  "recommendation": "hold",
  "reasoning": "Price signal exists, but Opportunity Candidate Builder v1 does not call AI. Human review is required.",
  "source": "rule_based_no_ai"
}
```

## 실행 명령어

단일 SKU opportunity candidates:

```bash
npm run hermes:agent -- opportunity --sku=202551129453
```

출력 예시:

```json
{
  "sku": "202551129453",
  "count": 3,
  "candidates": [
    {
      "sku": "202551129453",
      "type": "cost_data_completion",
      "priority": "medium",
      "title": "Cost data required for SKU 202551129453",
      "reason": "Cost or margin data is missing, so margin-aware recommendations cannot be trusted yet.",
      "source_signals": ["missing_cost"],
      "source_recommendations": ["cost_data_required"],
      "market_analysis": {},
      "requires_human_review": true,
      "created_at": "2026-06-30T00:00:00.000Z"
    }
  ],
  "context_summary": {
    "signal_count": 3,
    "recommendation_count": 3,
    "raw_refs": {}
  }
}
```

## Safety rules

- Opportunity Agent generates candidates in code.
- Opportunity Agent does not call AI.
- Opportunity Agent does not generate signals.
- Opportunity Agent does not generate recommendations.
- Opportunity Agent does not import DB clients.
- Opportunity Agent does not import marketplace connectors/APIs.
- Opportunity Agent performs no DB writes.
- Opportunity Agent performs no marketplace writes.
- Opportunity Agent performs no price, inventory, or listing changes.
- Opportunity Agent performs no automatic actions.
- Every candidate requires human review.

## Validation

```bash
node --check src/agents/opportunityAgent.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- opportunity --sku=202551129453
# sample fixture with price_attack via generateOpportunityCandidates(...)
git diff --stat
```
