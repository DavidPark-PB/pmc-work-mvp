# Hermes Phase 7G — Internal Executor Migration Validation

Report timestamp: 2026-07-01T15:52:33Z

## Purpose

Phase 7G applies/verifies migration 063 against the active Supabase database and validates the internal-only `manual_review_task` record path.

This is not marketplace execution.

No marketplace executor was implemented. No marketplace APIs were called. No price, inventory, or listing changes were made.

Baseline:

```text
2f6d76c Add Phase 7 internal limited executor records
de14e1d Add Phase 7A limited executor design
b78c3a3 Add Phase 6 internal final approval workflow
```

## Migration 063 verification

Migration file:

```text
supabase/migrations/063_hermes_internal_executor_records.sql
```

Target table:

```text
hermes_internal_execution_records
```

Initial active Supabase/PostgREST visibility check:

```json
{
  "postgrest_visible": true,
  "count": 0,
  "code": null,
  "message": null,
  "sample": []
}
```

Required column visibility check:

```json
{
  "table_visible": true,
  "required_columns_visible": true,
  "columns": [
    "id",
    "request_id",
    "execution_type",
    "status",
    "actor",
    "reason",
    "preflight_result",
    "internal_task_result",
    "safety_flags",
    "created_at"
  ],
  "code": null,
  "message": null,
  "sample": []
}
```

Conclusion:

- `hermes_internal_execution_records` exists.
- Supabase/PostgREST schema cache can see it.
- All required Phase 7G columns are visible.
- No schema cache refresh was required during this run.

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/web/routes/hermesExecutionRequests.js
node --check public/js/hermesExecutionRequests.js
```

Result: passed.

Preflight command:

```bash
npm run hermes:agent -- execution-preflight --id=1
```

Pre-write preflight result summary:

```json
{
  "request_id": 1,
  "sku": "202551129453",
  "status": "dry_run_ready",
  "execution_type": "manual_review_task",
  "risk_level": "low",
  "allowed": true,
  "execution_available": false,
  "internal_record_available": true,
  "blockers": [],
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
  "internal_execution_records": {
    "count": 0,
    "data": [],
    "migration_required": false
  },
  "migration_required": false,
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

Dry-run internal task command:

```bash
npm run hermes:agent -- execution-record-internal-task --id=1 --actor=operator --reason="internal manual review task validation" --dry-run
```

Dry-run result summary:

```json
{
  "dry_run": true,
  "created": false,
  "blocked": false,
  "request_id": 1,
  "record_preview": {
    "request_id": 1,
    "execution_type": "manual_review_task",
    "status": "internal_task_recorded",
    "actor": "operator",
    "reason": "internal manual review task validation",
    "internal_task_result": {
      "result_type": "internal_task_recorded",
      "execution_performed": false,
      "marketplace_api_calls": false,
      "price_changes": false,
      "inventory_changes": false,
      "listing_changes": false,
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "event_preview": {
    "event_type": "internal_task_recorded",
    "actor": "operator"
  }
}
```

Write command:

```bash
npm run hermes:agent -- execution-record-internal-task --id=1 --actor=operator --reason="internal manual review task validation" --write
```

Write result summary:

```json
{
  "dry_run": false,
  "created": true,
  "blocked": false,
  "request_id": 1,
  "record": {
    "id": 1,
    "request_id": 1,
    "execution_type": "manual_review_task",
    "status": "internal_task_recorded",
    "actor": "operator",
    "reason": "internal manual review task validation",
    "created_at": "2026-07-01T15:51:16.784876"
  },
  "event": {
    "id": 7,
    "request_id": 1,
    "event_type": "internal_task_recorded",
    "actor": "operator",
    "created_at": "2026-07-01T15:51:16.995761"
  },
  "safety": {
    "marketplace_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_changes": false,
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "execution_performed": false
  }
}
```

Detail command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed:

- detail includes `executor_preflight`;
- detail includes `internal_execution_records`;
- one internal execution record exists;
- record status is `internal_task_recorded`;
- record actor is `operator`;
- record reason is `internal manual review task validation`;
- post-write preflight blocks duplicate recording with `internal_task_already_recorded`;
- `execution_available` remains false;
- request `executed_at` remains null;
- request `execution_result` remains null;
- external/marketplace flags remain false.

Summary command:

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
  "internal_task_recorded_count": 1,
  "internal_execution_records_migration_required": false,
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "final_approval_approved_count": 1,
    "internal_task_recorded_count": 1,
    "executed_request_count": 0
  }
}
```

## Post-write safety assertions

Direct DB assertions after the internal task write:

```json
{
  "request_id": 1,
  "table_visible": true,
  "internal_task_record_exists": true,
  "internal_task_record_count": 1,
  "internal_task_record_status": "internal_task_recorded",
  "internal_task_record_actor": "operator",
  "internal_task_record_reason": "internal manual review task validation",
  "internal_task_record_event_exists": true,
  "internal_task_recorded_event_count": 1,
  "executed_at_null": true,
  "execution_result_null": true,
  "metadata_external_action_executed_false": true,
  "metadata_marketplace_execution_approved_false": true,
  "no_execution_lifecycle_event": true,
  "execution_lifecycle_event_count": 0,
  "no_marketplace_api_call_in_record": true,
  "no_price_change_in_record": true,
  "no_inventory_change_in_record": true,
  "no_listing_change_in_record": true,
  "sample_record_id": 1,
  "sample_record_created_at": "2026-07-01T15:51:16.784876"
}
```

Verified:

- internal task record exists;
- internal task record status is `internal_task_recorded`;
- `internal_task_recorded` event exists;
- `executed_at` is still null;
- `execution_result` is still null;
- `metadata.external_action_executed` is false;
- `metadata.marketplace_execution_approved` is false;
- no `request_executed`, `execution_started`, or `execution_completed` event exists;
- no marketplace API call occurred;
- no price change occurred;
- no inventory change occurred;
- no listing change occurred.

## Safety grep

Focused safety grep output:

```text
marketplace write APIs: none
AI/external API indicators: none
route POST/PUT/PATCH/DELETE / DB writes: none
```

UI HTTP write method grep returned only safe text/labels:

```text
No approve/reject/cancel controls, no execution controls, no DB writes, no marketplace writes.
rejected / cancelled requests read-only label
```

## No marketplace execution boundary

Phase 7G validated only an internal `manual_review_task` record.

It did not:

- implement a marketplace executor;
- call marketplace APIs;
- change price;
- change inventory;
- revise listings;
- add price/inventory/listing execution paths;
- add HTTP write endpoints;
- add UI write buttons;
- call AI APIs;
- install a scheduler.

## Final verdict

Phase 7G is complete.

Migration 063 is applied and visible to the active Supabase/PostgREST schema. The internal-only `manual_review_task` record write path was validated successfully with one internal record and one `internal_task_recorded` event, while all marketplace and execution fields remained disabled/null/false.
