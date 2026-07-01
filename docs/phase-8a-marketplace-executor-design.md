# Hermes Phase 8A — Marketplace Executor Architecture Design

Report timestamp: 2026-07-02T00:00:00Z

## Purpose

Phase 8A defines a future marketplace executor architecture for Hermes.

This phase is documentation-only.

It does not implement marketplace execution. It does not add migrations, CLI commands, API endpoints, UI buttons, marketplace adapters, scheduler behavior, database writes, or marketplace writes.

Baseline:

```text
ac5430c Add Phase 7G internal executor migration validation
2f6d76c Add Phase 7 internal limited executor records
de14e1d Add Phase 7A limited executor design
b78c3a3 Add Phase 6 internal final approval workflow
```

Phase 7 validated only the internal `manual_review_task` record path. Phase 8A does not expand that into marketplace execution; it only specifies what a later marketplace executor design must require before any implementation is considered.

## Safety boundary

Phase 8A preserves these boundaries:

- Marketplace executor is future-only.
- This phase is design-only.
- No marketplace writes.
- No marketplace API calls.
- No price changes.
- No inventory changes.
- No listing changes.
- No marketplace executor code.
- No migrations.
- No CLI commands.
- No API endpoints.
- No UI buttons.
- No AI calls.
- No scheduler.
- No database writes.

## 1. Scope

The future marketplace executor is a separate capability that does not exist in Phase 8A.

Phase 8A only defines:

- future scope boundaries;
- future preconditions;
- future allowlist rules;
- future hash and revalidation policies;
- future rollback/compensation requirements;
- future audit event names;
- future hard stop conditions;
- later phase sequencing.

Phase 8A explicitly does not authorize:

- eBay listing revisions;
- price updates;
- quantity updates;
- listing end/create/relist actions;
- automatic repricing;
- bulk execution;
- cross-marketplace execution;
- any external write.

## 2. Allowed future marketplace execution types

A future marketplace executor may start with only one possible candidate:

```text
listing_quality_update
```

Even this candidate is not implemented in Phase 8A. It is only the first future candidate for a later design and implementation sequence.

### Explicitly forbidden until later

The following execution types and operation classes remain forbidden until separate later phases explicitly design and approve them:

```text
price_change
inventory_change
listing_end
listing_create
auto_repricing
bulk execution
cross-marketplace execution
```

Additional forbidden forms:

- relist operations;
- listing deletion;
- campaign/promotion changes;
- shipping policy changes;
- payment policy changes;
- return policy changes;
- image replacement at scale;
- category changes;
- variation changes;
- SKU remapping;
- any field that can alter price, quantity, availability, or marketplace exposure outside the approved payload.

## 3. Required preconditions before any future marketplace executor

A future marketplace executor must block unless every precondition below passes immediately before execution.

Required request and approval state:

1. `request.status = dry_run_ready`
2. `final_approval_status = approved`
3. `internal_task_recorded` exists
4. `final_approval_dry_run_hash` matches the current `dry_run_result` hash
5. no previous execution lifecycle event exists
6. `executed_at is null`
7. `execution_result is null`
8. `metadata.external_action_executed = false`
9. `metadata.marketplace_execution_approved = false`

Required operation scope:

10. `execution_type` is allowlisted
11. marketplace is allowlisted
12. target listing id is verified
13. current marketplace state is revalidated
14. hard off-switch is enabled
15. operator double-confirmation is present

### Internal task dependency

Phase 7 created an internal limited executor record path. A future marketplace executor must require the existence of an internal record with:

```text
status = internal_task_recorded
execution_type = manual_review_task or a future explicitly linked review artifact
```

The future marketplace executor must not treat final approval alone as sufficient for marketplace execution. It must require an additional internal review/task artifact proving that an operator-facing internal checkpoint occurred after final approval.

### No previous execution lifecycle event

The future marketplace executor must query execution audit events and block if any of these already exist for the request:

