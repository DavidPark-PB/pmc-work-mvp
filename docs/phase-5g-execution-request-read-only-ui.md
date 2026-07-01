# Hermes Phase 5G — Execution Request Read-Only UI

Report timestamp: 2026-07-01T14:10:41Z

## Purpose

Phase 5G adds an operator-facing read-only UI panel for Hermes execution requests, backed by the Phase 5F authenticated read-only API.

Baseline:

```text
14d542d Add Phase 5F execution request read-only API
```

This phase is visibility-only. It does not add any execution, approval, rejection, cancellation, dry-run executor, marketplace write, or database write path.

## Files changed

Created:

```text
public/js/hermesExecutionRequests.js
```

Updated:

```text
public/index.html
public/js/dashboard.js
```

Created documentation:

```text
docs/phase-5g-execution-request-read-only-ui.md
```

## UI surface

The app now includes a sidebar entry:

```text
🛡️ Hermes Execution
```

The page is wired through:

```text
page id: page-hermes-execution-requests
section id: hermes-execution-requests-section
window module: window.pmcHermesExecutionRequests
router page: hermes-execution-requests
```

The UI displays:

- summary counts by status
- counts by execution_type
- counts by risk_level
- recent approved requests
- recent pending requests
- rejected/cancelled requests if present
- request detail panel
- event history
- safety summary
  - external_action_executed
  - marketplace_execution_approved
  - executed_at
  - execution_result
  - approved_actor
  - rejected_actor
  - cancelled_actor

## Required safety copy

The UI explicitly displays:

```text
Approved execution request is not marketplace execution.
No external action has been executed.
Execution is disabled in this phase.
```

This appears both in the page-level safety banner and in the selected request detail panel.

## API endpoints used

The UI uses only Phase 5F read-only GET endpoints:

```text
GET /api/hermes-execution/summary?limit=50
GET /api/hermes-execution/requests?status=approved&limit=20
GET /api/hermes-execution/requests/:id
GET /api/hermes-execution/requests/:id/events?limit=20
```

No write endpoints are called.

## Controls intentionally not added

The UI does not add:

- approve controls
- reject controls
- cancel controls
- execute controls
- dry-run executor controls
- marketplace write controls
- price change controls
- inventory change controls
- listing revision controls

The UI provides only refresh and row-selection behavior.

## UI wiring verification

Verification script confirmed:

```text
sidebar_menu_exists: True
page_container_exists: True
dashboard_router_initializes: True
script_include_exists: True
window_export_exists: True
safety_copy_approved_not_marketplace: True
safety_copy_no_external: True
safety_copy_disabled: True
uses_summary_get: True
uses_approved_get: True
uses_detail_get: True
uses_events_get: True
```

## Read-only safety verification

Static read-only verification confirmed:

- no `POST` in `public/js/hermesExecutionRequests.js`
- no `PUT` in `public/js/hermesExecutionRequests.js`
- no `PATCH` in `public/js/hermesExecutionRequests.js`
- no `DELETE` in `public/js/hermesExecutionRequests.js`
- no `method:` override in `public/js/hermesExecutionRequests.js`
- no `/approve` endpoint call
- no `/execute` endpoint call

The strings `approve`, `reject`, `cancel`, and `execute` appear only as status/safety copy, field labels, and read-only sections such as `recent approved requests` and `rejected / cancelled requests`.

## CLI/API validation

Commands run:

```bash
npm run hermes:agent -- execution-summary --limit=50
npm run hermes:agent -- execution-detail --id=1
```

Observed summary characteristics:

```json
{
  "read_only": true,
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
  "execution_events_count": 0,
  "no_execution_events": true,
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "executed_request_count": 0
  }
}
```

Observed detail characteristics for request id `1`:

```json
{
  "status": "approved",
  "approved_actor": "operator",
  "approved_by": null,
  "executed_at": null,
  "execution_result": null,
  "external_action_executed": false,
  "marketplace_execution_approved": false,
  "read_only": true,
  "execution_performed": false
}
```

## Syntax checks

Commands run:

```bash
node --check public/js/hermesExecutionRequests.js
node --check public/js/dashboard.js
node --check server.js
node --check src/web/routes/hermesExecutionRequests.js
```

Result: passed.

Earlier in the same Phase 5G implementation, these also passed:

```bash
node --check src/services/hermesExecutionApproval.js
```

## Browser validation note

Full browser validation was not run.

Reason:

- Full `server.js` browser validation would start existing unrelated background jobs and intervals.
- A previous `jsdom`/browser-validation prerequisite check was blocked by the environment approval layer.
- The user explicitly instructed not to run jsdom/browser validation again and to document it as skipped.

Therefore Phase 5G browser validation status is:

```text
Skipped/blocked by environment approval constraints.
```

Validated instead:

- static UI wiring
- dashboard router wiring
- script include wiring
- frontend JS syntax
- backend route syntax
- existing CLI/API read paths
- focused read-only safety grep

## Safety audit

Confirmed for Phase 5G:

- no executor implemented
- no approve/reject/cancel buttons
- no approve/reject/cancel HTTP actions
- no marketplace APIs
- no price changes
- no inventory changes
- no listing revisions
- no AI calls
- no scheduler installed
- no DB write paths in the new UI
- no external action performed

The UI is a read-only operator visibility panel only.

## Phase 5H recommendation

Recommended Phase 5H direction:

- Add read-only dry-run result visibility if an internal dry-run artifact already exists, or design a dry-run capture schema behind explicit operator action.
- Keep execution disabled until a later phase explicitly adds a dry-run-first executor.
- If any action controls are introduced later, keep them separate from this read-only panel and require explicit human approval, actor capture, and audit events.
- Continue to keep marketplace writes behind a final manual approval gate.

## Phase 5G verdict

Phase 5G is complete.

Hermes now has an operator-facing read-only UI panel for execution request review visibility backed by Phase 5F API endpoints while preserving the no-executor and no-marketplace-write boundary.
