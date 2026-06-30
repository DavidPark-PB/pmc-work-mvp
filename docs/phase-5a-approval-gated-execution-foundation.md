# Hermes Phase 5A — Approval-Gated Execution Foundation

Report timestamp: 2026-06-30T17:35:00Z

## Purpose

Phase 5A creates the internal foundation for approval-gated execution without performing any marketplace write or external action.

This phase does not redo Phase 1, Phase 2, Phase 3, or Phase 4.

Baseline:

```text
20478c8 Add Phase 4 final closeout report
```

Phase 5A only adds schema and application support for internal execution request records. It does not approve, execute, schedule, or call any marketplace operation.

## Safety boundaries

Phase 5A safety boundaries:

- No external action execution.
- No marketplace API calls.
- No eBay Trading write APIs.
- No price changes.
- No inventory changes.
- No listing changes or revisions.
- No AI calls.
- Dry-run is the default.
- `--write` may create only an internal `hermes_execution_requests` row after migration 060 is applied.
- `--write` must not approve or execute anything.

Opportunity approval is not marketplace execution approval. An approved `opportunity_inbox` row only means the business opportunity was reviewed by a human. It does not authorize any marketplace mutation.

## Files reviewed before editing

- `git log --oneline -20`
- `docs/phase-4-final-closeout.md`
- `docs/phase-2e-opportunity-review-action.md`
- `docs/phase-2g-opportunity-action-planner.md`
- `docs/phase-2-final-verification.md`
- `src/services/opportunityInbox.js`
- `scripts/hermes-agent.js`
- `supabase/migrations/041_opportunity_inbox.sql`
- `package.json`

## Schema summary

Created migration:

```text
supabase/migrations/060_hermes_execution_approval.sql
```

Tables defined:

- `hermes_execution_requests`
- `hermes_execution_events`

### `hermes_execution_requests`

Important fields:

- `id`
- `opportunity_id`
- `sku`
- `execution_type`
- `status`
- `requested_action jsonb`
- `risk_level`
- `requires_approval boolean`
- `approved_by`, `approved_at`
- `rejected_by`, `rejected_at`, `rejection_reason`
- `executed_by`, `executed_at`
- `dry_run_result jsonb`
- `execution_result jsonb`
- `metadata jsonb`
- `created_at`, `updated_at`

Allowed request statuses:

- `draft`
- `pending_approval`
- `approved`
- `rejected`
- `dry_run_ready`
- `executed`
- `failed`
- `cancelled`

Allowed execution types:

- `price_change`
- `inventory_change`
- `listing_update`
- `listing_quality_update`
- `cost_data_update`
- `enrichment_run`
- `manual_review_task`

Risk levels:

- `low`
- `medium`
- `high`
- `critical`

Indexes were added for status/created, sku/created, opportunity id, type/status, and event lookup.

Migration 060 includes conditional foreign keys:

- `hermes_execution_requests.opportunity_id` → `opportunity_inbox.id`
- `hermes_execution_events.request_id` → `hermes_execution_requests.id`

It also includes an internal `updated_at` trigger for request rows.

### `hermes_execution_events`

Fields:

- `id`
- `request_id`
- `event_type`
- `actor`
- `payload jsonb`
- `created_at`

This table is for internal audit events only.

## Service implementation

Created:

```text
src/services/hermesExecutionApproval.js
```

Exported functions:

- `buildExecutionRequestFromOpportunity({ opportunityId })`
- `validateExecutionRequest(request)`
- `createExecutionRequest({ opportunityId, dryRun = true })`
- `listExecutionRequests({ status, sku, limit })`
- `recordExecutionEvent({ requestId, eventType, actor, payload })`

Behavior:

- Default mode is dry-run.
- `buildExecutionRequestFromOpportunity()` uses existing `buildHermesOpportunityActionPlan({ id })` from `src/services/opportunityInbox.js`.
- Only approved Hermes opportunities can be converted, because `buildHermesOpportunityActionPlan()` already enforces:
  - `metadata.hermes_generated === true`
  - `status === 'approved'`
- Generated request includes:
  - `requires_approval: true`
  - `requested_action.requires_human_approval: true`
  - `forbidden_actions`
  - safety boundary fields showing no external side effects.
- No marketplace connector is imported.
- No AI SDK or model client is imported.
- No price, inventory, listing, or marketplace mutation path exists.

## Execution lifecycle

Phase 5A creates the following internal lifecycle model:

1. `draft` — internal draft request state.
2. `pending_approval` — request created and waiting for explicit execution approval.
3. `approved` — future approval state; not implemented as marketplace execution in Phase 5A.
4. `rejected` — future rejected state.
5. `dry_run_ready` — future dry-run executor output is available.
6. `executed` — future execution completed, if later phases explicitly implement execution.
7. `failed` — future execution failed.
8. `cancelled` — request cancelled before execution.

Phase 5A does not implement an executor. It only creates the internal request/event foundation.

## Relationship to Opportunity Inbox approved status

Phase 2E introduced Hermes opportunity review actions and made clear that `approved` on `opportunity_inbox` means human-reviewed business approval only.

Phase 2G then allowed approved Hermes opportunities to generate a rule-based action plan with forbidden actions.

Phase 5A builds on that by converting an approved Hermes opportunity action plan into an internal execution request preview or row.

Important distinction:

- `opportunity_inbox.status = approved` means the opportunity is approved for planning.
- `hermes_execution_requests.status = pending_approval` means an internal request exists and still requires separate execution approval.
- Neither state executes marketplace actions.
- Marketplace execution remains forbidden unless a future approval-gated executor is explicitly implemented and approved.

