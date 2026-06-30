# Hermes Phase 2C — Opportunity Inbox Writer v1

## 목적

Phase 2C의 목적은 Phase 2B Opportunity Candidate Builder output을 기존 `opportunity_inbox` flow에 연결하는 것이다.

Hermes v2 자동화 흐름은 Monitoring → Analysis → Recommendation → Human Approval → Limited Automation이다. Phase 2C는 Opportunity Candidate를 실제 Inbox row로 저장할 수 있는 첫 write path지만, 기본값은 반드시 dry-run이다.

## 안전 원칙

- 기본 모드는 dry-run이다.
- `--write`가 명시적으로 전달될 때만 `opportunity_inbox`에 insert한다.
- DB write 대상은 `opportunity_inbox`뿐이다.
- marketplace API를 호출하지 않는다.
- AI를 호출하지 않는다.
- 가격, 재고, listing을 변경하지 않는다.
- 자동 action을 수행하지 않는다.
- 모든 생성 row는 사람이 검토하는 후보이며 `status = new`으로 시작한다.

## 구현 위치

Writer service:

```text
src/services/opportunityInbox.js
```

Agent integration:

```text
src/agents/opportunityAgent.js
```

CLI:

```text
scripts/hermes-agent.js
```

## Input

Phase 2C writer는 Phase 2B output을 입력으로 사용한다.

```js
const opportunityResult = await runOpportunityAgent({ sku });
await writeOpportunityCandidates({
  sku,
  candidates: opportunityResult.candidates,
  dryRun: true,
});
```

`runOpportunityAgent()`는 `buildSkuContext({ sku, readOnly: true })`를 사용한다. 이 경로는 eBay connector sync를 건너뛰어 marketplace API 호출과 token refresh write를 피한다.

## CLI

Dry-run, 기본 모드:

```bash
npm run hermes:agent -- opportunity-write --sku=202551129453 --dry-run
```

`--dry-run`을 생략해도 기본값은 dry-run이다.

실제 write:

```bash
npm run hermes:agent -- opportunity-write --sku=202551129453 --write
```

## Structured output

```json
{
  "sku": "...",
  "dry_run": true,
  "created": [],
  "skipped_duplicates": [],
  "errors": []
}
```

Dry-run에서는 insert를 수행하지 않는다. 이때 `created`에는 실제 생성 row 대신 dry-run preview가 들어간다.

Write mode에서는 insert 성공 row가 `created`에 들어간다.

## Duplicate prevention

중복 방지 key는 아래 값을 정규화해 SHA256으로 만든다.

```json
{
  "sku": "...",
  "type": "candidate.type",
  "source_signals": ["sorted", "unique"],
  "source_recommendations": ["sorted", "unique"]
}
```

저장 위치:

```text
opportunity_inbox.metadata.hermes_candidate_key
```

write 전 `metadata->>hermes_candidate_key`로 기존 row를 조회한다. 이미 있으면 insert하지 않고 `skipped_duplicates`에 넣는다.

## Candidate → opportunity_inbox mapping

| Candidate field | opportunity_inbox field |
| --- | --- |
| `type` | `opportunity_type` |
| `title` | `title` |
| `priority` | `priority` mapped to `urgent/high/normal/low` |
| `reason` | `notes` |
| fixed | `source_type = competitor` |
| fixed | `input_channel = api` |
| fixed | `status = new` |
| generated metadata | `metadata` |

Metadata includes:

- `hermes_generated`
- `hermes_phase`
- `hermes_candidate_key`
- `sku`
- `candidate_type`
- `source_signals`
- `source_recommendations`
- `market_analysis`
- `requires_human_review`
- `candidate_created_at`

## Allowed Hermes opportunity types

The existing Opportunity Inbox service allowlist was extended with Hermes-generated candidate types:

- `inventory_restock_review`
- `dead_stock_review`
- `listing_quality_review`
- `price_or_margin_review`
- `cost_data_completion`
- `competition_watch`
- `urgent_price_attack_review`

## Validation

```bash
node --check src/services/opportunityInbox.js
node --check src/agents/opportunityAgent.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- opportunity-write --sku=202551129453 --dry-run
npm run hermes:agent -- opportunity-write --sku=202551129453 --write
npm run hermes:agent -- opportunity-write --sku=202551129453 --write
git diff --stat
```

Expected behavior:

1. Dry-run returns structured output and performs no insert.
2. First write inserts non-duplicate candidates.
3. Repeat write skips the same candidates as duplicates.