```text
request_executed
execution_started
execution_completed
execution_failed
marketplace_execution_started
marketplace_execution_completed
marketplace_execution_failed
```

A duplicate marketplace execution attempt must be blocked by default.

### Hard off-switch

A future marketplace executor must be disabled unless an explicit hard off-switch is enabled.

Suggested future variable name:

```text
HERMES_MARKETPLACE_EXECUTOR_ENABLED=true
```

Rules:

- missing value means disabled;
- any value other than exact `true` means disabled;
- this flag must be separate from the Phase 7 internal executor flag;
- this flag must not enable price, inventory, bulk, or cross-marketplace execution;
- this flag must be checked immediately before execution, not only at process startup.

### Operator double-confirmation

Future marketplace execution requires a second operator confirmation distinct from Phase 6 final approval and Phase 7 internal task recording.

The confirmation must include:

- actor;
- timestamp;
- explicit request id;
- explicit marketplace;
- explicit listing id;
- explicit operation type;
- explicit dry-run hash;
- explicit current-state hash;
- explicit planned mutation hash;
- confirmation phrase or structured checkbox set.

The confirmation must not be inferred from UI page load, final approval, or internal task recording.

## 4. Marketplace write allowlist design

Future marketplace execution must use a strict allowlist.

Initial future allowlist:

```text
marketplace: ebay
operation: listing_quality_update
```

Allowed fields for the first future design:

```text
title
description
item specifics
```

These fields are allowed only if explicitly included in the approved dry-run snapshot.

### Forbidden fields

The future allowlist must reject any payload containing:

```text
price fields
quantity fields
inventory fields
listing end/create/relist fields
shipping policy fields
payment policy fields
return policy fields
category fields
variation fields
SKU remapping fields
promotional campaign fields
```

### No price fields

Any field related to price must hard-stop execution, including but not limited to:

- price;
- start price;
- buy-it-now price;
- sale price;
- minimum advertised price;
- discount;
- promotion price;
- repricing target;
- marketplace fee adjustment fields when represented as listing mutation payload.

### No quantity fields

Any field related to quantity or inventory must hard-stop execution, including but not limited to:

- quantity;
- available quantity;
- inventory level;
- stock count;
- warehouse quantity;
- SKU inventory availability;
- out-of-stock control toggles.

### No listing end/create/relist

The future executor must not perform:

- listing end;
- listing create;
- relist;
- sell-similar;
- duplicate listing creation;
- variation creation;
- listing publication.

The initial future operation can only mutate explicitly approved listing quality fields on an already verified existing eBay listing.

## 5. Dry-run/current-state hash policy

A future marketplace executor must verify all of these hashes before any write:

1. `dry_run_result` hash
2. final approval hash
3. current listing snapshot hash
4. planned mutation hash
5. policy version

### Dry-run result hash

The future executor must recompute a stable JSON hash of the current `dry_run_result` and compare it to the final approval hash.

Required condition:

```text
sha256(stable_json(current_dry_run_result)) == final_approval_dry_run_hash
```

Mismatch must hard-stop execution.

### Final approval hash

The future executor must verify that the stored final approval snapshot references the same dry-run hash used by the execution preflight.

If the final approval hash is missing, stale, or mismatched, the executor must block and require a new dry-run plus new final approval.

### Current listing snapshot hash

Immediately before execution, the future executor must fetch or otherwise revalidate the current marketplace listing state and compute:

```text
current_listing_snapshot_hash
```

That hash must match the approved current-state snapshot hash from the dry-run package.

If the listing changed after approval, the executor must block.

### Planned mutation hash

The future executor must compute a hash of the exact mutation payload it intends to send.

Required condition:

```text
computed_planned_mutation_hash == approved_planned_mutation_hash
```

The mutation payload must be byte/field-equivalent to the approved payload after normalization.

### Policy version

The future executor must record and verify an explicit policy version, for example:

```text
phase-9-ebay-listing-quality-dry-run-v1
```

A marketplace executor must not run under an unknown, missing, or downgraded policy version.

## 6. Rollback and compensation design

A future marketplace executor must define rollback and compensation before any real write is allowed.

Required rollback snapshot fields:

```text
before listing payload
after intended payload
marketplace response
rollback feasibility
manual rollback procedure
```

### Before listing payload

The pre-execution snapshot must include the exact current listing fields that may be changed:

- title;
- description;
- item specifics;
- target listing id;
- marketplace;
- fetched timestamp;
- current listing snapshot hash.

It must not include tokens or credentials.

### After intended payload

The planned payload must include the exact intended field changes:

- normalized title, if applicable;
- normalized description, if applicable;
- normalized item specifics, if applicable;
- planned mutation hash;
- fields omitted from mutation.

Any field not listed in the approved dry-run snapshot must be excluded.

### Marketplace response

The future executor must persist a sanitized marketplace response:

- response status;
- marketplace request id/correlation id;
- success/failure indicator;
- warning messages;
- error codes;
- sanitized response body;
- response timestamp.

It must not persist tokens or secrets.

### Rollback feasibility

Before execution, the executor must classify rollback feasibility:

```text
automatic_possible
manual_required
not_possible
unknown
```

For the first future eBay `listing_quality_update` candidate, the safest default is:

```text
manual_required
```

Automatic rollback must not be implemented until separately designed.

### Manual rollback procedure

The future dry-run package must include a manual rollback procedure that tells an operator how to restore the prior title, description, and item specifics using the stored before payload.

If rollback cannot be safely described, execution must be blocked.

## 7. Audit events for future design

Phase 8A only documents future event names. It does not create events.

Future marketplace audit events:

```text
marketplace_preflight_started
marketplace_preflight_passed
marketplace_preflight_failed
marketplace_execution_started
marketplace_execution_completed
marketplace_execution_failed
marketplace_rollback_required
```

### marketplace_preflight_started

Purpose:

- records that a marketplace preflight began;
- includes actor, request id, marketplace, operation, policy version;
- does not imply execution.

### marketplace_preflight_passed

Purpose:

- records that all marketplace preflight checks passed;
- includes verified hashes and allowlist confirmation;
- still does not imply a write occurred.

### marketplace_preflight_failed

Purpose:

- records a blocked marketplace preflight;
- includes blockers and hard stop conditions;
- must not mutate request execution fields.

### marketplace_execution_started

Purpose:

- records that a real marketplace write attempt is beginning;
- must be inserted only after all preconditions and double-confirmation pass;
- must include an idempotency key and sanitized mutation hash.

### marketplace_execution_completed

Purpose:

- records a successful marketplace write;
- must include sanitized marketplace response metadata;
- must set external execution state only in a future explicitly approved phase.

### marketplace_execution_failed

Purpose:

- records a failed marketplace write attempt;
- must include sanitized error metadata;
- must classify whether rollback/compensation is required.

### marketplace_rollback_required

Purpose:

- records that operator rollback or compensation is required;
- must include rollback instructions and before/after payload references.

## 8. Hard stop conditions

A future marketplace executor must stop if any hard stop condition appears.

Hard stop conditions:

1. price fields appear;
2. quantity fields appear;
3. marketplace token is missing or stale;
4. current listing differs from approved snapshot;
5. dry-run is expired;
6. final approval is expired;
7. previous execution exists;
8. risk level is above allowed threshold;
9. off-switch is disabled.

Additional hard stops:

