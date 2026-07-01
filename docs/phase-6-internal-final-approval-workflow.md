# Hermes Phase 6B-D — Internal Final Approval Workflow

Report timestamp: 2026-07-01T15:22:28Z

## Purpose

Phase 6B-D implements an internal-only final approval workflow for Hermes execution requests.

Final approval is not marketplace execution.

This implementation records an internal operator authorization checkpoint only. It does not implement an executor, does not call marketplace APIs, and does not change price, inventory, or listings.

Baseline:

```text
de565a1 Add Phase 6A final approval workflow design
```

## Scope

Implemented in this phase:

- migration 062 for internal final approval fields;
- service mutation preview/write function for internal final approval;
- CLI command for final approval preview/write;
- read-only detail/summary visibility for final approval fields;
- read-only UI display of final approval status and snapshot;
- closeout documentation.

Not implemented:

- marketplace execution;
- executor service;
- executor CLI;
- write HTTP endpoint;
- UI final approval button;
- UI execute button;
- scheduler;
- AI calls;
- eBay/Shopee/Shopify API calls;
- price, inventory, or listing changes.

## Migration summary

Created:

```text
supabase/migrations/062_hermes_final_approval.sql
```

Migration 062 adds these internal-only columns to `hermes_execution_requests`:

```text
final_approval_status text default 'not_requested'
final_approval_actor text
final_approval_reason text
final_approved_at timestamp
final_approval_policy_version text
final_approval_dry_run_hash text
final_approval_snapshot jsonb
final_approval_rejected_actor text
final_approval_rejected_at timestamp
final_approval_rejection_reason text
final_approval_expires_at timestamp
```

Allowed `final_approval_status` values:

```text
not_requested
approved
rejected
expired
```

The migration adds no executor fields and no marketplace fields.

It also adds indexes for final approval status, actor, and expiration visibility.

## Service behavior

Updated:

```text
src/services/hermesExecutionApproval.js
```

Added exported function:

```js
recordFinalApproval({ requestId, actor, reason, confirmations, dryRun })
```

Default behavior:

```text
dryRun = true
```

Write mode requires:

- explicit `actor`;
- explicit `reason`;
- request status is `dry_run_ready`;
- `dry_run_result` exists;
- readiness summary has `ready_for_final_approval === true`;
- final approval checklist has no blocking conditions;
- `executed_at` is null;
- `execution_result` is null;
- `metadata.external_action_executed` is false;
- `metadata.marketplace_execution_approved` is false;
- request is not already finally approved.

Dry-run mode returns:

- preview of final approval fields;
- deterministic dry-run hash;
- final approval snapshot;
- event preview for `final_approval_recorded`;
- safety flags showing no execution.

Write mode updates only internal final approval fields:

```text
final_approval_status = approved
final_approval_actor
final_approval_reason
final_approved_at
final_approval_policy_version
final_approval_dry_run_hash
final_approval_snapshot
metadata.hermes_final_approval
metadata.external_action_executed = false
metadata.marketplace_execution_approved = false
executed_at = null
execution_result = null
```

Write mode inserts only one internal audit event:

```text
final_approval_recorded
```

The service does not import marketplace connectors, AI clients, HTTP clients, or scheduler code.

## CLI usage

Updated:

```text
scripts/hermes-agent.js
```

Added command:

```bash
npm run hermes:agent -- execution-final-approve --id=<REQUEST_ID> --actor=<USER> --reason="..." [--dry-run|--write]
```

Examples:

```bash
npm run hermes:agent -- execution-final-approve --id=1 --actor=operator --reason="internal final approval validation" --dry-run
```

```bash
npm run hermes:agent -- execution-final-approve --id=1 --actor=operator --reason="internal final approval validation" --write
```

Default is dry-run unless `--write` is explicitly provided.

## Read-only visibility

Updated existing detail output:

```text
npm run hermes:agent -- execution-detail --id=1
GET /api/hermes-execution/requests/:id
```

Detail now includes:

```text
final_approval_summary
```

The summary includes:

- status;
- actor;
- reason;
- approved timestamp;
- policy version;
- dry-run hash;
- final approval snapshot;
- rejection/expiration fields;
- execution availability false;
- marketplace/external safety flags.

Updated existing summary output:

```text
npm run hermes:agent -- execution-summary --limit=50
GET /api/hermes-execution/summary
```

Summary now includes:

```text
counts_by_final_approval_status
safety_summary.final_approval_approved_count
```

Updated read-only UI:

```text
public/js/hermesExecutionRequests.js
```

The UI displays:

- counts by final approval status;
- row-level final approval status;
- final approval status panel;
- actor;
- reason;
- policy version;
- dry-run hash;
- timestamp;
- final approval snapshot.

The UI still uses only existing GET endpoints. It adds no final approval button, execute button, or write HTTP call.

## Validation output

### Syntax checks

