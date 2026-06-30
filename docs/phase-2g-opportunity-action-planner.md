# Hermes Phase 2G — Opportunity Action Planner v1

## 목적

Phase 2G의 목적은 approved 상태의 Hermes-generated Opportunity를 실행 가능한 변경이 아니라 사람이 검토할 action plan JSON으로 변환하는 것이다.

이 단계는 planner이며 executor가 아니다. 어떤 DB write, marketplace write, 가격 변경, 재고 변경, listing 변경도 수행하지 않는다.

## 안전 원칙

- approved Hermes-generated opportunity만 읽는다.
- DB write 없음.
- AI 호출 없음.
- marketplace API 호출 없음.
- 가격, 재고, listing 변경 없음.
- action을 실행하지 않는다.
- `approved`는 Opportunity Inbox에서 human reviewed 상태라는 의미일 뿐 marketplace 실행 승인이 아니다.

## 구현 위치

Service:

```text
src/services/opportunityInbox.js
```

CLI:

```text
scripts/hermes-agent.js
```

## Service function

```js
buildHermesOpportunityActionPlan({ id })
```

Rules:

- target row must have `metadata.hermes_generated = true`.
- target row must have `status = approved`.
- plan is generated entirely in code.
- no AI or external service is called.
- plan includes explicit `forbidden_actions`.

## Type mapping

| opportunity_type | action_plan.type |
| --- | --- |
| `cost_data_completion` | `collect_cost_data` |
| `dead_stock_review` | `review_dead_stock_options` |
| `price_or_margin_review` | `prepare_price_review` |
| `listing_quality_review` | `prepare_listing_quality_review` |
| `competition_watch` | `verify_competitor_match` |
| `urgent_price_attack_review` | `urgent_competition_review` |
| `inventory_restock_review` | `prepare_restock_review` |

## CLI

```bash
npm run hermes:agent -- opportunity-plan --id=<APPROVED_HERMES_OPPORTUNITY_ID>
```

Example:

```bash
npm run hermes:agent -- opportunity-plan --id=4
```

## Output shape

```json
{
  "opportunity_id": 0,
  "sku": "...",
  "opportunity_type": "...",
  "status": "approved",
  "action_plan": {
    "type": "...",
    "title": "...",
    "steps": [],
    "required_checks": [],
    "forbidden_actions": [],
    "requires_human_approval": true,
    "source": "rule_based"
  }
}
```

## Forbidden actions

Every plan includes:

- `no_database_writes`
- `no_marketplace_api_calls`
- `no_price_changes`
- `no_inventory_changes`
- `no_listing_changes`
- `no_automatic_execution`
- `no_ai_calls`

## Validation

```bash
node --check src/services/opportunityInbox.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- opportunity-plan --id=<approved Hermes opportunity id>
npm run hermes:agent -- opportunity-plan --id=<non-approved Hermes opportunity id>
git diff --stat
```

Expected behavior:

1. Approved Hermes opportunity returns a rule-based action plan.
2. Non-approved Hermes opportunity fails validation.
3. No database, AI, marketplace, price, inventory, listing, or execution side effects occur.
