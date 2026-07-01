# Hermes Phase 7A — Limited Executor Architecture Design

Report timestamp: 2026-07-01T15:31:15Z

## Purpose

Phase 7A defines the architecture for a future limited executor, but does not implement it.

This phase is documentation-only.

No executor code is added. No migrations are added. No CLI commands, API endpoints, UI buttons, database writes, marketplace calls, price changes, inventory changes, or listing updates are introduced in this phase.

Baseline:

```text
b78c3a3 Add Phase 6 internal final approval workflow
```

Phase 6 established internal final approval only. Final approval remains distinct from execution.

## Safety boundary

The Phase 7A design keeps these boundaries:

- Executor design only.
- No executor implementation.
- No marketplace execution.
- No marketplace API calls.
- No eBay/Shopee/Shopify write calls.
- No price changes.
- No inventory changes.
- No listing changes.
- No scheduler.
- No AI calls.
- No new migration.
- No DB writes.
- No CLI/API/UI implementation.

## 1. Executor scope

### Allowed future executor type

A future Phase 7 executor may support exactly one execution type:

```text
manual_review_task
```

This executor type is internal-only. It may record that an operator-facing internal task/result was created from an approved Hermes execution request. It must not perform marketplace actions.

### Explicitly forbidden future executor types

The limited executor must reject these execution types:

```text
price_change
inventory_change
listing_update
listing_quality_update
cost_data_update
enrichment_run
```

The limited executor must also reject:

```text
any marketplace write
```

Forbidden side effects include, but are not limited to:

- eBay listing revisions;
- Shopee listing updates;
- Shopify product or inventory writes;
- price updates;
- stock/inventory quantity updates;
- listing title/subtitle/description/image/specifics updates;
- cost data mutation;
- enrichment batch execution;
- repricing pipeline live execution;
- any external HTTP write side effect.

## Scope decision

`manual_review_task` is the only safe Phase 7 target because it represents an internal operator task. It can be satisfied without marketplace adapters and without changing commercial data.

All non-manual execution types require a separate design and approval process because they may mutate marketplace state or business-critical inventory/price data.

## 2. Preconditions for any future executor

A future executor must run a strict preflight before recording any internal task/result.

All of these preconditions must pass:

1. `request.status = dry_run_ready`
2. `final_approval_status = approved`
3. `final_approval_actor` exists and is non-empty
4. `final_approval_dry_run_hash` matches the current `dry_run_result` hash
5. `executed_at is null`
6. `execution_result is null`
7. `metadata.external_action_executed = false`
8. `metadata.marketplace_execution_approved = false`
9. `execution_type = manual_review_task`
10. `risk_level = low`
11. hard off-switch is enabled

### Hard off-switch requirement

A future executor must be disabled unless an explicit local/offline hard off-switch permits internal execution recording.

Recommended future variable name:

```text
HERMES_INTERNAL_EXECUTOR_ENABLED=true
```

Rules:

- Missing value must be treated as disabled.
- Any value other than exact `true` must be treated as disabled.
- The flag allows only internal `manual_review_task` recording.
- The flag must not enable marketplace writes.
- Marketplace writes require a separate future phase and a separate explicit control.

### Final approval hash requirement

The executor must recompute the hash of the current `dry_run_result` using the same stable JSON hashing logic used by Phase 6 final approval.

It must compare:

```text
computed_current_dry_run_hash === final_approval_dry_run_hash
```

If the hash differs, the executor must block.

The purpose is to prevent execution based on stale final approval when dry-run output changed.

## 3. Executor behavior

For a future Phase 7 implementation, the limited executor may only create an internal task/result record.

Allowed future behavior:

- run preflight checks;
- record preflight events;
- create or update an internal-only task/result artifact;
- mark the internal task/result as recorded;
- attach a summary of the final approval and dry-run hash;
- preserve all marketplace safety flags as false.

Forbidden future behavior:

