# Hermes Phase 8B-D — Marketplace Preflight Infrastructure

Report timestamp: 2026-07-01T16:10:29Z

## Purpose

Phase 8B-D implements marketplace execution preflight/audit infrastructure only.

This is not marketplace execution. It adds a rule-based, cached/internal-data marketplace preflight path and read-only visibility so a future phase can evaluate a possible eBay `listing_quality_update` before any real executor exists.

## Hard boundary

Phase 8B-D does not:

- implement a marketplace executor
- call eBay APIs
- call Shopee APIs
- call Shopify APIs
- call any marketplace API
- call AI/external APIs
- change price
- change inventory
- revise listings
- create listings
- end listings
- relist listings
- update `executed_at`
- update `execution_result`
- set `metadata.external_action_executed` true
- set `metadata.marketplace_execution_approved` true
- add write API routes
- add UI buttons
- add UI write fetch calls

## Migration

Created:

`supabase/migrations/064_hermes_marketplace_preflight.sql`

It creates:

`hermes_marketplace_preflight_records`

Fields:

- `id serial primary key`
- `request_id integer not null references hermes_execution_requests(id)`
- `marketplace text not null`
- `operation text not null`
- `status text not null`
- `actor text`
- `reason text`
- `preflight_result jsonb not null default '{}'::jsonb`
- `listing_snapshot jsonb not null default '{}'::jsonb`
- `planned_mutation jsonb not null default '{}'::jsonb`
- `safety_flags jsonb not null default '{}'::jsonb`
- `created_at timestamp default now()`

Allowed statuses:

- `preflight_passed`
- `preflight_failed`

Allowed marketplace:

- `ebay`

Allowed operation:

- `listing_quality_update`

The table intentionally does not include:

- marketplace execution result fields
- marketplace response fields
- marketplace adapter fields
- token fields
- write execution fields
- price/inventory/listing mutation execution fields

## Service implementation

Updated:

`src/services/hermesExecutionApproval.js`

Added:

- `buildMarketplacePreflight({ requestId, marketplace, operation })`
- `recordMarketplacePreflight({ requestId, marketplace, operation, actor, reason, dryRun })`
- `listMarketplacePreflightRecords({ requestId, limit })`

### buildMarketplacePreflight

The preflight is rule-based and uses cached/internal data only.

It verifies:

- `marketplace = ebay`
- `operation = listing_quality_update`
- `request.status = dry_run_ready`
- `final_approval_status = approved`
- an internal `internal_task_recorded` record exists
- `final_approval_dry_run_hash` matches the current `dry_run_result` hash
- `executed_at is null`
- `execution_result is null`
- `metadata.external_action_executed = false`
- `metadata.marketplace_execution_approved = false`
- no previous marketplace execution lifecycle event exists
- no forbidden price/quantity/listing end/create/relist mutation fields are present in the planned mutation preview
- marketplace preflight table is available

Output shape:

```json
{
  "request_id": 0,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "allowed": false,
  "marketplace_execution_available": false,
  "preflight_record_available": false,
  "blockers": [],
  "warnings": [],
  "safety": {
    "marketplace_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_revisions": false,
    "external_action_executed": false
  },
  "source": "rule_based_cached_data"
}
```

Important invariant:

`marketplace_execution_available` is always `false` in Phase 8.

### Cached/internal data only

The service constructs a `listing_snapshot` from existing Hermes request/opportunity data only:

- request SKU
- opportunity id/type/title
- source signals
- source recommendations
- dry-run generation timestamp
- any cached listing id if already present in internal metadata

It does not fetch current eBay listing state.

The planned mutation preview is intentionally empty:

- allowed fields are documented as `title`, `description`, `item_specifics`
- `mutation_fields = []`
- `proposed_changes = {}`
- `price_fields_present = false`
- `quantity_fields_present = false`
- `listing_end_create_relist_present = false`

This prevents Phase 8 from becoming a write executor.

### recordMarketplacePreflight

Default behavior is dry-run.

Write mode requires:

- `actor`
- `reason`

Write mode inserts only into:

- `hermes_marketplace_preflight_records`

Write mode inserts an internal event only:

- `marketplace_preflight_passed`
- or `marketplace_preflight_failed`

Write mode does not:

- call marketplace APIs
- change listing fields
- change price
- change inventory
- update `executed_at`
- update `execution_result`
- set marketplace execution metadata true

## CLI

Updated:

`npm run hermes:agent -- marketplace-preflight --id=<REQUEST_ID> --marketplace=ebay --operation=listing_quality_update`

