# Hermes Phase 2E — Opportunity Review Action v1

## 목적

Phase 2E의 목적은 Hermes-generated opportunity에 대해 사람이 검토 상태를 변경할 수 있는 안전한 review action을 제공하는 것이다.

이 단계는 Opportunity Inbox row의 review status와 review metadata만 변경한다. Marketplace action 승인/실행과는 별개이며, 가격/재고/listing 변경을 절대 수행하지 않는다.

## 안전 원칙

- 대상은 `metadata.hermes_generated = true`인 `opportunity_inbox` row만 가능하다.
- 기본 모드는 dry-run이다.
- 실제 DB update는 `--write`가 명시된 경우에만 수행한다.
- update 대상은 `opportunity_inbox.status`, `opportunity_inbox.metadata.hermes_review`뿐이다.
- AI 호출 없음.
- marketplace API 호출 없음.
- 가격, 재고, listing 변경 없음.
- marketplace action을 자동 승인하지 않는다.

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
reviewHermesOpportunity({ id, action, reason, reviewed_by })
```

CLI safety를 위해 `dryRun` optional field도 지원한다.

```js
reviewHermesOpportunity({ id, action, reason, reviewed_by, dryRun: true })
```

## Allowed actions

| action | status |
| --- | --- |
| `reviewing` | `reviewing` |
| `approved` | `approved` |
| `rejected` | `rejected` |
| `archived` | `archived` |

Rules:

- `rejected` requires `reason`.
- `reviewed_by` is optional for CLI.
- `reviewed_by` should be required by web/API later.
- Target row must be Hermes-generated.

## Review metadata

The service appends/replaces `metadata.hermes_review`:

```json
{
  "action": "...",
  "reason": "...",
  "reviewed_by": "...",
  "reviewed_at": "ISO8601"
}
```

Existing metadata is preserved.

## CLI

Dry-run reviewing:

```bash
npm run hermes:agent -- opportunity-review --id=<ID> --action=reviewing
```

Explicit dry-run:

```bash
npm run hermes:agent -- opportunity-review --id=<ID> --action=reviewing --dry-run
```

Write reviewing:

```bash
npm run hermes:agent -- opportunity-review --id=<ID> --action=reviewing --write
```

Reject with reason:

```bash
npm run hermes:agent -- opportunity-review --id=<ID> --action=rejected --reason="Not worth action now" --write
```

Approve for human-reviewed business workflow:

```bash
npm run hermes:agent -- opportunity-review --id=<ID> --action=approved --write
```

Important: `approved` here only approves the Opportunity Inbox review state. It does not approve or execute marketplace writes.

## Output shape

```json
{
  "dry_run": true,
  "id": 0,
  "action": "...",
  "before": {},
  "after": {},
  "error": null
}
```

## Validation

```bash
node --check src/services/opportunityInbox.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- opportunity-review --id=<ID> --action=reviewing --dry-run
npm run hermes:agent -- opportunity-review --id=<ID> --action=reviewing --write
npm run hermes:agent -- opportunity-list --sku=<SKU>
npm run hermes:agent -- opportunity-review --id=<ID> --action=rejected
git diff --stat
```

Expected behavior:

1. Dry-run returns before/after preview and does not update DB.
2. Write updates status and `metadata.hermes_review` only.
3. List confirms the status changed.
4. Rejected without reason fails validation.
