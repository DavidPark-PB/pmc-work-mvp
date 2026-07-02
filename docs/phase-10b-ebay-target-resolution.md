# Hermes Phase 10B — Cached eBay Target Resolution

Report timestamp: 2026-07-02T11:48:48Z

## Scope

Phase 10B improves cached/internal eBay target resolution for the Phase 9/10 `listing_quality_update` dry-run and target review.

This phase is still read-only and is not marketplace execution.

Phase 10B does not:

- implement a real eBay revision
- call eBay APIs
- call Shopee APIs
- call Shopify APIs
- call marketplace APIs
- call AI/external APIs
- change price
- change inventory
- change listings
- revise listings
- end/create/relist listings
- update live listings
- add write routes
- add UI write calls
- push commits

## Baseline

Phase 10 is complete and committed:

```text
6025cab Add Phase 10 eBay listing target review
```

Before Phase 10B, request id 1 had:

```json
{
  "target_resolved": false,
  "target": {
    "sku": "202551129453",
    "item_id": null
  },
  "rollback_snapshot": {
    "available": false
  },
  "operator_review": {
    "ready": false
  }
}
```

## Implementation

Updated:

- `src/services/hermesExecutionApproval.js`

No CLI changes were needed because the existing Phase 10 command already calls the updated target review service:

```bash
npm run hermes:agent -- ebay-listing-quality-target-review --id=1
```

No UI code changes were needed because existing execution detail already renders the target review raw JSON and rollback limitations.

## Cached/internal data sources inspected

Read-only sources inspected for request id 1 / SKU `202551129453`:

- `ebay_products`
- `listing_details`
- `listing_item_specifics`
- `listing_images`
- `listing_policies`
- `opportunity_inbox`
- existing SKU context builder fallback logic
- Phase 4 enrichment services and migration 059

Observed cached data:

```json
{
  "ebay_products": [
    {
      "sku": "202551129453",
      "item_id": "202551129453",
      "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card",
      "status": "active"
    }
  ],
  "listing_details": [],
  "listing_item_specifics": [],
  "listing_images": [],
  "listing_policies": []
}
```

The active cached source for request id 1 is `ebay_products`.

## Resolution behavior

Added internal helper logic to:

1. load cached eBay listing evidence by SKU from `ebay_products`;
2. attempt enrichment cache reads from `listing_details` by SKU;
3. if needed, attempt enrichment cache reads by resolved item id;
4. attempt item-specific/image/policy cache reads by item id;
5. merge cached evidence into Phase 9 `before_snapshot`;
6. keep `live_marketplace_state_fetched = false`;
7. keep `ebay_api_call_made = false`.

No eBay API lookup is performed.

## Request id 1 result

After Phase 10B, request id 1 resolves the target from `ebay_products`:

```json
{
  "target_resolved": true,
  "target": {
    "sku": "202551129453",
    "item_id": "202551129453",
    "source": "cached_internal"
  }
}
```

The Phase 9 dry-run target also now includes:

```json
{
  "sku": "202551129453",
  "item_id": "202551129453"
}
```

## Before snapshot

The improved before snapshot includes:

```json
{
  "item_id": "202551129453",
  "ebay_item_id": "202551129453",
  "listing_id": "202551129453",
  "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card",
  "description": null,
  "item_specifics": {},
  "cached_listing_resolution": {
    "source": "cached_internal",
    "source_tables": [
      "ebay_products"
    ],
    "item_id_resolved": true,
    "title_available": true,
    "description_available": false,
    "item_specifics_available": false,
    "limitations": [
      "cached_description_missing",
      "cached_item_specifics_missing",
      "listing_details_cache_missing_for_sku"
    ]
  },
  "live_marketplace_state_fetched": false,
  "ebay_api_call_made": false
}
```

## Rollback snapshot

Because cached item id and cached title are now available, rollback snapshot availability improved:

```json
{
  "available": true,
  "manual_rollback_required": true,
  "restore_payload": {
    "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card",
    "description": null,
    "item_specifics": {}
  },
  "rollback_feasibility": "manual_required"
}
```