- call marketplace APIs;
- revise listings;
- change prices;
- change inventory;
- update listing quality fields;
- update cost data;
- trigger enrichment runs;
- run repricing;
- create a scheduler;
- call AI;
- perform external HTTP write calls;
- mark `metadata.marketplace_execution_approved = true`;
- mark `metadata.external_action_executed = true`;
- create any marketplace execution payload.

### Internal task/result record concept

A future internal task/result record should represent an operator-facing instruction such as:

```json
{
  "request_id": 1,
  "execution_type": "manual_review_task",
  "sku": "202551129453",
  "source": "hermes_limited_executor",
  "result_type": "internal_task_recorded",
  "execution_performed": false,
  "marketplace_api_calls": false,
  "external_action_executed": false,
  "marketplace_execution_approved": false
}
```

The task/result record is not marketplace execution. It is a durable internal workflow artifact for human operators.

## 4. Required audit events

Future Phase 7 implementation should define these events:

```text
execution_preflight_started
execution_preflight_passed
execution_preflight_failed
internal_task_recorded
```

This Phase 7A design does not create events.

### Event semantics

#### execution_preflight_started

Purpose:

- records that the executor evaluated a request;
- includes actor and request id;
- does not imply execution.

Expected payload fields:

```json
{
  "request_id": 0,
  "actor": "...",
  "execution_type": "manual_review_task",
  "risk_level": "low",
  "started_at": "ISO8601",
  "marketplace_api_calls": false
}
```

#### execution_preflight_passed

Purpose:

- records that all preconditions passed;
- still does not imply marketplace execution.

Expected payload fields:

```json
{
  "request_id": 0,
  "actor": "...",
  "dry_run_hash_verified": true,
  "final_approval_verified": true,
  "allowed_execution_type": true,
  "hard_off_switch_enabled": true,
  "marketplace_api_calls": false
}
```

#### execution_preflight_failed

Purpose:

- records that preflight blocked internal task/result recording;
- includes blockers;
- does not mutate execution outcome fields.

Expected payload fields:

```json
{
  "request_id": 0,
  "actor": "...",
  "blockers": [],
  "marketplace_api_calls": false,
  "execution_performed": false
}
```

#### internal_task_recorded

Purpose:

- records that an internal manual review task/result was recorded;
- does not indicate marketplace execution.

Expected payload fields:

```json
{
  "request_id": 0,
  "actor": "...",
  "execution_type": "manual_review_task",
  "result_type": "internal_task_recorded",
  "execution_performed": false,
  "external_action_executed": false,
  "marketplace_execution_approved": false,
  "marketplace_api_calls": false
}
```

## 5. Revalidation rules

A future executor must never trust prior summaries alone.

It must re-check all of these immediately before internal task/result recording:

1. current `dry_run_result` hash;
2. `final_approval_dry_run_hash`;
3. current request status;
4. current safety flags;
5. allowed execution type;
6. no previous execution;
7. final approval not expired.

### Dry-run hash revalidation

The executor must compute a stable hash from the current `dry_run_result` and compare it to the stored final approval hash.

If mismatch:

```text
blocker = dry_run_hash_mismatch
```

### Final approval hash revalidation

The executor must verify that final approval references the same dry-run hash.

If missing:

```text
blocker = final_approval_dry_run_hash_missing
```

If mismatched:

```text
blocker = final_approval_hash_does_not_match_current_dry_run
```

### Current request status revalidation

Allowed:

```text
dry_run_ready
```

Blocked:

```text
draft
pending_approval
approved
rejected
cancelled
executed
failed
```

### Safety flag revalidation

The executor must require:

```text
metadata.external_action_executed = false
metadata.marketplace_execution_approved = false
```

If either is true, block immediately.

### Allowed execution type revalidation

Allowed:

```text
manual_review_task
```

Any other type must be blocked before any task/result is recorded.

### No previous execution revalidation

The executor must require:

```text
executed_at is null
execution_result is null
```

A future Phase 7 migration may add internal executor result fields. If it does, the executor must also verify no prior internal task/result exists unless the operation is explicitly idempotent and returns the existing result without creating another one.

### Final approval expiration revalidation

