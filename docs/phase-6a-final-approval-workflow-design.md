# Hermes Phase 6A — Final Approval Workflow Design

Report timestamp: 2026-07-01T14:59:56Z

## Purpose

Phase 6A is a documentation-only design phase for a future final approval mutation workflow in Hermes.

This phase does not implement code, does not create migrations, does not add CLI commands, does not add UI buttons, does not write database rows, and does not execute marketplace actions.

Baseline:

```text
1abab3e Add Phase 5 final closeout report
```

## 1. Scope and safety boundary

### In scope for Phase 6A

Phase 6A defines the proposed design for a future final approval workflow that would remain internal-only.

The design covers:

- proposed lifecycle states after Phase 5
- preconditions for future final approval
- proposed future audit event names
- required final approval payload shape
- safety rules separating final approval from execution
- future phased implementation plan

### Out of scope for Phase 6A

Phase 6A intentionally does not implement anything.

Hard constraints for this phase:

- No code changes.
- No migration files.
- No CLI commands.
- No API changes.
- No UI changes.
- No database writes.
- No new execution requests.
- No request status updates.
- No dry-run writes.
- No approve/reject/cancel/final-approval mutation.
- No marketplace execution.
- No executor.
- No price changes.
- No inventory changes.
- No listing revisions.
- No eBay/Shopee/Shopify API calls.
- No AI calls.
- No scheduler, cron, or LaunchAgent.

### Future final approval boundary

The proposed final approval mutation is internal-only.

Final approval must not be treated as marketplace execution.

Final approval means:

- an operator has explicitly reviewed a dry-run-ready request;
- the operator has accepted the current internal dry-run artifact and policy version;
- Hermes records that acceptance in internal approval state and audit fields;
- execution still remains disabled until a later, separately scoped executor phase exists.

Final approval does not mean:

- call marketplace APIs;
- change marketplace price;
- change marketplace inventory;
- revise marketplace listings;
- schedule background execution;
- bypass a future executor revalidation gate.

## 2. Current and proposed lifecycle

### Current Phase 5 states relevant to final approval

Phase 5 closeout confirmed the current execution-request lifecycle includes:

```text
approved
```

An internally reviewed request has passed the first approval/review workflow. This status does not mean final approval and does not mean marketplace execution.

```text
dry_run_ready
```

An approved request has an internal dry-run artifact captured in `dry_run_result`. This status is eligible for read-only readiness and checklist inspection. It still does not mean final approval and does not mean execution.

### Proposed future internal-only states

If a later phase needs explicit final approval state, introduce additional internal-only statuses such as:

```text
final_approval_pending
final_approved
final_approval_rejected
final_approval_expired
```

These states are proposed only. Phase 6A does not modify code or schema.

#### final_approval_pending

Meaning:

- the request is ready to be shown in a final approval review queue;
- dry-run and readiness evidence exists;
- an operator has not yet recorded final approval or rejection.

Safety boundary:

- no execution;
- no marketplace API call;
- no external side effect.

#### final_approved

Meaning:

- an explicit operator has recorded internal final approval;
- approval payload includes actor, reason, confirmation text, dry-run hash, policy version, timestamp, and safety flags;
- request may become eligible for a later executor phase after revalidation.

Safety boundary:

- still no execution;
- still no marketplace API call;
- still no price/inventory/listing change.

#### final_approval_rejected

Meaning:

- an explicit operator rejected final approval after reviewing the dry-run, readiness, checklist, and current context;
- reason/confirmation text is required.

Safety boundary:

- no execution;
- no marketplace API call;
- no external side effect.

#### final_approval_expired

Meaning:

- the dry-run or source context is too old for final approval;
- a new dry-run/current-state validation is required before final approval can be reconsidered.

Safety boundary:

- no execution;
- no marketplace API call;
- no external side effect.

## 3. Preconditions for future final approval

A future final approval mutation must be allowed only when every precondition below is true.

### Request-state preconditions

- `request.status` must be `dry_run_ready`.
- `dry_run_result` must exist.
- `executed_at` must be `null`.
- `execution_result` must be `null`.
- `metadata.external_action_executed` must be `false`.
- `metadata.marketplace_execution_approved` must be `false`.

### Readiness preconditions

A future implementation should call the existing rule-based readiness logic and require:

