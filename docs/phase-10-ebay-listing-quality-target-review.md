# Hermes Phase 10 — eBay Listing Quality Target Review

Report timestamp: 2026-07-02T11:39:50Z

## Scope

Phase 10 resolves the cached eBay target listing for the Phase 9 `listing_quality_update` dry-run and builds an operator review / rollback snapshot.

This is still not marketplace execution.

Phase 10 does not:

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
- update live listings
- add write routes
- add UI buttons
- add UI write fetch calls
- push commits

## Baseline

Phase 9 is complete and committed:

```text
59b54f8 Add Phase 9 eBay listing quality dry-run
```

Phase 9 added:

- `buildEbayListingQualityDryRun({ requestId })`
- `npm run hermes:agent -- ebay-listing-quality-dry-run --id=<REQUEST_ID>`
- read-only detail/UI preview
- planned mutation limited to `title`, `description`, and `item_specifics`

## Implementation

Updated:

- `src/services/hermesExecutionApproval.js`
- `scripts/hermes-agent.js`
- `public/js/hermesExecutionRequests.js`

Added service function:

```js
buildEbayListingQualityTargetReview({ requestId })
```

Added CLI command:

```bash
npm run hermes:agent -- ebay-listing-quality-target-review --id=<REQUEST_ID>
```

Existing read-only `execution-detail` now includes:

```text
ebay_listing_quality_target_review
```

The existing read-only UI now displays the target review in the selected request detail.

## Target resolution rules

The target review reuses the Phase 9 dry-run and resolves the target from cached/internal data only.

Resolution sources, in order:

1. Phase 9 dry-run `before_snapshot`
2. passed marketplace preflight record `listing_snapshot`
3. request `requested_action`
4. request `metadata`

Candidate cached identifier fields:

- `item_id`
- `listing_id`
- `ebay_item_id`
- `ebay_listing_id`
- `target_item_id`

No live marketplace lookup is performed.
No eBay API call is made.

For request id 1, no cached eBay item id exists, so the review correctly returns:

```json
{
  "target_resolved": false,
  "target": {
    "sku": "202551129453",
    "item_id": null,
    "source": "cached_internal"
  }
}
```

Because the item id cannot be resolved, `operator_review.ready` is false.

## Cached/internal data sources

Phase 10 uses only existing Hermes data:

- `hermes_execution_requests`
- `hermes_marketplace_preflight_records`
- `hermes_internal_execution_records`
- `hermes_execution_events`
- `opportunity_inbox` snapshot metadata
- Phase 9 dry-run output

No external marketplace state is fetched.

The review output retains these safety indicators:

```json
{
  "live_marketplace_state_fetched": false,
  "ebay_api_call_made": false,
  "marketplace_api_calls": false,
  "execution_performed": false
}
```

## Planned mutation source

The Phase 10 target review uses the Phase 9 dry-run planned mutation exactly:

```json
{
  "title": null,
  "description": null,
  "item_specifics": {}
}
```

The review blocks unsafe fields in the planned mutation, including:

- price-like fields
- quantity-like fields
- inventory/stock fields
- listing end fields
- listing create fields
- relist fields

Validation for request id 1 observed:

```json
{
  "planned_mutation_keys": [
    "title",
    "description",
    "item_specifics"
  ],
  "blocked_fields_count": 0
}
```

## Rollback snapshot format

The rollback snapshot shape is:

```json
{
  "available": false,
  "manual_rollback_required": true,
  "restore_payload": {},
  "before_payload_hash": null,
  "planned_payload_hash": "sha256:...",
  "marketplace_response": null,
  "rollback_feasibility": "not_available_without_cached_target_and_before_payload",
  "manual_procedure": [],
  "limitations": []
}
```

A rollback snapshot is available only when:

- target item id is resolved from cached/internal data;
- cached before listing payload exists;
- operator review has no blockers.

For request id 1:

- cached item id is missing;
- cached before listing payload for title/description/item specifics is missing;
- rollback snapshot is not available;
- manual rollback remains required.

Observed limitations:

```json
[
  "target_item_id_missing_from_cached_internal_data",
  "cached_before_listing_payload_missing",
  "operator_review_blocked"
]
```

## Operator review blockers

The operator review output includes:

```json
{
  "ready": false,
  "blockers": [],
  "warnings": [],
  "required_confirmations": []
}
```

For request id 1, observed blockers:

```json
[
  "target_item_id_missing_from_cached_internal_data",
  "rollback_snapshot_not_available"
]
```

Observed required confirmations:

- confirm target item_id was resolved from cached/internal data only
- confirm target review is not listing revision
- confirm rollback snapshot is internal-only
- confirm no eBay API call is made
- confirm no price, inventory, quantity, end, create, or relist operation is present

## UI visibility

Updated selected request detail to show:

- target resolution status
- target SKU
- target item id
- item id source
- before snapshot availability
- rollback snapshot availability
- operator blockers/warnings
- rollback limitations
- rollback snapshot JSON
- raw target review JSON

Safety copy shown:

- “Target review is not listing revision.”
- “Rollback snapshot is internal-only.”
- “No eBay API call is made.”

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

Target review validation:

```bash
npm run hermes:agent -- ebay-listing-quality-target-review --id=1
```

Observed:

- `dry_run = true`
- `marketplace = ebay`
- `operation = listing_quality_update`
- `target_resolved = false`
- `target.sku = 202551129453`
- `target.item_id = null`
- `target.source = cached_internal`
- `planned_mutation.title = null`
- `planned_mutation.description = null`
- `planned_mutation.item_specifics = {}`
- `rollback_snapshot.available = false`
- `rollback_snapshot.manual_rollback_required = true`
- `operator_review.ready = false`
- `source = rule_based_cached_data`

Phase 9 dry-run validation still passes:

```bash
npm run hermes:agent -- ebay-listing-quality-dry-run --id=1
```

Read-only visibility validation:

```bash
npm run hermes:agent -- execution-detail --id=1
npm run hermes:agent -- execution-summary --limit=50
```

Observed:

- execution detail includes `ebay_listing_quality_target_review`
- execution detail remains read-only
- execution summary remains read-only
- execution lifecycle count remains zero

## Direct safety assertions

Direct post-validation assertions for request id 1:

```json
{
  "target_review_dry_run": true,
  "dry_run_still_true": true,
  "target_resolved": false,
  "target_item_id": null,
  "operator_review_ready": false,
  "rollback_snapshot_available": false,
  "marketplace_api_calls_false": true,
  "execution_performed_false": true,
  "no_ebay_api_call_occurred": true,
  "no_price_fields_in_planned_mutation": true,
  "no_quantity_fields_in_planned_mutation": true,
  "no_listing_end_create_relist_operation": true,
  "planned_mutation_keys": [
    "title",
    "description",
    "item_specifics"
  ],
  "blocked_fields_count": 0,
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
- safety strings and blocker patterns documenting forbidden fields
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

Phase 10 creates a read-only target review and rollback/operator review snapshot only.

No real eBay revision exists.
No marketplace API was called.
No listing was changed.
No price or inventory value was changed.
No push was performed.
