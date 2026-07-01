# Hermes Phase 7B-D — Internal Limited Executor Records

Report timestamp: 2026-07-01T15:42:09Z

## Purpose

Phase 7B-D implements the internal-only limited executor foundation for Hermes.

This is not marketplace execution.

The implementation adds deterministic preflight and a dry-run-first path for recording an internal `manual_review_task` result. It does not implement price, inventory, listing, enrichment, or marketplace execution.

Baseline:

```text
de14e1d Add Phase 7A limited executor design
b78c3a3 Add Phase 6 internal final approval workflow
```

## Hard boundary

The Phase 7 implementation preserves these constraints:

- no marketplace execution;
- no marketplace API calls;
- no eBay/Shopee/Shopify API calls;
- no price changes;
- no inventory changes;
- no listing revisions;
- no `price_change` execution;
- no `inventory_change` execution;
- no `listing_update` execution;
- only `manual_review_task` may be internally recorded;
- no scheduler;
- no AI calls.

## Migration

Created:

```text
supabase/migrations/063_hermes_internal_executor_records.sql
```

The migration adds one internal-only table:

```text
hermes_internal_execution_records
```

Fields:

```text
id serial primary key
request_id integer not null references hermes_execution_requests(id)
execution_type text not null
status text not null
actor text
reason text
preflight_result jsonb not null default '{}'
internal_task_result jsonb not null default '{}'
safety_flags jsonb not null default '{}'
created_at timestamp default now()
```

Allowed statuses:

```text
preflight_passed
preflight_failed
internal_task_recorded
```

The migration also adds indexes for request/status lookup and a partial unique index to prevent duplicate `internal_task_recorded` rows per request.

It adds no marketplace execution columns and no marketplace adapter fields.

## Service behavior

Updated:

```text
src/services/hermesExecutionApproval.js
```

Added:

```js
buildExecutorPreflight({ requestId })
```

Preflight verifies:

- `request.status = dry_run_ready`;
- `final_approval_status = approved`;
- `final_approval_actor` exists;
- current `dry_run_result` hash matches `final_approval_dry_run_hash`;
- `executed_at is null`;
- `execution_result is null`;
- `metadata.external_action_executed = false`;
- `metadata.marketplace_execution_approved = false`;
- `execution_type = manual_review_task`;
- `risk_level = low`;
- final approval is not expired;
- no existing `internal_task_recorded` record for the request.

Preflight output includes:

```json
{
  "request_id": 1,
  "allowed": false,
  "execution_available": false,
  "internal_record_available": false,
  "blockers": [],
  "warnings": [],
  "safety": {
    "marketplace_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_changes": false,
    "external_action_executed": false
  },
  "source": "rule_based"
}
```

Important invariant:

```text
execution_available is always false
```

`internal_record_available` may become true only when all preconditions pass and the execution type is `manual_review_task`.

Added:

```js
recordInternalManualReviewTask({ requestId, actor, reason, dryRun })
```

Rules:

- default `dryRun = true`;
- write mode requires `actor`;
- write mode requires `reason`;
- requires `buildExecutorPreflight().internal_record_available = true`;
- write mode inserts only into `hermes_internal_execution_records`;
- write mode inserts one internal event: `internal_task_recorded`;
- write mode does not update `executed_at`;
- write mode does not update `execution_result`;
- write mode does not set `metadata.external_action_executed = true`;
- write mode does not set `metadata.marketplace_execution_approved = true`.

## CLI usage

Updated:

```text
scripts/hermes-agent.js
```

Added:

```bash
npm run hermes:agent -- execution-preflight --id=<REQUEST_ID>
```

Added:

```bash
npm run hermes:agent -- execution-record-internal-task --id=<REQUEST_ID> --actor=<USER> --reason="..." [--dry-run|--write]
```

Default is dry-run.

## Read-only API/detail visibility

No new HTTP endpoints were added.

The existing GET detail path now exposes:

```text
executor_preflight
internal_execution_records
```

The existing summary path now exposes:

```text
internal_task_recorded_count
internal_execution_records_migration_required
recent_internal_task_records
safety_summary.internal_task_recorded_count
```

Existing API remains GET-only:

```text
GET /api/hermes-execution/summary
GET /api/hermes-execution/requests
GET /api/hermes-execution/requests/:id
GET /api/hermes-execution/requests/:id/events
```

No `POST`, `PUT`, `PATCH`, or `DELETE` routes were added.

## UI visibility

Updated:

```text
public/js/hermesExecutionRequests.js
```

Selected request detail now displays:

- executor preflight;
- internal record availability;
- blockers;
- internal execution records;
- safety copy:
  - “Internal task record is not marketplace execution.”
  - “Execution remains disabled for marketplace actions.”
  - “Only manual_review_task can be internally recorded.”

No buttons were added.
No write fetch calls were added.

## Validation output

### Syntax validation

