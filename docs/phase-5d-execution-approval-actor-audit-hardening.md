# Hermes Phase 5D — Execution Approval Actor/Audit Hardening

Report timestamp: 2026-07-01T12:47:04Z

## Purpose

Phase 5D fixes the Phase 5C actor audit weakness where non-numeric CLI actors such as `operator` were stored as `approved_by = 0` because migration 060 used integer review columns.

Phase 5D keeps the same safety boundary: internal approval/audit workflow only, with no executor and no marketplace action.

Baseline:

```text
0a4fe67 Add Phase 5C execution request review workflow
```

## Problem

Migration 060 defined review columns as integers:

- `approved_by integer`
- `rejected_by integer`
- `executed_by integer`

Phase 5C accepted string actors through the CLI:

```bash
npm run hermes:agent -- execution-review --id=1 --action=approve --actor=operator --write
```

To make the integer review field visibly set, Phase 5C stored non-numeric actors as `0` in integer columns and preserved the real actor in event/metadata JSON.

That was audit-weak because:

- `approved_by = 0` is not a real user id.
- text actors were not queryable as first-class columns.
- cancellation had no dedicated cancellation columns.

## Additive migration summary

Created additive migration:

```text
supabase/migrations/061_hermes_execution_actor_audit.sql
```

Migration 060 was not edited.

Migration 061 adds text actor columns:

- `approved_actor text`
- `rejected_actor text`
- `cancelled_actor text`

Migration 061 adds cancellation-specific fields:

- `cancelled_by integer`
- `cancelled_at timestamp`
- `cancellation_reason text`

Migration 061 also adds indexes for actor lookups:

- `idx_hermes_execution_requests_approved_actor`
- `idx_hermes_execution_requests_rejected_actor`
- `idx_hermes_execution_requests_cancelled_actor`

## Backfill and normalization

Migration 061 backfills text actors from metadata where available:

- `approved_actor` from `metadata.hermes_execution_review.actor` for approved rows
- `rejected_actor` from `metadata.hermes_execution_review.actor` for rejected rows
- `cancelled_actor` from `metadata.hermes_execution_review.actor` for cancelled rows

Migration 061 normalizes placeholder integer actor values:

- `approved_by = 0` -> `approved_by = null`
- `rejected_by = 0` -> `rejected_by = null`
- `cancelled_by = 0` -> `cancelled_by = null`

Operator applied migration 061 manually in Supabase SQL Editor, then confirmed:

```text
migration 061 applied
```

Post-apply verification of pre-existing request id `1` showed the backfill worked:

```json
{
  "id": 1,
  "status": "approved",
  "approved_by": null,
  "approved_actor": "operator",
  "approved_at": "2026-07-01T00:34:47.886",
  "executed_at": null,
  "execution_result": null,
  "metadata": {
    "hermes_execution_review": {
      "actor": "operator",
      "action": "approve",
      "external_action_executed": false
    },
    "external_action_executed": false,
    "marketplace_execution_approved": false
  }
}
```

## Service update

Updated:

```text
src/services/hermesExecutionApproval.js
```

Changes:

- non-numeric actors are no longer stored as `0`
- numeric actor strings populate integer `*_by` columns
- non-numeric actors populate text `*_actor` columns
- `metadata.hermes_execution_review.actor` remains preserved
- approve writes:
  - `approved_by`
  - `approved_actor`
  - `approved_at`
- reject writes:
  - `rejected_by`
  - `rejected_actor`
  - `rejected_at`
  - `rejection_reason`
- cancel writes:
  - `cancelled_by`
  - `cancelled_actor`
  - `cancelled_at`
  - `cancellation_reason`
- approval/rejection/cancellation still do not execute anything

No CLI change was required beyond the existing Phase 5C commands.

## SQL sanity check

No local `psql` or `supabase` CLI was available in this environment, so a conservative file-level SQL sanity check was run.

Observed:

```json
{
  "add_actor_cols": true,
  "add_cancel_cols": true,
  "backfill_metadata_actor": true,
  "normalize_zero": true,
  "balanced_single_quotes": true
}
```

Result: passed.

## Approved opportunity availability

Command:

```bash
npm run hermes:agent -- opportunity-list --status=approved --limit=5
```

Observed approved opportunity:

```json
{
  "id": 4,
  "sku": "202551129453",
  "type": "dead_stock_review",
  "status": "approved",
  "title": "Dead stock review needed for SKU 202551129453"
}
```

## New internal execution request

Request id `1` was already approved from Phase 5C, so Phase 5D created a new internal request from approved opportunity id `4`.

Command:

```bash
npm run hermes:agent -- execution-request --opportunity-id=4 --write
```

Observed summary:

```json
{
  "dry_run": false,
  "created": true,
  "request": {
    "id": 2,
    "opportunity_id": 4,
    "sku": "202551129453",
    "execution_type": "manual_review_task",
    "status": "pending_approval",
    "approved_by": null,
    "approved_actor": null,
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "event": {
    "id": 3,
    "request_id": 2,
    "event_type": "request_created",
    "actor": "hermes-agent-cli",
    "payload": {
      "external_action_executed": false
    }
  }
}
```

This was an internal request/event creation only. It did not approve or execute anything.

## Dry-run validation

Command:

```bash
npm run hermes:agent -- execution-review --id=2 --action=approve --actor=operator --dry-run
```

Observed summary:

```json
{
  "dry_run": true,
  "updated": false,
  "request_id": 2,
  "action": "approve",
  "before": {
    "status": "pending_approval",
    "approved_by": null,
    "approved_actor": null,
    "approved_at": null,
    "executed_at": null,
    "execution_result": null
  },
  "after": {
    "status": "approved",
    "approved_by": null,
    "approved_actor": "operator",
    "approved_at": "preview timestamp",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "hermes_execution_review": {
        "actor": "operator",
        "actor_id": null,
        "actor_text": "operator",
        "external_action_executed": false
      },
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  }
}
```

Post dry-run and negative checks, direct DB verification showed no DB update occurred:

```json
{
  "id": 2,
  "status": "pending_approval",
  "approved_by": null,
  "approved_actor": null,
  "approved_at": null,
  "executed_at": null,
  "execution_result": null,
  "event_count": 1
}
```

Result: passed.

## Negative checks before approval

### Missing actor in write mode

Command:

```bash
npm run hermes:agent -- execution-review --id=2 --action=approve --write
```

Observed:

```text
exit_code=1
actor is required for write mode
```

Result: passed.

### Reject without reason

Command:

```bash
npm run hermes:agent -- execution-review --id=2 --action=reject --actor=operator --write
```

Observed:

```text
exit_code=1
reject requires reason
```

Result: passed.

## Approval write validation

Command:

```bash
npm run hermes:agent -- execution-review --id=2 --action=approve --actor=operator --write
```

Observed summary:

```json
{
  "dry_run": false,
  "updated": true,
  "request_id": 2,
  "action": "approve",
  "after": {
    "status": "approved",
    "approved_by": null,
    "approved_actor": "operator",
    "approved_at": "2026-07-01T12:46:23.171",
    "executed_at": null,
    "execution_result": null,
    "metadata": {
      "hermes_execution_review": {
        "actor": "operator",
        "actor_id": null,
        "actor_text": "operator",
        "external_action_executed": false
      },
      "external_action_executed": false,
      "marketplace_execution_approved": false
    }
  },
  "event": {
    "id": 4,
    "request_id": 2,
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

Result: passed.

## Approved list validation

Command:

```bash
npm run hermes:agent -- execution-list --status=approved --limit=20
```

Observed request id `2` summary:

```json
{
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
      "event_type": "request_created",
      "actor": "hermes-agent-cli",
      "payload": {
        "external_action_executed": false
      }
    },
    {
      "id": 4,
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

## Negative check after approval

### Approve already approved request

Command:

```bash
npm run hermes:agent -- execution-review --id=2 --action=approve --actor=operator --write
```

Observed:

```text
exit_code=1
approve allowed only from pending_approval
```

Result: passed.

## Direct assertions

Direct Supabase client verification of request ids `1` and `2` confirmed:

```json
{
  "assertions": {
    "backfill_approved_actor_operator": true,
    "backfill_approved_by_null": true,
    "approved_actor_operator": true,
    "approved_by_null_for_non_numeric_actor": true,
    "approved_at_set": true,
    "executed_at_null": true,
    "execution_result_null": true,
    "external_action_false": true,
    "request_approved_event_inserted": true,
    "no_execution_event_inserted": true
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
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js supabase/migrations/060_hermes_execution_approval.sql supabase/migrations/061_hermes_execution_actor_audit.sql || true

grep -RInE 'callTradingAPI|callShoppingAPI|Browse|openai|anthropic|claude|axios|fetch\(' \
  src/services/hermesExecutionApproval.js || true
```

Observed:

```text
Prohibited marketplace write APIs: none
External API / AI indicators in Phase 5D service: none
```

## Final verification summary

Phase 5D validation passed:

- Migration 061 was applied.
- Text actor columns exist and are readable.
- Cancellation-specific fields exist and are readable.
- Backfill moved request id `1` actor to `approved_actor = operator`.
- Backfill normalized request id `1` `approved_by` from `0` to `null`.
- A new internal request id `2` was created from approved opportunity id `4` because id `1` was already approved.
- Approval dry-run for id `2` previewed `approved_actor = operator` and `approved_by = null` without DB changes.
- Approval write for id `2` set `approved_actor = operator` and kept `approved_by = null` for non-numeric actor.
- `approved_at` is set.
- `executed_at` remains null.
- `execution_result` remains null.
- `metadata.external_action_executed` remains false.
- `request_approved` event was inserted.
- No execution event was inserted.
- Missing actor in write mode fails.
- Reject without reason fails.
- Approving an already approved request is blocked.
- No marketplace action occurred.

## Safety audit

Phase 5D performed internal schema/application hardening only.

Not performed:

- No executor implementation.
- No marketplace API call.
- No price update.
- No inventory update.
- No listing revision.
- No AI call.
- No scheduler installation.
- No automatic approval beyond the explicit internal validation request.
- No request execution.

## Phase 5E recommendation

Phase 5E should add read-only approval visibility and/or a review UI/API for execution requests.

Recommended constraints:

- Keep execution requests internal-only.
- Show `approved_actor`, `rejected_actor`, and `cancelled_actor` in review surfaces.
- Keep approval/rejection/cancellation dry-run-first.
- Do not implement marketplace execution yet.
- If an executor is later introduced, start with dry-run executor plans and audit events only before any external write capability.

## Phase 5D verdict

Phase 5D is complete.

The actor audit weakness is fixed with additive migration 061 and service updates. Non-numeric actors are now stored in dedicated text actor columns, integer actor columns remain null for non-numeric actors, and all Phase 5 approval workflows remain internal-only and non-executing.