```text
readiness_summary.ready_for_final_approval === true
```

Readiness must continue to require:

- request is `dry_run_ready`;
- dry-run result exists;
- dry-run result says `execution_performed === false`;
- dry-run result says `marketplace_api_calls === false`;
- execution fields are empty;
- external action flags are false;
- marketplace approval flags are false.

### Final checklist preconditions

A future implementation should call the existing final approval checklist logic and require:

```text
final_approval_checklist.blocking_conditions.length === 0
```

The checklist must continue to report that final approval is not execution and that execution remains unavailable until a later phase explicitly implements an executor.

### Actor and confirmation preconditions

A future final approval mutation must require:

- explicit actor;
- explicit approval reason;
- explicit confirmation text;
- confirmed dry-run result hash;
- confirmed policy version;
- confirmation timestamp;
- positive acknowledgement that external action was not executed;
- positive acknowledgement that marketplace execution is not approved by the final approval mutation itself.

Null, empty, placeholder, or implicit actor values must be rejected.

## 4. Proposed future audit events

Phase 6A documents future audit events only. It does not create event rows.

Proposed future event types:

```text
final_approval_recorded
final_approval_rejected
final_approval_expired
```

### final_approval_recorded

Use when an explicit operator records internal final approval.

Suggested payload fields:

- request id;
- SKU;
- actor;
- approval reason;
- confirmed dry-run result hash;
- confirmed policy version;
- previous status;
- next status;
- confirmation timestamp;
- `external_action_executed: false`;
- `marketplace_execution_approved: false`;
- `execution_performed: false`.

### final_approval_rejected

Use when an explicit operator rejects final approval.

Suggested payload fields:

- request id;
- SKU;
- actor;
- rejection reason;
- previous status;
- next status;
- confirmation timestamp;
- `external_action_executed: false`;
- `marketplace_execution_approved: false`;
- `execution_performed: false`.

### final_approval_expired

Use when final approval eligibility expires because the dry-run or source context is no longer current.

Suggested payload fields:

- request id;
- SKU;
- reason for expiration;
- dry-run generated timestamp;
- policy version;
- previous status;
- next status;
- `external_action_executed: false`;
- `marketplace_execution_approved: false`;
- `execution_performed: false`.

## 5. Required final approval payload

A future internal final approval mutation should require this payload shape:

```json
{
  "approved_by_actor": "operator@example.com",
  "approval_reason": "Reviewed dry-run, readiness summary, and final approval checklist; approved for future executor eligibility only.",
  "confirmed_dry_run_result_hash": "sha256:<hash>",
  "confirmed_policy_version": "phase-6-final-approval-v1",
  "confirmed_at": "ISO8601",
  "external_action_executed": false,
  "marketplace_execution_approved": false
}
```

Field requirements:

| Field | Requirement |
| --- | --- |
| `approved_by_actor` | Required explicit non-empty actor string. |
| `approval_reason` | Required explicit non-empty explanation. |
| `confirmed_dry_run_result_hash` | Required immutable hash of the dry-run result reviewed by the operator. |
| `confirmed_policy_version` | Required policy version the operator reviewed. |
| `confirmed_at` | Required ISO8601 timestamp generated at mutation time. |
| `external_action_executed` | Required literal `false`. |
| `marketplace_execution_approved` | Required literal `false` for the final approval mutation itself. |

A future implementation should reject the payload when:

- actor is missing;
- reason is missing;
- dry-run hash is missing or does not match current `dry_run_result`;
- policy version is missing or unsupported;
- `external_action_executed` is not exactly `false`;
- `marketplace_execution_approved` is not exactly `false`.

## 6. Safety rules

The future final approval workflow must preserve these rules:

1. Final approval does not execute.
2. Final approval does not call marketplace APIs.
3. Final approval does not change price.
4. Final approval does not change inventory.
5. Final approval does not revise listings.
6. Final approval does not enqueue or schedule execution.
7. Final approval does not create a marketplace write token or marketplace write intent by itself.
8. Final approval requires a later separate executor phase.
9. The later executor phase must revalidate dry-run/current state before every execution attempt.
10. The later executor phase must verify that the final approval is still current and unexpired.
11. The later executor phase must verify that the target SKU/listing/current marketplace state still matches the reviewed dry-run assumptions.
12. The later executor phase must enforce a narrow marketplace write allowlist.
13. The later executor phase must record execution audit events separately from final approval events.
14. The later executor phase must include rollback/compensation design before implementation.
15. The later executor phase must keep a hard off-switch.