`npm run hermes:agent -- marketplace-preflight-record --id=<REQUEST_ID> --marketplace=ebay --operation=listing_quality_update --actor=<USER> --reason="..." [--dry-run|--write]`

Default is `--dry-run`.

## Read-only API/detail visibility

No routes were added.

Existing read-only detail now includes:

- `marketplace_preflight`
- `marketplace_preflight_records`

Existing read-only summary now includes:

- `marketplace_preflight_passed_count`
- `marketplace_preflight_failed_count`
- `marketplace_preflight_migration_required`
- `recent_marketplace_preflight_records`

No POST/PUT/PATCH/DELETE routes were added.

## UI visibility

Updated:

`public/js/hermesExecutionRequests.js`

The selected request detail now shows:

- marketplace preflight summary
- marketplace/operation
- blockers
- warnings
- cached/internal data note
- marketplace preflight records

Safety copy shown:

- “Marketplace preflight is not marketplace execution.”
- “No marketplace API call is made in this phase.”
- “Listing changes remain disabled.”

No buttons were added.
No write fetch calls were added.

## Validation result

Syntax validation passed:

- `node --check src/services/hermesExecutionApproval.js`
- `node --check scripts/hermes-agent.js`
- `node --check src/web/routes/hermesExecutionRequests.js`
- `node --check public/js/hermesExecutionRequests.js`

Preflight validation was run:

`npm run hermes:agent -- marketplace-preflight --id=1 --marketplace=ebay --operation=listing_quality_update`

Observed result:

- `request_id = 1`
- `marketplace = ebay`
- `operation = listing_quality_update`
- `allowed = false`
- `marketplace_execution_available = false`
- `preflight_record_available = false`
- blocker: `migration_064_required`
- `internal_task_recorded = true`
- dry-run hash matched final approval hash
- previous marketplace execution lifecycle event count = 0
- source = `rule_based_cached_data`

Dry-run record validation was run:

`npm run hermes:agent -- marketplace-preflight-record --id=1 --marketplace=ebay --operation=listing_quality_update --actor=operator --reason="marketplace preflight validation" --dry-run`

Observed result:

- `dry_run = true`
- `created = false`
- record preview status = `preflight_failed`
- event preview type = `marketplace_preflight_failed`
- no database write performed during dry-run

The conditional write was not run because migration 064 is not applied/visible and preflight did not allow recording.

Migration 064 status observed:

```json
{
  "migration_064_applied": false,
  "postgrest_visible": false,
  "code": "PGRST205",
  "message": "Could not find the table 'public.hermes_marketplace_preflight_records' in the schema cache"
}
```

## Request id 1 safety assertions

Direct DB safety assertions after validation:

- `executed_at is null = true`
- `execution_result is null = true`
- `metadata.external_action_executed = false = true`
- `metadata.marketplace_execution_approved = false = true`
- no marketplace execution event exists = true
- marketplace execution event count = 0

## Summary validation

`npm run hermes:agent -- execution-summary --limit=50` showed:

- `internal_task_recorded_count = 1`
- `marketplace_preflight_passed_count = 0`
- `marketplace_preflight_failed_count = 0`
- `marketplace_preflight_migration_required = true`
- `external_actions_detected = 0`
- `marketplace_execution_approved_count = 0`
- `executed_request_count = 0`

## Safety audit

Safety grep was run for:

- marketplace write APIs
- eBay/Shopee/Shopify API calls
- AI/external API indicators
- route POST/PUT/PATCH/DELETE
- UI HTTP write methods

The implementation preserves the Phase 8 boundary:

- no marketplace API calls
- no eBay/Shopee/Shopify calls
- no AI calls
- no route write methods
- no UI write fetch calls
- no price changes
- no inventory changes
- no listing revisions
- no marketplace executor

## Completion status

Phase 8B-D implementation is completed in code and documentation.

Migration 064 is created in the repo but was not applied/visible in the active Supabase/PostgREST schema during validation.

Required status for this phase:

- `migration_064_applied = false`
- marketplace preflight record write validation not run
- blocker = `migration_064_required`
- follow-up required: Phase 8F migration 064 application/validation

## Remaining limitation

The real marketplace executor does not exist.

Migration 064 must be applied to the active Supabase database in Phase 8F before the preflight record write path can insert rows. Until then, preflight reports `migration_064_required` and `preflight_record_available = false`.

Even after migration 064 is applied, Phase 8 only records internal marketplace preflight audit rows. It still does not execute marketplace writes.

No push was performed as part of Phase 8B-D.