- execution type is not allowlisted;
- marketplace is not allowlisted;
- target listing id is missing;
- target listing id does not match approved snapshot;
- dry-run hash does not match final approval hash;
- current-state hash does not match approved current-state hash;
- planned mutation hash does not match approved mutation hash;
- operator double-confirmation missing;
- internal task record missing;
- request has `metadata.external_action_executed = true`;
- request has `metadata.marketplace_execution_approved = true` before the future executor sets it under an approved later phase;
- `executed_at` is already populated;
- `execution_result` is already populated;
- execution lifecycle event already exists;
- payload contains unsupported marketplace operation;
- marketplace API indicates listing is ended, inactive, deleted, transferred, or unavailable;
- marketplace API indicates item changed since snapshot;
- rollback procedure missing or invalid.

### Risk threshold

Initial future risk threshold:

```text
risk_level <= medium
```

For Phase 9 dry-run implementation only, no real write is allowed regardless of risk level.

A future real write phase should reconsider whether even medium risk is too high and may restrict first real writes to low risk only.

## 9. Future phase plan

### Phase 8B — marketplace execution audit tables only

Purpose:

- add audit tables/fields for future marketplace preflight and response snapshots;
- no marketplace writes;
- no marketplace API write calls;
- no executor implementation.

Allowed schema concepts:

- marketplace preflight records;
- sanitized current listing snapshot references;
- planned mutation hash;
- rollback feasibility classification;
- sanitized response placeholder fields.

Forbidden schema concepts:

- auto-execute flags;
- bulk execution queues;
- price/inventory write tables;
- stored marketplace tokens;
- scheduler triggers.

### Phase 8C — marketplace preflight service/CLI only, no writes

Purpose:

- implement deterministic marketplace preflight;
- verify allowlist, hashes, state, and hard stop conditions;
- optionally fetch current marketplace state read-only if explicitly allowed by that phase;
- no marketplace writes.

Expected default behavior:

```text
dry-run/preflight only
execution_available = false
marketplace_write_performed = false
```

### Phase 8D — read-only UI/API visibility

Purpose:

- expose marketplace preflight and audit visibility through GET-only routes;
- show blockers and hard stop conditions;
- no POST/PUT/PATCH/DELETE routes;
- no execution buttons;
- no marketplace write controls.

### Phase 8E — closeout

Purpose:

- validate the design/preflight boundary;
- prove no marketplace writes exist;
- document remaining limitations and Phase 9 readiness.

### Phase 9 — single-SKU eBay listing_quality_update dry-run implementation only

Purpose:

- implement a single-SKU eBay `listing_quality_update` dry-run package;
- no real marketplace write;
- no price fields;
- no quantity fields;
- no listing end/create/relist;
- generate hashes and rollback snapshots for review only.

### No real marketplace write until explicit later phase

No real marketplace write may occur until a later phase explicitly says to implement and validate a real marketplace write.

That later phase must define:

- exact marketplace;
- exact SKU/listing id;
- exact operation;
- exact fields;
- exact operator confirmation wording;
- rollback plan;
- token handling;
- rate limit behavior;
- idempotency behavior;
- audit table semantics;
- post-write verification;
- emergency stop procedure.

## Validation plan for Phase 8A

Because Phase 8A is documentation-only, validation must prove only this file changed.

Required validation:

```bash
git diff --stat
git diff --name-only
git status --short
```

Expected changed file:

```text
docs/phase-8a-marketplace-executor-design.md
```

Implementation-file change check:

```bash
git diff --name-only | grep -E '^(src|scripts|public|supabase)/' || true
```

Expected result:

```text
empty
```

Safety grep against Phase 7 code:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js src/web/routes/hermesExecutionRequests.js public/js/hermesExecutionRequests.js supabase/migrations/063_hermes_internal_executor_records.sql || true
```

Expected result:

```text
no marketplace write API matches
```

## Final Phase 8A decision

Phase 8A authorizes design only.

The only future marketplace candidate is `listing_quality_update` for eBay, and even that candidate is constrained to a future dry-run-first sequence. Price, quantity, inventory, listing end/create/relist, auto-repricing, bulk execution, and cross-marketplace execution remain forbidden.

No real marketplace write is allowed until an explicit later phase requests and scopes it.