Final approval is an internal authorization checkpoint only. It is not execution approval for a marketplace adapter unless a later executor phase explicitly defines and validates that bridge.

## 7. Future implementation plan

Phase 6A recommends splitting future work into separate phases so final approval stays isolated from execution.

### Phase 6B — migration for final approval internal fields only

Purpose:

- add internal final approval fields and/or status constraints if needed;
- preserve existing Phase 5 request/event tables;
- avoid marketplace execution columns that imply external action.

Possible internal fields:

- `final_approval_actor` text;
- `final_approval_reason` text;
- `final_approved_at` timestamp;
- `final_approval_policy_version` text;
- `final_approval_dry_run_hash` text;
- `final_approval_rejected_actor` text;
- `final_approval_rejected_at` timestamp;
- `final_approval_rejection_reason` text;
- `final_approval_expires_at` timestamp.

Safety boundary:

- migration only;
- no executor;
- no marketplace writes;
- no DB row mutation during migration except schema changes and safe backfill if explicitly required.

### Phase 6C — service/CLI final approval mutation, internal-only

Purpose:

- add a service function for recording final approval/rejection/expiration;
- add CLI commands only after Phase 6B schema exists;
- default to dry-run preview;
- require `--write` for internal mutation;
- require actor and reason;
- record future audit events only in `hermes_execution_events`.

Safety boundary:

- internal DB writes only;
- no executor;
- no marketplace API calls;
- no price/inventory/listing changes.

### Phase 6D — read-only API/UI visibility

Purpose:

- expose final approval status and audit events through read-only GET endpoints;
- update UI to display final approval state, actor, reason, policy version, dry-run hash, and expiration;
- no UI mutation buttons unless a separate explicitly approved phase adds them.

Safety boundary:

- GET endpoints only;
- no POST/PATCH/PUT/DELETE endpoints;
- no execute/final-approval buttons in this phase unless separately scoped;
- no marketplace writes.

### Phase 6E — final approval closeout

Purpose:

- verify Phase 6B–6D internal-only behavior;
- document lifecycle state;
- verify safety fields and absence of executor paths;
- prove no marketplace write APIs or HTTP write endpoints were introduced beyond explicitly scoped internal mutations.

Safety boundary:

- closeout should be read-only unless a controlled internal validation fixture is explicitly requested.

### Later Phase 7 — limited executor design, not implementation

Purpose:

- design a limited executor without implementing it;
- define exact execution types, marketplace allowlists, revalidation gates, rollback requirements, audit events, dry-run/current-state hash checks, and off-switch behavior.

Safety boundary:

- design-only;
- no marketplace API integration;
- no executor code;
- no external writes.

Any actual executor implementation must be a later, explicitly requested phase after Phase 7 design and closeout.

## 8. Validation plan for Phase 6A

Because Phase 6A is documentation-only, validation should prove that only the new documentation file changed.

Commands to run:

```bash
git diff --stat
git status --short
git diff --name-only
```

Expected result:

```text
docs/phase-6a-final-approval-workflow-design.md
```

No code files should appear in the diff.

No migration files should appear in the diff.

Optional no-op safety greps against Phase 5 touched code:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js src/web/routes/hermesExecutionRequests.js public/js/hermesExecutionRequests.js || true

grep -nE 'method:|POST|PUT|PATCH|DELETE|/approve|/reject|/cancel|/execute|/final' \
  public/js/hermesExecutionRequests.js || true

grep -nE 'router\.(post|put|patch|delete)|\.insert\(|\.update\(|\.upsert\(|\.delete\(' \
  src/web/routes/hermesExecutionRequests.js || true
```

Expected result:

- no prohibited marketplace write API matches;
- no route write handlers in the Phase 5 read-only HTTP route;
- no UI write methods or mutation endpoints in the Phase 5 UI module;
- any matches in comments or safety text must be documented as non-executable text only.

## Phase 6A verdict

Phase 6A defines the final approval mutation workflow as design only.

The proposed future final approval mutation remains internal-only and separate from marketplace execution.

No code, schema, CLI, API, UI, database row, marketplace, AI, or scheduler changes are part of this phase.
