# Hermes Phase 5H — Execution Dry-Run Result Capture

Report timestamp: 2026-07-01T14:25:24Z

## Purpose

Phase 5H adds internal execution dry-run result capture for approved Hermes execution requests.

This phase still does not execute anything externally. It records only an internal preview artifact in the existing execution approval tables so operators can inspect what would be planned before any future final execution phase exists.

Baseline:

```text
771cb44 Add Phase 5G execution request read-only UI
```

## Files changed

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
public/js/hermesExecutionRequests.js
```

Created:

```text
docs/phase-5h-execution-dry-run-capture.md
```

No migration was created. Phase 5H uses the existing schema from migration 060:

```text
hermes_execution_requests.dry_run_result
hermes_execution_requests.status = dry_run_ready
hermes_execution_events
```

## Service change

Added service function:

```js
generateExecutionDryRun({ requestId, actor, dryRun })
```

Behavior:

- Reads the target execution request.
- Allows dry-run generation only when `hermes_execution_requests.status === 'approved'`.
- Defaults to preview mode (`dryRun=true`).
- Preview mode returns the dry-run artifact and event preview without writing any row.
- Write mode (`dryRun=false`) writes only internal DB fields:
  - `hermes_execution_requests.dry_run_result`
  - `hermes_execution_requests.status = 'dry_run_ready'`
  - `metadata.external_action_executed = false`
  - `metadata.marketplace_execution_approved = false`
  - `metadata.hermes_execution_dry_run`
- Write mode inserts one internal audit event:
  - `event_type = 'dry_run_generated'`
- Write mode requires `actor`.

The service does not import marketplace connectors, AI clients, HTTP clients, or scheduler code.

## Dry-run result format

Phase 5H dry-run result shape:

```json
{
  "dry_run": true,
  "execution_performed": false,
  "external_action_executed": false,
  "marketplace_api_calls": false,
  "marketplace_execution_approved": false,
  "request_id": 1,
  "sku": "202551129453",
  "execution_type": "manual_review_task",
  "risk_level": "low",
  "planned_steps": [
    "Review inventory age and sales history for SKU 202551129453.",
    "Evaluate hold, bundle, promotion, liquidation, or delist options.",
    "Prepare a human decision memo with expected margin and operational impact."
  ],
  "blocked_operations": [
    "no_marketplace_api_calls",
    "no_price_changes",
    "no_inventory_changes",
    "no_listing_changes",
    "no_automatic_execution",
    "no_ai_calls",
    "no_external_side_effects",
    "no_database_writes"
  ],
  "required_final_approval": true,
  "generated_at": "ISO8601"
}
```

## CLI usage

Added command:

```bash
npm run hermes:agent -- execution-dry-run --id=<REQUEST_ID> --actor=<USER> [--dry-run|--write]
```

Examples:

Preview only, no DB write:

```bash
npm run hermes:agent -- execution-dry-run --id=1 --dry-run --actor=operator
```

Store internal dry-run result and event only:

```bash
npm run hermes:agent -- execution-dry-run --id=1 --write --actor=operator
```

Default behavior remains dry-run preview unless `--write` is explicitly provided.

## Internal DB fields touched in write mode

Phase 5H write mode updates only the existing internal execution request row:

```text
hermes_execution_requests.status
hermes_execution_requests.dry_run_result
hermes_execution_requests.metadata
```

It inserts one internal audit event:

```text
hermes_execution_events.event_type = dry_run_generated
```

It does not write:

```text
hermes_execution_requests.executed_at
hermes_execution_requests.execution_result
```

Those remain null.

## UI update

Updated Phase 5G read-only panel:

```text
public/js/hermesExecutionRequests.js
```

The UI now shows:

- `dry_run_ready` status badge color
- a visible `dry-run ready requests` read-only section
- a `Dry-run result` panel in request detail
- dry-run safety booleans
- planned steps
- blocked operations
- raw dry-run JSON in a collapsed read-only details block

The UI still calls only read-only GET endpoints:

```text
GET /api/hermes-execution/summary?limit=50
GET /api/hermes-execution/requests?status=approved&limit=20
GET /api/hermes-execution/requests/:id
GET /api/hermes-execution/requests/:id/events?limit=20
```

The UI does not add any write HTTP call.

## Validation output

### Syntax checks

Commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/web/routes/hermesExecutionRequests.js
node --check public/js/hermesExecutionRequests.js
```

Result: passed.

### UI static verification

Static verification confirmed:

```text
shows_dry_run_result: True
shows_dry_run_ready: True
no_write_methods: True
phase5f_gets: True
```

### Summary before write

Command:

```bash
npm run hermes:agent -- execution-summary --limit=50
```