Command:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/web/routes/hermesExecutionRequests.js
node --check public/js/hermesExecutionRequests.js
```

Observed result: passed.

### Final approval checklist

Command:

```bash
npm run hermes:agent -- execution-final-checklist --id=1
```

Observed summary:

```json
{
  "request_id": 1,
  "status": "dry_run_ready",
  "final_approval_available": true,
  "execution_available": false,
  "policy_version": "phase-6-internal-final-approval-v1",
  "blocking_conditions": [],
  "safety": {
    "read_only": true,
    "final_approval_write_implemented": true,
    "execution_implemented": false,
    "external_action_executed": false,
    "marketplace_execution_approved": false
  }
}
```

### Final approval dry-run preview

Command:

```bash
npm run hermes:agent -- execution-final-approve --id=1 --actor=operator --reason="internal final approval validation" --dry-run
```

Observed summary:

```json
{
  "dry_run": true,
  "updated": false,
  "blocked": false,
  "request_id": 1,
  "after": {
    "final_approval_status": "approved",
    "final_approval_actor": "operator",
    "final_approval_reason": "internal final approval validation",
    "final_approval_policy_version": "phase-6-internal-final-approval-v1",
    "final_approval_dry_run_hash": "sha256:b55d6ffe781564a62f2c64d894451a3b8bcdc1d8565ab1e6b58b9cb3441b07c3",
    "executed_at": null,
    "execution_result": null
  },
  "event_preview": {
    "event_type": "final_approval_recorded",
    "actor": "operator"
  },
  "safety": {
    "final_approval_is_marketplace_execution": false,
    "marketplace_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_changes": false,
    "execution_performed": false,
    "external_action_executed": false
  }
}
```

Dry-run mode did not write database rows.

### Migration 062 application status and write validation

After operator confirmation, a direct read verified migration 062 was applied and the final approval columns were available:

```json
{
  "migration_062_applied": true,
  "data": {
    "id": 1,
    "status": "dry_run_ready",
    "final_approval_status": "not_requested",
    "final_approval_actor": null,
    "final_approved_at": null,
    "executed_at": null,
    "execution_result": null,
    "external_action_executed": false,
    "marketplace_execution_approved": false
  }
}
```

The conditional write validation was then run:

```bash
npm run hermes:agent -- execution-final-approve --id=1 --actor=operator --reason="internal final approval validation" --write
```

Observed summary:

```json
{
  "dry_run": false,
  "updated": true,
  "blocked": false,
  "request_id": 1,
  "after": {
    "final_approval_status": "approved",
    "final_approval_actor": "operator",
    "final_approval_reason": "internal final approval validation",
    "final_approval_policy_version": "phase-6-internal-final-approval-v1",
    "final_approval_dry_run_hash": "sha256:b55d6ffe781564a62f2c64d894451a3b8bcdc1d8565ab1e6b58b9cb3441b07c3",
    "executed_at": null,
    "execution_result": null
  },
  "event": {
    "event_type": "final_approval_recorded",
    "actor": "operator"
  },
  "safety": {
    "final_approval_is_marketplace_execution": false,
    "marketplace_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_changes": false,
    "execution_performed": false,
    "external_action_executed": false
  }
}
```

A post-write checklist run now correctly reports `final_approval_available=false` with blocker `final approval is already recorded`.

### Detail validation

Command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed summary:

- request status: `dry_run_ready`;
- readiness summary ready for final approval: `true`;
- final approval checklist available: `true`;
- final approval summary status: `approved`;
- final approval actor: `operator`;
- final approval policy version: `phase-6-internal-final-approval-v1`;
- `executed_at = null`;
- `execution_result = null`;
- `metadata.external_action_executed = false`;
- `metadata.marketplace_execution_approved = false`;
- `execution_performed = false`.

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
  "safety_summary": {
    "external_actions_detected": 0,
    "marketplace_execution_approved_count": 0,
    "final_approval_approved_count": 1,
    "executed_request_count": 0
  }
}
```

### Direct DB safety assertions

Read-only DB assertion for request id `1`:

```json
{
  "request_id": 1,
  "status": "dry_run_ready",
  "final_approval_status_approved": true,
  "final_approval_actor_operator": true,
  "final_approval_reason_present": true,
  "final_approval_policy_version": "phase-6-internal-final-approval-v1",
  "final_approval_dry_run_hash_present": true,
  "final_approval_snapshot_present": true,
  "executed_at_null": true,
  "execution_result_null": true,
  "external_action_false": true,
  "marketplace_execution_false": true,
  "execution_lifecycle_event_count": 0,
  "no_execution_lifecycle_event": true,
  "final_approval_recorded_event_count": 1
}
```

## Safety audit

Focused safety grep was run against Phase 6 touched service, CLI, read-only route, UI, and migration.

Observed:

```text
Prohibited marketplace write APIs: none
Route POST/PUT/PATCH/DELETE: none
Route DB writes: none
AI/external API indicators: none
```

Focused UI grep returned only safe text occurrences:

```text
5: safety comment saying no approve/reject/cancel controls, no execution controls, no DB writes, no marketplace writes
217: rejected / cancelled requests read-only section label
```

Confirmed:

- no marketplace execution;
- no executor;
- no marketplace API calls;
- no price changes;
- no inventory changes;
- no listing revisions;
- no write HTTP endpoints;
- no UI write calls;
- no final approval buttons;
- no execute buttons;
- no AI calls;
- no scheduler.

## Remaining limitations

1. No rejection or expiration mutation command was implemented in this combined phase; only `final_approval_recorded` was requested.
2. Request id `1` is now internally finally approved and duplicate final approval is blocked by the checklist/write preconditions.
3. Final approval does not execute anything.
4. No executor exists.
5. No marketplace adapter exists.
6. No rollback/compensation workflow exists because no external execution exists.

## Verdict

Phase 6B-D implementation is complete in code and documentation.

Internal final approval is implemented as a dry-run-first, write-gated internal mutation path with read-only visibility. It preserves the boundary that final approval is not marketplace execution and execution remains disabled.