## CLI support

Updated:

```text
scripts/hermes-agent.js
```

Added commands:

```bash
npm run hermes:agent -- execution-request --opportunity-id=<ID> --dry-run
npm run hermes:agent -- execution-request --opportunity-id=<ID> --write
npm run hermes:agent -- execution-list --status=pending_approval --limit=20
```

Safety behavior:

- Dry-run is default.
- `--dry-run` wins unless `--write` is explicitly provided without dry-run.
- `--write` can only create an internal request row after migration 060 is applied.
- `--write` does not approve or execute the request.
- No external APIs are called by these commands.

## Example commands

Preview execution request from approved opportunity id `4`:

```bash
npm run hermes:agent -- execution-request --opportunity-id=4 --dry-run
```

Create an internal request row only after migration 060 is applied:

```bash
npm run hermes:agent -- execution-request --opportunity-id=4 --write
```

List pending internal execution requests:

```bash
npm run hermes:agent -- execution-list --status=pending_approval --limit=20
```

## Validation

### Syntax checks

Commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Result: passed.

### SQL migration sanity check

No local `psql`, `supabase`, or `pg_format` command was available in this environment, so a conservative file-level SQL sanity check was run with Python.

Checks:

- migration file exists
- `hermes_execution_requests` create statement exists
- `hermes_execution_events` create statement exists
- status check constraint exists
- execution type check constraint exists
- single quotes are balanced
- dollar-quoted blocks are balanced

Observed result:

```text
{
  'create_requests': True,
  'create_events': True,
  'status_check': True,
  'type_check': True,
  'balanced_single_quotes': True,
  'balanced_dollar_blocks': True
}
```

Migration 060 was not applied automatically.

### Approved opportunity availability

Command:

```bash
npm run hermes:agent -- opportunity-list --status=approved --limit=5
```

Observed approved Hermes opportunity:

```json
{
  "id": 4,
  "sku": "202551129453",
  "type": "dead_stock_review",
  "status": "approved",
  "title": "Dead stock review needed for SKU 202551129453"
}
```

### Execution request dry-run

Command:

```bash
npm run hermes:agent -- execution-request --opportunity-id=4 --dry-run
```

Observed result summary:

```json
{
  "dry_run": true,
  "created": false,
  "request": {
    "opportunity_id": 4,
    "sku": "202551129453",
    "execution_type": "manual_review_task",
    "status": "pending_approval",
    "risk_level": "low",
    "requires_approval": true,
    "requested_action": {
      "requires_human_approval": true,
      "forbidden_actions": [
        "no_database_writes",
        "no_marketplace_api_calls",
        "no_price_changes",
        "no_inventory_changes",
        "no_listing_changes",
        "no_automatic_execution",
        "no_ai_calls",
        "no_external_side_effects"
      ],
      "safety_boundary": {
        "marketplace_api_calls": false,
        "price_changes": false,
        "inventory_changes": false,
        "listing_changes": false,
        "automatic_execution": false,
        "ai_calls": false
      }
    },
    "metadata": {
      "hermes_phase": "5A",
      "source_opportunity_status": "approved",
      "opportunity_approval_is_not_execution_approval": true,
      "marketplace_execution_approved": false,
      "external_action_executed": false
    }
  },
  "note": "Dry-run only: no hermes_execution_requests row was created and no external action was executed."
}
```

Result: passed. No row was created and no external action was executed.

### Execution list validation

Command:

```bash
npm run hermes:agent -- execution-list --status=pending_approval --limit=20
```

Observed result:

```json
{
  "count": 0,
  "data": [],
  "blocked": true,
  "migration_required": true,
  "migration": "supabase/migrations/060_hermes_execution_approval.sql",
  "error": "Could not find the table 'public.hermes_execution_requests' in the schema cache",
  "note": "Migration 060 must be applied before execution requests can be listed."
}
```

This is expected because Phase 5A creates the migration file but does not apply it automatically to the active database.

### Safety grep

Command:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  src/services/hermesExecutionApproval.js scripts/hermes-agent.js src/services/opportunityInbox.js || true

grep -RInE 'callTradingAPI|callShoppingAPI|Browse|openai|anthropic|claude|axios|fetch\(' \
  src/services/hermesExecutionApproval.js || true
```

Result:

```text
Prohibited marketplace write APIs: none
External API / AI call indicators in Phase 5A service: none
```

## Phase 5B recommendation

Phase 5B should apply and verify migration 060 against the active database.

Recommended Phase 5B steps:

1. Apply `supabase/migrations/060_hermes_execution_approval.sql` through the existing approved migration process.
2. Verify both tables are visible in the active Supabase/PostgREST schema cache:
   - `hermes_execution_requests`
   - `hermes_execution_events`
3. Re-run:
   ```bash
   npm run hermes:agent -- execution-request --opportunity-id=4 --dry-run
   npm run hermes:agent -- execution-request --opportunity-id=4 --write
   npm run hermes:agent -- execution-list --status=pending_approval --limit=20
   ```
4. Confirm `--write` creates only an internal request row.
5. Confirm no approval, execution, marketplace API, price, inventory, or listing mutation occurs.

Phase 5B should still not implement direct automatic marketplace writes.

## Phase 5A verdict

Phase 5A passed.

The repository now has the internal schema, service, and CLI foundation for approval-gated execution requests. The active database still needs migration 060 applied and verified in Phase 5B before write-mode request creation can be validated against live tables.