Remaining limitations are explicit:

```json
[
  "cached_description_missing",
  "cached_item_specifics_missing",
  "listing_details_cache_missing_for_sku"
]
```

These limitations mean title restoration is available from cached data, while description and item specifics require additional cached enrichment data before they can be restored from the snapshot.

## Operator review

For request id 1, the operator review is now ready for cached target review:

```json
{
  "ready": true,
  "blockers": [],
  "warnings": [
    "Target review is not listing revision",
    "Rollback snapshot is internal-only",
    "No eBay API call is made",
    "cached/internal data only"
  ]
}
```

This readiness is not marketplace execution approval and does not execute anything.

## Planned mutation remains safe

Phase 10B did not expand the mutation scope.

The planned mutation remains exactly:

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

## Validation

Syntax validation passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check public/js/hermesExecutionRequests.js
```

Target review validation:

```bash
npm run hermes:agent -- ebay-listing-quality-target-review --id=1
```

Observed:

- `target_resolved = true`
- `target.item_id = 202551129453`
- `target.source = cached_internal`
- `before_snapshot.cached_listing_resolution.source_tables = ["ebay_products"]`
- `title_available = true`
- `description_available = false`
- `item_specifics_available = false`
- `rollback_snapshot.available = true`
- `operator_review.ready = true`
- `marketplace_api_calls = false`
- `execution_performed = false`

Dry-run validation:

```bash
npm run hermes:agent -- ebay-listing-quality-dry-run --id=1
```

Observed:

- `dry_run = true`
- `target.item_id = 202551129453`
- `planned_mutation = { title: null, description: null, item_specifics: {} }`
- `marketplace_api_calls = false`
- `execution_performed = false`

Read-only detail validation:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed:

- detail includes improved `ebay_listing_quality_dry_run`
- detail includes improved `ebay_listing_quality_target_review`
- detail remains read-only

## Direct safety assertions

Direct assertions after validation:

```json
{
  "target_resolved": true,
  "target_item_id": "202551129453",
  "dry_run_item_id": "202551129453",
  "source_tables": [
    "ebay_products"
  ],
  "title_available": true,
  "description_available": false,
  "item_specifics_count": 0,
  "rollback_snapshot_available": true,
  "operator_review_ready": true,
  "rollback_limitations": [
    "cached_description_missing",
    "cached_item_specifics_missing",
    "listing_details_cache_missing_for_sku"
  ],
  "no_ebay_api_call_occurred": true,
  "no_listing_changed": true,
  "no_price_inventory_changed": true,
  "no_price_fields_in_planned_mutation": true,
  "no_quantity_fields_in_planned_mutation": true,
  "no_listing_end_create_relist_operation": true,
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "external_action_executed_false": true,
  "marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0
}
```

## Safety grep

Safety grep covered:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- price/quantity mutation fields
- route POST/PUT/PATCH/DELETE
- UI HTTP write methods

Unsafe findings:

- no marketplace write API calls added
- no route write methods added
- no UI HTTP write methods added
- no eBay/Shopee/Shopify API calls added
- no price/quantity mutation added

Expected benign matches remain:

- existing safety strings and false flags
- existing read-only UI GET `fetch()` calls
- `ebay_products` table reads as cached internal data

## Remaining limitations

For request id 1:

- `listing_details` has no cached row for SKU/item id.
- `listing_item_specifics` has no cached rows for item id.
- `listing_images` has no cached rows for item id.
- `listing_policies` has no cached rows for item id.
- cached description is unavailable.
- cached item specifics are unavailable.

To improve rollback completeness later, a separate explicitly approved read-only enrichment/cache phase would need to populate `listing_details` and `listing_item_specifics` for item id `202551129453` without performing marketplace writes.

## Final boundary

Phase 10B resolves target item id and title from cached/internal data only.

No eBay API was called.
No marketplace API was called.
No listing changed.
No price/inventory changed.
No real eBay revision was implemented.
No push was performed.
