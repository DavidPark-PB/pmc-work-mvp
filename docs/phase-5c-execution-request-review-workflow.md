# Hermes Phase 5C — Execution Request Review Workflow

Report timestamp: 2026-07-01T00:35:26Z

## Purpose

Phase 5C adds an internal approval/rejection/cancellation workflow for `hermes_execution_requests`.

This phase still does not implement an executor and does not perform any marketplace action.

Baseline:

```text
d596f34 Add Phase 5B execution approval migration verification
```

## Scope

Updated:

- `src/services/hermesExecutionApproval.js`
- `scripts/hermes-agent.js`

Added service functions:

- `getExecutionRequest({ requestId })`
- `reviewExecutionRequest({ requestId, action, actor, reason, dryRun = true })`
- `listExecutionEvents({ requestId, limit })`

Added CLI commands:

```bash
npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=approve --actor=<USER> --dry-run
npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=approve --actor=<USER> --write
npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=reject --actor=<USER> --reason="..." --write
npm run hermes:agent -- execution-review --id=<REQUEST_ID> --action=cancel --actor=<USER> --reason="..." --write
npm run hermes:agent -- execution-events --id=<REQUEST_ID> --limit=20
```

## Safety boundaries

Explicitly not performed:

- No executor implemented.
- No marketplace API calls.
- No price changes.
- No inventory changes.
- No listing revisions.
- No AI calls.
- No scheduler installed.
- No cron installed.
- No LaunchAgent installed or loaded.
- Approval did not execute anything.

Allowed in Phase 5C:

- Internal request status preview in dry-run mode.
- Internal request status update in write mode.
- Internal audit event insert in write mode.

## State transition rules

Supported actions:

| CLI action | Next status | Event type |
| --- | --- | --- |
| `approve` | `approved` | `request_approved` |
| `reject` | `rejected` | `request_rejected` |
| `cancel` | `cancelled` | `request_cancelled` |

Rules enforced:

- Dry-run is default.
- `--write` is required for DB update.
- `actor` is required for write mode.
- `reject` requires `reason`.
- `cancel` requires `reason`.
- `approve` allowed only from `pending_approval`.
- `reject` allowed only from `pending_approval`.
- `cancel` allowed from `pending_approval` or `approved`.
- Approved request still does not execute.
- Write mode updates only internal request status/review fields and inserts one internal event.

## Actor handling note

Migration 060 defines `approved_by`, `rejected_by`, and `executed_by` as integer columns. The CLI accepts human-readable actor strings such as `operator`.

For Phase 5C:

- The human actor string is preserved in `hermes_execution_events.actor`.
- The human actor string is preserved in `metadata.hermes_execution_review.actor`.
- The integer review column is set to `0` when the actor is non-numeric, so the review field is visibly set while preserving the already-applied migration schema.
- Numeric actor strings would be stored as their numeric value.

This avoids changing the already-applied migration 060 while keeping human audit metadata intact.

## Dry-run-first behavior

Dry-run mode returns:

- current request row as `before`
- projected request row as `after`
- projected internal event as `event_preview`
- safety block proving no execution was performed

Dry-run mode does not update `hermes_execution_requests` and does not insert `hermes_execution_events`.

## Validation request

Phase 5C used existing request id `1`, created by Phase 5B.

Initial pending request check:

```bash
npm run hermes:agent -- execution-list --status=pending_approval --limit=20
```

Observed:

```json
{
  "count": 1,
  "data": [
    {
      "id": 1,
      "opportunity_id": 4,
      "sku": "202551129453",
      "execution_type": "manual_review_task",
      "status": "pending_approval",
      "approved_by": null,
      "approved_at": null,
      "executed_at": null,
      "execution_result": null,
      "metadata": {
        "external_action_executed": false,
        "marketplace_execution_approved": false,
        "opportunity_approval_is_not_execution_approval": true
      }
    }
  ]
}
```

Since request id `1` was still `pending_approval`, no new internal request was created for Phase 5C.

## Dry-run validation

Command:

```bash
npm run hermes:agent -- execution-review --id=1 --action=approve --actor=operator --dry-run
```

Observed summary:

```json
{
  "dry_run": true,
  "updated": false,
  "request_id": 1,
  "action": "approve",
  "before": {
    "status": "pending_approval",
    "approved_by": null,
    "approved_at": null,
    "executed_at": null,
    "execution_result": null
  },
  "after": {
    "status": "approved",
    "approved_by": 0,
    "approved_at": "preview timestamp",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "external_action_executed": false,
      "marketplace_execution_approved": false,
      "hermes_execution_review": {
        "actor": "operator",
        "action": "approve",
        "status": "approved",
        "external_action_executed": false
      }
    }
  },
  "event_preview": {
    "event_type": "request_approved",
    "actor": "operator",
    "payload": {
      "from_status": "pending_approval",
      "to_status": "approved",
      "execution_performed": false,
      "external_action_executed": false
    }
  }
}
```

Post dry-run verification:

```json
{
  "after_dry_run_and_negative_checks": {
    "id": 1,
    "status": "pending_approval",
    "approved_by": null,
    "approved_at": null,
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "external_action_executed": false
    }
  },
  "event_count": 1
}
```

