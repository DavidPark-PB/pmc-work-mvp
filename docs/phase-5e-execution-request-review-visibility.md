# Hermes Phase 5E — Execution Request Review Visibility

Report timestamp: 2026-07-01T12:58:55Z

## Purpose

Phase 5E adds read-only visibility for execution request review state so operators can inspect pending, approved, rejected, and cancelled requests safely before any executor exists.

Baseline:

```text
dee4751 Add Phase 5D execution approval actor audit hardening
```

Phase 5E does not approve, reject, cancel, or execute requests automatically.

## Safety boundaries

Explicitly not performed:

- No executor implemented.
- No marketplace API calls.
- No price changes.
- No inventory changes.
- No listing revisions.
- No AI calls.
- No scheduler installed.
- No automatic approval/rejection/cancellation.
- No request execution.

Allowed in this phase:

- Read execution request detail.
- Read related opportunity snapshot.
- Read internal execution events.
- Read aggregate request counts and recent request summaries.

## Service changes

Updated:

```text
src/services/hermesExecutionApproval.js
```

Added read-only functions:

- `getExecutionRequestDetail({ requestId })`
- `summarizeExecutionRequests({ limit = 50 })`

### Detail output

`getExecutionRequestDetail()` returns:

- `request`
- `opportunity_snapshot`
- `events`
- `safety_summary`
- `read_only: true`
- `execution_performed: false`

The safety summary includes:

- `external_action_executed`
- `marketplace_execution_approved`
- `executed_at`
- `execution_result`
- `requires_approval`
- `status`
- `risk_level`
- `approved_actor`
- `rejected_actor`
- `cancelled_actor`

### Summary output

`summarizeExecutionRequests()` returns:

- `counts_by_status`
- `counts_by_execution_type`
- `counts_by_risk_level`
- `recent_pending_requests`
- `recent_approved_requests`
- `recent_rejected_cancelled_requests`
- `execution_events_count`
- `no_execution_events`
- `latest_events_sample`
- `safety_summary`

The summary path performs only `select` reads.

## CLI changes

Updated:

```text
scripts/hermes-agent.js
```

Added read-only commands:

```bash
npm run hermes:agent -- execution-detail --id=<REQUEST_ID>
npm run hermes:agent -- execution-summary --limit=50
```

No package script change was required because these are subcommands of the existing `hermes:agent` script.

## Validation data

Existing request ids were used:

- request id `1`: approved
- request id `2`: approved

Both were created in previous Phase 5 validation and both are linked to approved opportunity id `4`.

## Detail validation — request id 1

Command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed summary:

```json
{
  "request": {
    "id": 1,
    "status": "approved",
    "approved_by": null,
    "approved_actor": "operator",
    "approved_at": "2026-07-01T00:34:47.886",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "opportunity_snapshot": {
    "id": 4,
    "sku": "202551129453",
    "type": "dead_stock_review",
    "status": "approved"
  },
  "events": {
    "count": 2
  },
  "safety_summary": {
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "executed_at": null,
    "execution_result": null,
    "requires_approval": true,
    "status": "approved",
    "risk_level": "low",
    "approved_actor": "operator"
  },
  "read_only": true,
  "execution_performed": false
}
```

Result: passed.

## Detail validation — request id 2

Command:

```bash
npm run hermes:agent -- execution-detail --id=2
```

Observed summary:

```json
{
  "request": {
    "id": 2,
    "status": "approved",
    "approved_by": null,
    "approved_actor": "operator",
    "approved_at": "2026-07-01T12:46:23.171",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "opportunity_snapshot": {
    "id": 4,
    "sku": "202551129453",
    "type": "dead_stock_review",
    "status": "approved"
  },
  "events": {
    "count": 2
  },
  "safety_summary": {
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "executed_at": null,
    "execution_result": null,
    "requires_approval": true,
    "status": "approved",
    "risk_level": "low",
    "approved_actor": "operator"
  },
  "read_only": true,
  "execution_performed": false
}
```

Result: passed.

## Summary validation

Command:

```bash
npm run hermes:agent -- execution-summary --limit=50
```

Observed summary:

```json
{
  "read_only": true,
  "limit": 50,
  "scanned_request_count": 2,
  "counts_by_status": {
    "approved": 2
  },
  "counts_by_execution_type": {
    "manual_review_task": 2
  },
  "counts_by_risk_level": {
    "low": 2
  },
  "recent_pending_requests": [],
  "recent_approved_requests": [
    {
      "id": 2,
      "status": "approved",
      "approved_by": null,
      "approved_actor": "operator",
      "executed_at": null,
      "execution_result": null,
      "external_action_executed": false,
      "marketplace_execution_approved": false
    },
    {
      "id": 1,
      "status": "approved",
      "approved_by": null,
      "approved_actor": "operator",
      "executed_at": null,
      "execution_result": null,
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  ],
  "recent_rejected_cancelled_requests": [],
  "execution_events_count": 0,
  "no_execution_events": true,
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "executed_request_count": 0
  }
}
```

Result: passed.

## Events validation

Command:

```bash
npm run hermes:agent -- execution-events --id=2 --limit=20
```

Observed:

```json
{
  "count": 2,
  "data": [
    {
      "id": 3,
      "request_id": 2,
      "event_type": "request_created",
      "actor": "hermes-agent-cli",
      "payload": {
        "external_action_executed": false
      }
    },
    {
      "id": 4,
      "request_id": 2,
      "event_type": "request_approved",
      "actor": "operator",
      "payload": {
        "execution_performed": false,
        "external_action_executed": false
      }
    }
  ]
}
```

Result: passed. No execution event was present.

## Negative validation

### Missing id

Command:

```bash
npm run hermes:agent -- execution-detail
```

Observed:

```text
exit_code=1
id is required
```

Result: passed.

### Nonexistent id

Command:

```bash
npm run hermes:agent -- execution-detail --id=999999
```

Observed:

```text
exit_code=1
execution request id=999999 not found
```

Result: passed.

## Read-only verification

Before Phase 5E read commands, direct counts were:

```json
{
  "requests": 2,
  "events": 4
}
```

After running detail, summary, event, and negative read commands, direct counts were still:

```json
{
  "requests": 2,
  "events": 4
}
```

Direct assertions confirmed:

```json
{
  "request_1_approved_actor_operator": true,
  "request_1_approved_by_null": true,
  "request_1_executed_at_null": true,
  "request_1_execution_result_null": true,
  "request_1_external_action_false": true,
  "request_1_marketplace_execution_false": true,
  "request_2_approved_actor_operator": true,
  "request_2_approved_by_null": true,
  "request_2_executed_at_null": true,
  "request_2_execution_result_null": true,
  "request_2_external_action_false": true,
  "request_2_marketplace_execution_false": true,
  "summary_did_not_write_requests": true,
  "summary_did_not_write_events": true,
  "no_execution_event_inserted": true
}
```

## Checks

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Result: passed.

Safety grep:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js supabase/migrations/060_hermes_execution_approval.sql supabase/migrations/061_hermes_execution_actor_audit.sql || true

grep -RInE 'callTradingAPI|callShoppingAPI|Browse|openai|anthropic|claude|axios|fetch\(' \
  src/services/hermesExecutionApproval.js || true
```

Observed:

```text
Prohibited marketplace write APIs: none
External API / AI indicators in Phase 5E service: none
```

## Safety audit

Phase 5E is read-only visibility only.

Confirmed:

- Detail commands perform only reads.
- Summary command performs only reads.
- Event command performs only reads.
- No request count changed.
- No event count changed.
- No execution event exists.
- No external action was performed.
- No marketplace execution was approved.
- Existing approved requests remain unexecuted.

## Phase 5F recommendation

Phase 5F should add a read-only operator-facing review UI/API for execution requests, or an internal dry-run result capture flow.

Recommended constraints:

- Keep every new surface read-only unless explicitly adding a dry-run-only capture field.
- Show `approved_actor`, `rejected_actor`, `cancelled_actor`, event history, and safety summary.
- Do not implement an executor.
- Do not call marketplace APIs.
- Do not mutate price, inventory, or listings.
- Keep execution approval distinct from marketplace execution.

## Phase 5E verdict

Phase 5E is complete.

Hermes now exposes read-only execution request detail and summary views for operator inspection while preserving the no-executor, no-marketplace-write boundary.
