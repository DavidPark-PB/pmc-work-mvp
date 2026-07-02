# Hermes Phase 11A — eBay Listing Quality Execution Packet Dry-Run

Report timestamp: 2026-07-02T11:58:50Z

## Scope

Phase 11A builds a single-SKU eBay `listing_quality_update` execution packet preview only.

This phase is a dry-run packet builder. It is not eBay execution and not marketplace execution.

Phase 11A does not:

- implement real eBay revision
- call eBay APIs
- call marketplace APIs
- write to database
- change price
- change inventory
- change listings
- revise live listings
- end/create/relist listings
- add UI buttons
- add UI write fetch calls
- push commits

## Baseline

Phase 10B is complete and committed:

```text
21d7f20 Add Phase 10B cached eBay target resolution
```

Request id 1 baseline before Phase 11A:

```json
{
  "target_resolved": true,
  "target": {
    "item_id": "202551129453"
  },
  "rollback_snapshot": {
    "available": true
  },
  "operator_review": {
    "ready": true
  },
  "planned_mutation": {
    "title": null,
    "description": null,
    "item_specifics": {}
  }
}
```

Cached description and item specifics are still missing.

## Implementation

Updated:

- `src/services/hermesExecutionApproval.js`
- `scripts/hermes-agent.js`
- `public/js/hermesExecutionRequests.js`

Added service function:

```js
buildEbayListingQualityExecutionPacket({ requestId })
```

Added CLI command:

```bash
npm run hermes:agent -- ebay-listing-quality-execution-packet --id=<REQUEST_ID>
```

Execution detail now includes:

```text
ebay_listing_quality_execution_packet
```

The read-only UI now shows packet readiness, blockers, warnings, planned mutation, and rollback snapshot.

## Packet format

The packet output shape is:

```json
{
  "request_id": 1,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "execution_packet_ready": false,
  "target": {},
  "before_snapshot": {},
  "planned_mutation": {},
  "rollback_snapshot": {},
  "operator_packet": {
    "ready": false,
    "blockers": [],
    "warnings": [],
    "required_confirmations": []
  },
  "safety": {
    "marketplace_api_calls": false,
    "execution_performed": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_revisions": false
  },
  "source": "rule_based_cached_data"
}
```

The output also includes read-only helper fields:

- `blocked_fields`
- `packet_preview`
- `hashes`

`packet_preview` explicitly marks:

```json
{
  "send_to_marketplace": false,
  "write_to_database": false
}
```

## Readiness rules

The execution packet preview reuses:

```js
buildEbayListingQualityTargetReview({ requestId })
```

Readiness requires:

- `target_resolved = true`
- `rollback_snapshot.available = true`
- planned mutation is non-empty
- no blocked/unsafe fields in planned mutation
- dry-run remains true
- marketplace API calls remain false
- execution performed remains false

If `planned_mutation` is empty, `execution_packet_ready` is false.

If description/item specifics are missing, the packet reports warnings.

Blocked mutation field families:

- price fields
- quantity fields
- inventory/stock fields
- listing end fields
- listing create fields
- relist fields

## Current request id 1 result

Validation command:

```bash
npm run hermes:agent -- ebay-listing-quality-execution-packet --id=1
```

Observed:

```json
{
  "request_id": 1,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "execution_packet_ready": false,
  "target": {
    "sku": "202551129453",
    "item_id": "202551129453",
    "source": "cached_internal"
  },
  "planned_mutation": {
    "title": null,
    "description": null,
    "item_specifics": {}
  },
  "rollback_snapshot": {
    "available": true,
    "manual_rollback_required": true
  },
  "operator_packet": {
    "ready": false,
    "blockers": [
      "planned_mutation_empty"
    ],
    "warnings": [
      "Execution packet is not eBay execution",
      "No eBay API call is made",
      "Operator packet must be non-empty before any future write phase",
      "cached/internal data only",
      "cached_description_missing",
      "cached_item_specifics_missing",
      "listing_details_cache_missing_for_sku"
    ]
  }
}
```

## Why request id 1 packet is not ready

Request id 1 is not packet-ready because the planned mutation is empty:

```json
{
  "title": null,
  "description": null,
  "item_specifics": {}
}
```

The packet correctly reports:

```text
planned_mutation_empty
```

Additional cached-data warnings remain:

- `cached_description_missing`
- `cached_item_specifics_missing`
- `listing_details_cache_missing_for_sku`

The target and rollback snapshot are ready, but a future write phase must not proceed until the operator packet contains a non-empty, reviewed listing-quality mutation.

## UI/detail visibility

Read-only execution detail now includes:

```text
ebay_listing_quality_execution_packet
```

The UI displays:

- `execution_packet_ready`
- `operator_packet.ready`
- dry-run flag
- marketplace API call flag
- execution performed flag
- target item id
- packet blockers
- packet warnings
- required confirmations
- planned mutation JSON
- rollback snapshot JSON
- raw execution packet JSON

Safety copy shown:

- “Execution packet is not eBay execution.”
- “No eBay API call is made.”
- “Operator packet must be non-empty before any future write phase.”

No buttons were added.
No write fetch calls were added.

## Validation

Syntax validation passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/web/routes/hermesExecutionRequests.js
node --check public/js/hermesExecutionRequests.js
```

Functional validation commands passed:

```bash
npm run hermes:agent -- ebay-listing-quality-execution-packet --id=1
npm run hermes:agent -- ebay-listing-quality-target-review --id=1
npm run hermes:agent -- execution-detail --id=1
```

Direct safety assertions:

```json
{
  "dry_run": true,
  "execution_packet_ready": false,
  "operator_packet_ready": false,
  "operator_packet_blockers": [
    "planned_mutation_empty"
  ],
  "target_item_id": "202551129453",
  "rollback_snapshot_available": true,
  "planned_mutation_empty": true,
  "marketplace_api_calls_false": true,
  "execution_performed_false": true,
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

## Safety audit

Safety grep covered:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- price/quantity mutation fields
- route POST/PUT/PATCH/DELETE
- UI HTTP write methods

Unsafe findings:

- no marketplace write API calls added
- no eBay API call added
- no Shopee/Shopify API call added
- no route POST/PUT/PATCH/DELETE handlers added
- no UI HTTP write methods added
- no price/quantity mutation added

Expected benign matches:

- existing safety strings and false flags
- existing read-only UI GET fetch calls
- cached/internal table reads

## Boundary

Phase 11A creates an execution packet dry-run only.

No eBay API was called.
No marketplace execution occurred.
No listing changed.
No price or inventory changed.
No database write path was added.
No push was performed.