Observed before write:

```json
{
  "read_only": true,
  "scanned_request_count": 2,
  "counts_by_status": {
    "approved": 2
  },
  "recent_dry_run_ready_requests": [],
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "executed_request_count": 0
  }
}
```

### Dry-run preview

Command:

```bash
npm run hermes:agent -- execution-dry-run --id=1 --dry-run --actor=operator
```

Observed:

```json
{
  "dry_run": true,
  "updated": false,
  "request_id": 1,
  "after": {
    "status": "dry_run_ready",
    "executed_at": null,
    "execution_result": null
  },
  "dry_run_result": {
    "dry_run": true,
    "execution_performed": false,
    "external_action_executed": false,
    "marketplace_api_calls": false,
    "marketplace_execution_approved": false,
    "request_id": 1,
    "sku": "202551129453",
    "execution_type": "manual_review_task",
    "risk_level": "low",
    "required_final_approval": true
  },
  "event_preview": {
    "event_type": "dry_run_generated",
    "actor": "operator"
  }
}
```

Preview mode did not update the database.

### Dry-run write

Command:

```bash
npm run hermes:agent -- execution-dry-run --id=1 --write --actor=operator
```

Observed:

```json
{
  "dry_run": false,
  "updated": true,
  "request_id": 1,
  "after": {
    "status": "dry_run_ready",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "event": {
    "id": 5,
    "request_id": 1,
    "event_type": "dry_run_generated",
    "actor": "operator"
  }
}
```

The write stored only the internal dry-run result and internal audit event.

### Detail after write

Command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed:

```json
{
  "request": {
    "id": 1,
    "status": "dry_run_ready",
    "dry_run_result": {
      "dry_run": true,
      "execution_performed": false,
      "marketplace_api_calls": false,
      "external_action_executed": false,
      "marketplace_execution_approved": false
    },
    "executed_at": null,
    "execution_result": null
  },
  "events": {
    "count": 3
  },
  "safety_summary": {
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "executed_at": null,
    "execution_result": null,
    "status": "dry_run_ready"
  },
  "read_only": true,
  "execution_performed": false
}
```

### Summary after write

Command:

```bash
npm run hermes:agent -- execution-summary --limit=50
```

Observed:

```json
{
  "counts_by_status": {
    "approved": 1,
    "dry_run_ready": 1
  },
  "recent_dry_run_ready_requests": [
    {
      "id": 1,
      "status": "dry_run_ready",
      "executed_at": null,
      "execution_result": null,
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  ],
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "executed_request_count": 0
  }
}
```

### Direct DB assertions

Direct assertions after write:

```json
{
  "status_dry_run_ready": true,
  "dry_run_result_exists": true,
  "dry_run_true": true,
  "execution_performed_false": true,
  "marketplace_api_calls_false": true,
  "executed_at_null": true,
  "execution_result_null": true,
  "external_action_false": true,
  "marketplace_execution_false": true,
  "dry_run_event_count": 1,
  "dry_run_event_present": true
}
```

## Safety boundaries

Confirmed for Phase 5H:

- No executor implemented.
- No marketplace API calls.
- No eBay/Shopee/Shopify API calls.
- No price changes.
- No inventory changes.
- No listing revisions.
- No AI calls.
- No scheduler installed.
- No external actions performed.
- No HTTP write endpoints added.
- No UI write calls added.
- `executed_at` remains null.
- `execution_result` remains null.
- `external_action_executed` remains false.
- `marketplace_execution_approved` remains false.

## Safety audit

Focused safety grep was run against Phase 5H touched code paths for prohibited marketplace write APIs and external/AI call indicators.

Result:

```text
Prohibited marketplace write APIs: none
External API / AI indicators in Phase 5H service/CLI/UI: none beyond browser fetch calls in the existing read-only UI module.
```

The browser fetch calls in `public/js/hermesExecutionRequests.js` call only existing Phase 5F read-only GET endpoints.

## No marketplace execution performed

Phase 5H generated and stored an internal dry-run artifact only.

It did not execute any marketplace action, did not modify marketplace listings, did not change price, did not change inventory, and did not call an external marketplace API.

## Phase 5I recommendation

Recommended next phase:

- Add a read-only pre-execution risk summary and final approval requirement display for `dry_run_ready` requests.
- Keep any future execution action separate from this UI.
- Require explicit final human approval, actor capture, and a new audit event before any later executor can be considered.
- Continue to keep marketplace writes disabled unless a future phase explicitly scopes and approves a limited executor.

## Phase 5H verdict

Phase 5H is complete.

Hermes now captures internal dry-run results for approved execution requests while preserving the no-executor and no-marketplace-write boundary.
