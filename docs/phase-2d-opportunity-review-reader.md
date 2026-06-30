# Hermes Phase 2D — Opportunity Review Reader v1

## 목적

Phase 2D의 목적은 `opportunity_inbox`에 저장된 Hermes-generated opportunity를 read-only로 조회하는 것이다.

Phase 2C가 Candidate를 Inbox row로 저장하는 write path였다면, Phase 2D는 사람이 검토할 review list를 터미널에서 안전하게 확인하는 read path다.

## 안전 원칙

- `opportunity_inbox`만 읽는다.
- DB write 없음.
- AI 호출 없음.
- marketplace API 호출 없음.
- 가격, 재고, listing 변경 없음.
- Phase 2B Candidate Builder와 Phase 2C Writer를 다시 실행하지 않는다.

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
listHermesOpportunities({ sku, status, opportunity_type, limit })
```

항상 아래 조건을 적용한다.

```text
metadata->>hermes_generated = true
```

Optional filters:

- `sku`: `metadata->>sku`
- `status`: `opportunity_inbox.status`
- `opportunity_type`: `opportunity_inbox.opportunity_type`
- `limit`: 기본 50, 최대 200

## CLI

전체 Hermes opportunity list:

```bash
npm run hermes:agent -- opportunity-list
```

SKU filter:

```bash
npm run hermes:agent -- opportunity-list --sku=202551129453
```

Status and limit filter:

```bash
npm run hermes:agent -- opportunity-list --status=new --limit=20
```

Opportunity type filter:

```bash
npm run hermes:agent -- opportunity-list --opportunity_type=dead_stock_review
```

## Output shape

```json
{
  "count": 0,
  "data": [
    {
      "id": 0,
      "sku": "...",
      "type": "...",
      "title": "...",
      "priority": "...",
      "status": "...",
      "source_signals": [],
      "source_recommendations": [],
      "market_analysis": {},
      "created_at": "..."
    }
  ]
}
```

## Field mapping

| Output field | Source |
| --- | --- |
| `id` | `opportunity_inbox.id` |
| `sku` | `metadata.sku` |
| `type` | `opportunity_inbox.opportunity_type` |
| `title` | `opportunity_inbox.title` |
| `priority` | `opportunity_inbox.priority` |
| `status` | `opportunity_inbox.status` |
| `source_signals` | `metadata.source_signals` |
| `source_recommendations` | `metadata.source_recommendations` |
| `market_analysis` | `metadata.market_analysis` |
| `created_at` | `opportunity_inbox.created_at` |

## Validation

```bash
node --check src/services/opportunityInbox.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- opportunity-list
npm run hermes:agent -- opportunity-list --sku=202551129453
git diff --stat
```
