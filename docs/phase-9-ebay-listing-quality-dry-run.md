# Hermes Phase 9 — eBay Listing Quality Dry-Run

Report timestamp: 2026-07-01T23:04:25Z

## Scope

Phase 9 implements a single-SKU eBay `listing_quality_update` dry-run preview only.

This is not marketplace execution.

Phase 9 does not:

- implement a real eBay revision
- call eBay APIs
- call Shopee APIs
- call Shopify APIs
- call marketplace APIs
- call AI/external APIs
- change price
- change inventory
- revise listings
- end listings
- create listings
- relist listings
- update `executed_at`
- update `execution_result`
- set `metadata.external_action_executed` true
- set `metadata.marketplace_execution_approved` true
- add write routes
- add UI buttons
- add UI write fetch calls
- push commits

## Baseline

Phase 8F is complete and committed:

```text
69088c9 Add Phase 8F marketplace preflight migration validation
```

Phase 8F validated:

- migration 064 visible to active Supabase/PostgREST
- one `hermes_marketplace_preflight_records` row for request id 1
- `marketplace = ebay`
- `operation = listing_quality_update`
- `status = preflight_passed`
- no marketplace execution event
- null execution fields
- false external/marketplace metadata flags

## Implementation

Updated:

- `src/services/hermesExecutionApproval.js`
- `scripts/hermes-agent.js`
- `public/js/hermesExecutionRequests.js`

Added service function:

```js
buildEbayListingQualityDryRun({ requestId })
```

Added CLI command:

```bash
npm run hermes:agent -- ebay-listing-quality-dry-run --id=<REQUEST_ID>
```

The command is read-only. It does not have a write mode in Phase 9.

Existing read-only `execution-detail` now includes:

```text
ebay_listing_quality_dry_run
```

The existing read-only UI now displays the dry-run preview in the selected request detail.

## Preconditions

`buildEbayListingQualityDryRun({ requestId })` checks:

- marketplace preflight passed record exists
- marketplace is `ebay`
- operation is `listing_quality_update`
- execution type is safe for this phase (`manual_review_task` or `listing_quality_update`)
- final approval status is `approved`
- internal task record exists
- `executed_at` is null
- `execution_result` is null
- `metadata.external_action_executed` is false
- `metadata.marketplace_execution_approved` is false
- no previous marketplace execution lifecycle event exists
- current marketplace preflight remains allowed
- planned mutation contains no blocked fields

## Data sources

Phase 9 uses cached/internal data only:

- `hermes_execution_requests`
- `hermes_internal_execution_records`
- `hermes_marketplace_preflight_records`
- `hermes_execution_events`
- `opportunity_inbox` snapshot metadata
- existing dry-run/final-approval hashes

Phase 9 does not fetch live eBay listing state.

The dry-run output marks:

```json
{
  "live_marketplace_state_fetched": false,
  "ebay_api_call_made": false
}
```

## Dry-run output

The output shape is:

```json
{
  "request_id": 1,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "dry_run": true,
  "allowed": true,
  "marketplace_api_calls": false,
  "execution_performed": false,
  "target": {
    "sku": "202551129453",
    "item_id": null
  },
  "before_snapshot": {},
  "planned_mutation": {
    "title": null,
    "description": null,
    "item_specifics": {}
  },
  "blocked_fields": [],
  "blockers": [],
  "warnings": [],
  "hashes": {},
  "source": "rule_based_cached_data"
}
```

For request id 1, the target SKU is `202551129453`. No cached listing/item id was present, so `target.item_id` is null.

## Planned mutation

The planned mutation is intentionally minimal and safe:

```json
{
  "title": null,
  "description": null,
  "item_specifics": {}
}
```

It includes no price fields.
It includes no quantity fields.
It includes no inventory fields.
It includes no listing end/create/relist operation.

No payload is sent anywhere.

## Blocked fields

Phase 9 blocks planned mutation fields matching unsafe marketplace mutations, including:

- price-like fields
- quantity-like fields
- inventory/stock fields
- listing end fields
- listing create fields
- relist fields

Validated result for request id 1:

```json
{
  "blocked_fields": [],
  "planned_mutation_keys": [
    "title",
    "description",
    "item_specifics"
  ]
}
```

## UI visibility

Updated selected request detail to show:

- eBay listing quality dry-run summary
- marketplace and operation
- dry-run status
- marketplace API call flag
- execution performed flag
- target SKU and item id
- blockers/warnings
- blocked fields
- raw dry-run JSON

Safety copy shown:

- “eBay listing quality dry-run is not listing revision.”
- “No eBay API call is made.”
- “Price and inventory fields are blocked.”

No buttons were added.
No write fetch calls were added.
No marketplace execution controls were added.

## Validation

Syntax validation passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/web/routes/hermesExecutionRequests.js
node --check public/js/hermesExecutionRequests.js
```

Dry-run validation:

```bash
npm run hermes:agent -- ebay-listing-quality-dry-run --id=1
```

Observed:

- `dry_run = true`
- `allowed = true`
- `marketplace = ebay`
- `operation = listing_quality_update`
- `marketplace_api_calls = false`
- `execution_performed = false`
- `target.sku = 202551129453`
- `target.item_id = null`
- `planned_mutation.title = null`
- `planned_mutation.description = null`
- `planned_mutation.item_specifics = {}`
- `blocked_fields = []`
- `blockers = []`
- `source = rule_based_cached_data`

Read-only visibility validation:

```bash
npm run hermes:agent -- execution-detail --id=1
npm run hermes:agent -- execution-summary --limit=50
```

Observed:

- execution detail includes `ebay_listing_quality_dry_run`
- execution summary remains read-only
- existing marketplace preflight count remains visible
- no execution lifecycle count appeared

## Direct safety assertions

Direct post-validation assertions for request id 1:

```json
{
  "dry_run": true,
  "marketplace_api_calls_false": true,
  "execution_performed_false": true,
  "no_ebay_api_call_occurred": true,
  "no_price_fields_in_planned_mutation": true,
  "no_quantity_fields_in_planned_mutation": true,
  "no_listing_end_create_relist_operation": true,
  "blocked_fields_count": 0,
  "planned_mutation_keys": [
    "title",
    "description",
    "item_specifics"
  ],
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "metadata_external_action_executed_false": true,
  "metadata_marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0
}
```

## Safety audit

Safety grep was run for:

- marketplace write APIs
- eBay/Shopee/Shopify API calls
- price/quantity mutation fields
- route POST/PUT/PATCH/DELETE
- UI HTTP write methods
- AI/external API indicators

Expected benign matches:

- existing read-only UI `fetch()` calls for GET endpoints and auth
- safety strings and blocker patterns documenting forbidden price/quantity fields
- cached/internal data text that says eBay API calls are not made

Unsafe findings:

- no marketplace write API calls
- no route POST/PUT/PATCH/DELETE handlers
- no UI HTTP write methods
- no eBay API client call
- no Shopee API call
- no Shopify API call
- no AI call

## Final boundary

Phase 9 creates a read-only dry-run preview only.

No real eBay revision exists.
No marketplace API was called.
No listing was changed.
No price or inventory value was changed.
No push was performed.
