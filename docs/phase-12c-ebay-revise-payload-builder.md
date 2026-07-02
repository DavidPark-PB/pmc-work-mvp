# Hermes Phase 12C — eBay Revise Payload Builder

Report timestamp: 2026-07-02T13:42:31Z

## Scope

Phase 12C implements an eBay `listing_quality_update` revise payload builder v1.

Baseline:

```text
b2d2aad Add Phase 12B eBay execution result recorder
```

Phase 12C did not redo Phase 12A or Phase 12B. It only builds the exact marketplace request payload from the confirmed packet and does not send it anywhere.

## Hard boundary

Phase 12C does not perform a network call.
Phase 12C does not call eBay.
Phase 12C does not write to a marketplace.
Phase 12C does not change a listing.
Phase 12C does not change price or inventory.
Phase 12C does not write to the database.
Phase 12C does not update `executed_at`.
Phase 12C does not update `execution_result`.
No push was performed.

## Implementation

Updated:

```text
src/adapters/ebayListingQualityExecutionAdapter.js
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added adapter helper:

```js
buildEbayListingQualityRevisePayload({ packet, request, intent })
```

Added service function:

```js
buildEbayListingQualityPayload({ packetId })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-build-payload --packet-id=<PACKET_ID>
```

The CLI is build-only:

- no eBay call
- no database write
- no `execution_result` update
- no `executed_at` update

## Allowed fields

The payload builder accepts only confirmed packet mutation fields:

- `title`
- `description`
- `item_specifics`

It rejects or blocks on unsafe field families:

- price
- quantity
- qty
- inventory
- stock
- end listing
- create listing
- relist
- revise indicators outside this payload-builder boundary
- SKU remapping
- shipping changes
- payment changes
- returns/return policy changes

## Payload shape

For packet id 1, the builder produced:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "api_operation": "ReviseFixedPriceItem",
  "target_item_id": "202551129453",
  "target_listing_id": "202551129453",
  "payload": {
    "Item": {
      "ItemID": "202551129453",
      "Title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card "
    }
  },
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": false,
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "non_allowed_fields": []
  },
  "actual_ebay_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "build_only": true
}
```

Only the title field is included because the confirmed packet has:

```json
{
  "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card ",
  "description": null,
  "item_specifics": {}
}
```

## Validation commands

Syntax checks passed:

```bash
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Payload build validation:

```bash
npm run hermes:agent -- ebay-listing-quality-build-payload --packet-id=1
```

Adapter dry-run validation:

```bash
npm run hermes:agent -- ebay-listing-quality-execute --packet-id=1 --dry-run
```

Execution detail validation:

```bash
npm run hermes:agent -- execution-detail --id=1
```

## Direct safety assertions

Direct post-validation assertions:

```json
{
  "packet_id": 1,
  "planned_mutation_allowed_fields_only": true,
  "no_price_quantity_fields": true,
  "no_end_create_relist_sku_policy_fields": true,
  "no_ebay_api_call": true,
  "no_marketplace_writes": true,
  "no_listing_changed": true,
  "no_price_changed": true,
  "no_inventory_changed": true,
  "no_database_write_from_payload_builder": true,
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "external_action_executed_false": true,
  "marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0
}
```

## Safety grep

Safety grep covered focused files for:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- route `POST/PUT/PATCH/DELETE`
- UI HTTP write methods
- price/quantity mutation fields

Unsafe findings:

- no eBay API call was added or used
- no marketplace write API invocation was added or used
- no route write method was added
- no UI write fetch method was added
- no price/quantity mutation field was added
- no database write path was added for the payload builder

Expected benign matches:

- `ReviseFixedPriceItem` appears only as the payload `api_operation` name, not as a function call
- false safety flags
- forbidden-field regex/check strings
- cached read column names such as `price_usd` and `stock`
- documentation text explaining forbidden fields

## Final state

Phase 12C prepares the exact eBay revise payload object from the confirmed packet, but it remains a local build-only artifact.

No network call occurred.
No eBay API call occurred.
No marketplace write occurred.
No execution result was updated.