If `final_approval_expires_at` exists:

- it must be greater than the current time;
- expired final approval must block execution preflight;
- expired approval should require a fresh final approval mutation.

If `final_approval_expires_at` is null, Phase 7 may treat it as not expired, but the closeout should recommend adding an expiration policy before marketplace executor design.

## 6. Failure and rollback policy

Phase 7 limited executor is internal-only.

Since no marketplace execution is allowed:

- rollback is internal-only;
- no marketplace rollback is required;
- no price rollback is required;
- no inventory rollback is required;
- no listing rollback is required.

Internal rollback options for future phases:

1. mark the internal task/result as cancelled;
2. append a correction event;
3. mark a duplicate internal task/result as superseded;
4. preserve the original event trail;
5. never delete audit events.

### Marketplace rollback is out of scope

If future marketplace execution is ever introduced, it requires a separate Phase 8 design before any implementation.

Phase 8 design must define:

- marketplace write scope;
- per-marketplace allowlist;
- dry-run/current-state revalidation;
- rollback/compensation behavior;
- failure recovery;
- rate limit behavior;
- idempotency keys;
- operator emergency stop;
- audit and notification requirements.

## 7. Future phase plan

### Phase 7B — migration for internal executor audit/result fields only

Purpose:

- add internal-only fields/tables for executor preflight and internal task/result records;
- no marketplace fields;
- no marketplace executor tables;
- no scheduler fields.

Possible fields:

```text
internal_execution_status
internal_execution_actor
internal_execution_started_at
internal_execution_completed_at
internal_execution_result
internal_execution_policy_version
internal_execution_dry_run_hash
internal_execution_final_approval_hash
```

Status values should avoid implying marketplace execution.

Suggested statuses:

```text
not_started
preflight_passed
internal_task_recorded
blocked
cancelled
```

### Phase 7C — service/CLI preflight only, dry-run default

Purpose:

- implement preflight checks only;
- default to dry-run;
- no task/result creation unless a later phase authorizes it;
- no marketplace calls.

Expected CLI shape:

```bash
npm run hermes:agent -- execution-preflight --id=<REQUEST_ID> --actor=<USER> [--dry-run]
```

Do not add this in Phase 7A.

### Phase 7D — internal manual_review_task execution record only

Purpose:

- after 7B/7C, record an internal task/result for `manual_review_task` only;
- no marketplace execution;
- no price/inventory/listing mutation.

Expected behavior:

- preflight required;
- hard off-switch required;
- internal task/result artifact only;
- event `internal_task_recorded` only.

### Phase 7E — read-only API/UI visibility

Purpose:

- expose preflight/internal-task state through GET endpoints and read-only UI;
- no write endpoints;
- no buttons for marketplace execution.

### Phase 7F — closeout

Purpose:

- verify internal-only executor design/implementation boundaries;
- validate no marketplace calls;
- document lifecycle and remaining limitations.

### Phase 8 — marketplace executor design only, not implementation

Purpose:

- design marketplace executor constraints;
- no implementation;
- no marketplace API calls;
- no price/inventory/listing changes.

Phase 8 must be design-only first.

## 8. Validation plan for Phase 7A

Because Phase 7A is documentation-only, validation must prove only this document changed.

Required validation:

```bash
git diff --stat
git diff --name-only
git status --short
```

Expected changed file:

```text
docs/phase-7a-limited-executor-design.md
```

Safety grep against Phase 6 code:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js supabase/migrations/062_hermes_final_approval.sql || true
```

Expected result:

```text
no marketplace write API matches
```

Also verify no implementation files changed:

```bash
git diff --name-only | grep -E '^(src|scripts|public|supabase)/' || true
```

Expected result:

```text
empty
```

## Final Phase 7A decision

Phase 7A authorizes design only.

The only future executor type under consideration is `manual_review_task`, and even that future implementation may only record an internal task/result. It must not call marketplace APIs, change listings, change price, change inventory, or perform any external write.

Marketplace executor design is deferred to Phase 8 and must be design-only before any marketplace execution implementation is considered.