Command:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/web/routes/hermesExecutionRequests.js
node --check public/js/hermesExecutionRequests.js
```

Observed result: passed.

### Preflight validation

Command:

```bash
npm run hermes:agent -- execution-preflight --id=1
```

Observed summary:

```json
{
  "request_id": 1,
  "status": "dry_run_ready",
  "execution_type": "manual_review_task",
  "risk_level": "low",
  "allowed": false,
  "execution_available": false,
  "internal_record_available": false,
  "blockers": ["migration_063_required"],
  "hashes": {
    "current_dry_run_hash": "sha256:b55d6ffe781564a62f2c64d894451a3b8bcdc1d8565ab1e6b58b9cb3441b07c3",
    "final_approval_dry_run_hash": "sha256:b55d6ffe781564a62f2c64d894451a3b8bcdc1d8565ab1e6b58b9cb3441b07c3",
    "match": true
  },
  "final_approval": {
    "status": "approved",
    "actor": "operator",
    "expired": false
  },
  "safety": {
    "marketplace_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_changes": false,
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "execution_performed": false
  },
  "source": "rule_based"
}
```

The preflight correctly keeps `execution_available = false` and blocks internal recording until migration 063 is applied and visible to the active Supabase schema cache.

### Internal task dry-run validation

Command:

```bash
npm run hermes:agent -- execution-record-internal-task --id=1 --actor=operator --reason="internal manual review task validation" --dry-run
```

Observed summary:

```json
{
  "dry_run": true,
  "created": false,
  "blocked": true,
  "blockers": [
    "migration_063_required",
    "internal_record_not_available"
  ],
  "request_id": 1,
  "record_preview": {
    "request_id": 1,
    "execution_type": "manual_review_task",
    "status": "preflight_failed",
    "actor": "operator",
    "reason": "internal manual review task validation",
    "internal_task_result": {},
    "safety_flags": {
      "marketplace_api_calls": false,
      "price_changes": false,
      "inventory_changes": false,
      "listing_changes": false,
      "external_action_executed": false,
      "marketplace_execution_approved": false,
      "execution_performed": false
    }
  },
  "event_preview": null
}
```

Dry-run did not write database rows.

### Migration 063 status

Command:

```bash
node - <<'NODE'
// Supabase select against hermes_internal_execution_records
NODE
```

Observed result:

```json
{
  "migration_063_applied": false,
  "code": "PGRST205",
  "message": "Could not find the table 'public.hermes_internal_execution_records' in the schema cache",
  "sample": []
}
```

Because migration 063 is not yet visible to the active Supabase API schema cache, the requested conditional write command was not run.

The skipped conditional write command is:

```bash
npm run hermes:agent -- execution-record-internal-task --id=1 --actor=operator --reason="internal manual review task validation" --write
```

### Detail validation

Command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed summary:

- output includes `executor_preflight`;
- output includes `internal_execution_records`;
- executor preflight reports `execution_available = false`;
- executor preflight reports `internal_record_available = false` until migration 063 is applied;
- current dry-run hash matches final approval dry-run hash;
- final approval status is `approved`;
- final approval actor is `operator`;
- `executed_at = null`;
- `execution_result = null`;
- `external_action_executed = false`;
- `marketplace_execution_approved = false`.

### Summary validation

Command:

```bash
npm run hermes:agent -- execution-summary --limit=50
```

Observed summary:

```json
{
  "read_only": true,
  "scanned_request_count": 2,
  "counts_by_status": {
    "approved": 1,
    "dry_run_ready": 1
  },
  "counts_by_final_approval_status": {
    "not_requested": 1,
    "approved": 1
  },
  "counts_by_execution_type": {
    "manual_review_task": 2
  },
  "counts_by_risk_level": {
    "low": 2
  },
  "execution_events_count": 0,
  "no_execution_events": true,
  "internal_task_recorded_count": 0,
  "internal_execution_records_migration_required": true,
  "recent_internal_task_records": [],
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "final_approval_approved_count": 1,
    "internal_task_recorded_count": 0,
    "executed_request_count": 0
  }
}
```

### Direct safety assertions

Read-only direct DB assertions for request id `1`:

```json
{
  "request_id": 1,
  "status": "dry_run_ready",
  "execution_type": "manual_review_task",
  "risk_level": "low",
  "final_approval_status": "approved",
  "final_approval_actor": "operator",
  "final_approval_dry_run_hash_present": true,
  "executed_at_null": true,
  "execution_result_null": true,
  "external_action_false": true,
  "marketplace_execution_false": true,
  "execution_lifecycle_event_count": 0,
  "internal_task_recorded_event_count": 0
}
```

## Safety audit

Focused safety grep was run against Phase 7 touched code and migration.

Observed:

```text
marketplace write APIs: none
AI/external API indicators: none
route POST/PUT/PATCH/DELETE: none
route DB writes: none
```

UI grep returned only safe text/rendering occurrences:

```text
No approve/reject/cancel controls, no execution controls, no DB writes, no marketplace writes.
rejected / cancelled requests read-only label
executor preflight rendering labels
```

Confirmed:

- no marketplace execution;
- no marketplace API calls;
- no price changes;
- no inventory changes;
- no listing revisions;
- no write HTTP endpoints;
- no UI write calls;
- no execute buttons;
- no marketplace buttons;
- no AI calls;
- no scheduler.

## Remaining limitations

1. Migration 063 exists in the repository but is not yet visible to the active Supabase API schema cache in this validation run.
2. The internal task write command was not run because preflight did not allow it while migration 063 was unavailable.
3. No marketplace executor exists.
4. Only `manual_review_task` is eligible for future internal recording.
5. `price_change`, `inventory_change`, and `listing_update` remain forbidden.
6. No rollback/compensation workflow exists for marketplace actions because marketplace actions are still unavailable.

## Verdict

Phase 7B-D implementation is complete in code and documentation.

The implementation provides deterministic preflight, dry-run-first internal task recording logic, read-only detail/summary visibility, and UI display for executor preflight/internal records.

No marketplace execution was implemented.
