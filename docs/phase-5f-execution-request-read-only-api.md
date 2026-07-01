# Hermes Phase 5F — Execution Request Read-Only Web API

Report timestamp: 2026-07-01

## Purpose

Phase 5F exposes read-only HTTP API endpoints for Hermes execution request review visibility.

This phase builds on Phase 5E service/CLI visibility and makes the same execution request summary, list, detail, and event data available through authenticated web API routes.

Baseline:

```text
d87a1f9 Add Phase 5E execution request review visibility
```

## Safety boundary

Phase 5F is read-only API exposure only.

Explicitly not implemented:

- No executor.
- No approve HTTP action.
- No reject HTTP action.
- No cancel HTTP action.
- No marketplace API calls.
- No price changes.
- No inventory changes.
- No listing revisions.
- No AI calls.
- No scheduler installation.
- No DB writes from the new API.

The new route file defines only `GET` handlers.

## Files changed

Created:

```text
src/web/routes/hermesExecutionRequests.js
```

Updated:

```text
server.js
```

Registered route:

```js
app.use('/api/hermes-execution', require('./src/web/routes/hermesExecutionRequests'));
```

No changes were required in:

- `src/services/hermesExecutionApproval.js`
- `scripts/hermes-agent.js`
- `package.json`

## Endpoints

All endpoints are under:

```text
/api/hermes-execution
```

### GET /api/hermes-execution/summary?limit=50

Returns read-only execution request summary using `summarizeExecutionRequests`.

Includes:

- counts by status
- counts by execution type
- counts by risk level
- recent pending requests
- recent approved requests
- recent rejected/cancelled requests
- execution event count
- latest events sample
- safety summary

### GET /api/hermes-execution/requests?status=approved&sku=<SKU>&limit=20

Returns read-only request list using `listExecutionRequests`.

Supported query params:

- `status`
- `sku`
- `limit`

### GET /api/hermes-execution/requests/:id

Returns read-only request detail using `getExecutionRequestDetail`.

Includes:

- request row
- related opportunity snapshot when available
- internal events
- safety summary

Invalid ids return HTTP 400 with structured JSON.

Nonexistent ids return HTTP 404 with structured JSON.

### GET /api/hermes-execution/requests/:id/events?limit=20

Returns read-only request events using `listExecutionEvents`.

Supported query params:

- `limit`

Invalid ids return HTTP 400 with structured JSON.

## Auth note

The route uses the same normal authenticated API pattern as existing protected routes:

```js
const { requireAuth } = require('../../middleware/auth');
router.use(requireAuth);
```

In production/full app runtime, `server.js` also applies `authGuard` before protected API routes.

The route does not define public endpoints.

## Logging policy

The route does not log request bodies.

Error logs include only:

- action name
- user id
- error code
- error message

Metadata blobs and request bodies are not logged.

## Sample responses

### Summary sample

Validated with CLI equivalent:

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

The HTTP endpoint wraps this shape as:

```json
{
  "data": {
    "read_only": true,
    "counts_by_status": {
      "approved": 2
    }
  },
  "read_only": true
}
```

### Detail sample

Validated with CLI equivalent:

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

The HTTP endpoint wraps this shape as:

```json
{
  "data": {
    "request": {
      "id": 1,
      "approved_actor": "operator",
      "executed_at": null,
      "execution_result": null
    },
    "read_only": true
  },
  "read_only": true
}
```

## Validation results

### Syntax checks

Commands:

```bash
node --check src/web/routes/hermesExecutionRequests.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check server.js
```

Result: passed.

### CLI read-path validation

Commands:

```bash
npm run hermes:agent -- execution-summary --limit=50
npm run hermes:agent -- execution-detail --id=1
```

Result: passed.

Confirmed from output:

- request count scanned: 2
- approved request count: 2
- request id `1` has `approved_actor = operator`
- request id `1` has `approved_by = null`
- request id `1` has `executed_at = null`
- request id `1` has `execution_result = null`
- `external_action_executed = false`
- `marketplace_execution_approved = false`
- `execution_events_count = 0`
- `no_execution_events = true`

### Safety grep

Command:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/web/routes/hermesExecutionRequests.js src/services/hermesExecutionApproval.js scripts/hermes-agent.js server.js || true

grep -RInE 'callTradingAPI|callShoppingAPI|Browse|openai|anthropic|claude|axios|fetch\(' \
  src/web/routes/hermesExecutionRequests.js src/services/hermesExecutionApproval.js || true
```

Observed:

```text
Prohibited marketplace write APIs: none
External API / AI indicators in Phase 5F route/service: none
```

### HTTP validation note

Full server validation was intentionally not run because `server.js` starts existing background jobs and intervals on boot.

An isolated authenticated HTTP validation attempt was previously blocked by the environment/approval layer. Per instruction, it was not retried.

Therefore Phase 5F HTTP validation is documented as:

- route syntax passed
- route registration in `server.js` passed
- service/CLI read paths passed against live data
- authenticated HTTP curl/browser validation was skipped/blocked by environment approval constraints

## API safety audit

The new route file was reviewed for side effects.

Confirmed:

- Only `router.get(...)` handlers are defined.
- No `router.post`, `router.patch`, `router.put`, or `router.delete` handlers are present.
- No service write functions are imported.
- No `reviewExecutionRequest` import is present.
- No `createExecutionRequest` import is present.
- No `recordExecutionEvent` import is present.
- No request body is read for business logic.
- No request body or metadata blob is logged.
- No marketplace connector is imported.
- No AI client is imported.
- No scheduler is installed.

## Final safety confirmation

Phase 5F confirms:

- no executor
- no approve/reject/cancel HTTP actions
- no marketplace APIs
- no price changes
- no inventory changes
- no listing revisions
- no AI calls
- no scheduler
- no DB writes from the new API

## Phase 5G recommendation

Phase 5G should add an operator-facing read-only UI panel for execution requests, backed by the Phase 5F API.

Recommended constraints:

- UI must remain read-only.
- Show summary counts, request detail, event history, and safety summary.
- Display explicit copy that approved execution requests are not marketplace execution.
- Do not add approve/reject/cancel buttons yet unless a later phase explicitly requests them.
- Do not implement an executor.
- Do not call marketplace APIs.
- Keep request execution behind a future dry-run-first, human-approved implementation.

## Phase 5F verdict

Phase 5F is complete.

Hermes now has authenticated read-only HTTP API endpoints for execution request review visibility while preserving the no-executor and no-marketplace-write boundary.