Result: passed. Dry-run did not update DB and did not insert an event.

## Negative validation before approval

### Reject without reason

Command:

```bash
npm run hermes:agent -- execution-review --id=1 --action=reject --actor=operator --write
```

Observed:

```text
exit_code=1
reject requires reason
```

Result: passed.

### Missing actor in write mode

Command:

```bash
npm run hermes:agent -- execution-review --id=1 --action=approve --write
```

Observed:

```text
exit_code=1
actor is required for write mode
```

Result: passed.

## Approval write validation

Command:

```bash
npm run hermes:agent -- execution-review --id=1 --action=approve --actor=operator --write
```

Observed summary:

```json
{
  "dry_run": false,
  "updated": true,
  "request_id": 1,
  "action": "approve",
  "before": {
    "status": "pending_approval",
    "approved_by": null,
    "approved_at": null,
    "executed_at": null,
    "execution_result": null
  },
  "after": {
    "status": "approved",
    "approved_by": 0,
    "approved_at": "2026-07-01T00:34:47.886",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "hermes_execution_review": {
        "actor": "operator",
        "action": "approve",
        "status": "approved",
        "external_action_executed": false
      },
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "event": {
    "id": 2,
    "request_id": 1,
    "event_type": "request_approved",
    "actor": "operator",
    "payload": {
      "from_status": "pending_approval",
      "to_status": "approved",
      "execution_performed": false,
      "external_action_executed": false
    }
  }
}
```

Result: passed. Approval changed only internal request status/review fields and inserted one internal audit event.

## Approved list validation

Command:

```bash
npm run hermes:agent -- execution-list --status=approved --limit=20
```

Observed summary:

```json
{
  "count": 1,
  "data": [
    {
      "id": 1,
      "status": "approved",
      "approved_by": 0,
      "approved_at": "2026-07-01T00:34:47.886",
      "executed_by": null,
      "executed_at": null,
      "execution_result": null,
      "metadata": {
        "external_action_executed": false,
        "marketplace_execution_approved": false,
        "opportunity_approval_is_not_execution_approval": true
      }
    }
  ]
}
```

Result: passed.

## Events validation

Command:

```bash
npm run hermes:agent -- execution-events --id=1 --limit=20
```

Observed summary:

```json
{
  "count": 2,
  "data": [
    {
      "id": 1,
      "event_type": "request_created",
      "actor": "hermes-agent-cli",
      "payload": {
        "external_action_executed": false
      }
    },
    {
      "id": 2,
      "event_type": "request_approved",
      "actor": "operator",
      "payload": {
        "from_status": "pending_approval",
        "to_status": "approved",
        "execution_performed": false,
        "external_action_executed": false
      }
    }
  ]
}
```

Result: passed. `request_approved` was inserted and no execution event was inserted.

## Negative validation after approval

### Approve already approved request

Command:

```bash
npm run hermes:agent -- execution-review --id=1 --action=approve --actor=operator --write
```

Observed:

```text
exit_code=1
approve allowed only from pending_approval
```

Result: passed.

## Direct post-approval assertions

A direct Supabase client verification confirmed:

```json
{
  "assertions": {
    "status_approved": true,
    "approved_at_set": true,
    "approved_by_set": true,
    "executed_at_null": true,
    "execution_result_null": true,
    "external_action_false": true,
    "request_approved_event_inserted": true,
    "no_execution_event": true
  }
}
```

## Syntax and safety checks

Commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Result: passed.

Safety grep:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js supabase/migrations/060_hermes_execution_approval.sql || true

grep -RInE 'callTradingAPI|callShoppingAPI|Browse|openai|anthropic|claude|axios|fetch\(' \
  src/services/hermesExecutionApproval.js || true
```

Observed:

```text
Prohibited marketplace write APIs: none
External API / AI indicators in Phase 5C service: none
```

## Final verification summary

Phase 5C validation passed:

- Request id `1` was initially `pending_approval`.
- Dry-run approval preview did not update DB.
- Reject without reason failed.
- Missing actor in write mode failed.
- Approval write changed status to `approved`.
- `approved_at` is set.
- `approved_by` is set.
- Actor `operator` is recorded in event actor and metadata review actor.
- `executed_at` remains null.
- `execution_result` remains null.
- `metadata.external_action_executed` remains false.
- One `request_approved` event was inserted.
- Approving an already approved request is blocked.
- No marketplace action occurred.

## Phase 5D recommendation

Phase 5D should add read-only approval visibility or request review UI/API before any executor work.

Recommended constraints for Phase 5D:

- Keep review actions internal-only.
- Add UI/API surfaces for pending/approved/rejected/cancelled requests if needed.
- Preserve dry-run-first behavior for state transitions.
- Do not implement marketplace execution yet.
- If an executor is introduced later, start with dry-run executor output and event logging only before any external write is considered.

## Phase 5C verdict

Phase 5C is complete.

Hermes now supports internal execution request approval/rejection/cancellation workflow with dry-run previews and audit events, while preserving the no-executor and no-marketplace-write boundary.
