# Hermes Phase 12A — eBay Live Execution Adapter v1

Report timestamp: 2026-07-02T13:23:16Z

## Scope

Phase 12A introduces a guarded eBay `listing_quality_update` execution adapter v1 while keeping default behavior dry-run only.

Baseline:

```text
cf4e6a3 Add Phase 11G eBay packet confirmation write validation
```

Phase 12A did not redo Phase 11A-11G. It builds on the confirmed packet artifact from Phase 11G.

Current packet/request state:

- packet id: `1`
- request id: `1`
- target item_id/listing_id: `202551129453`
- packet status: `packet_recorded`
- packet confirmation_status: `confirmed`
- request final_approval_status: `approved`
- request `executed_at` remains null
- request `execution_result` remains null
- no marketplace execution has occurred

## Hard boundary

Phase 12A did not perform a real eBay revision.
No eBay API call was made.
No marketplace write was made.
No listing changed.
No price changed.
No inventory changed.
No request execution fields were updated.
No push was performed.

The new adapter exposes a write-shaped command, but Phase 12A validation ran dry-run only.

## Implementation

Added:

```text
src/adapters/ebayListingQualityExecutionAdapter.js
```

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service function:

```js
executeEbayListingQualityPacket({ packetId, dryRun })
```

Added CLI command:

```bash
npm run hermes:agent -- ebay-listing-quality-execute --packet-id=<PACKET_ID> [--dry-run|--write]
```

Default behavior is dry-run unless `--write` is explicitly supplied.

## Adapter gates

The adapter builds a guarded execution intent and blocks unless all core gates pass:

- packet exists
- packet `status = packet_recorded`
- packet `confirmation_status = confirmed`
- request exists
- request `final_approval_status = approved`
- request `executed_at` is null
- request `execution_result` is null
- request `metadata.external_action_executed` is false
- request `metadata.marketplace_execution_approved` is false
- target item_id/listing_id exists
- planned mutation is non-empty
- planned mutation fields are allowlisted only
- no forbidden marketplace mutation fields are present

Allowed planned mutation fields:

- `title`
- `description`
- `item_specifics`

Rejected field families:

- price
- quantity
- qty
- inventory
- stock
- end listing
- create listing
- relist
- revise indicators outside the adapter boundary

## Dry-run output requirements

The dry-run output includes:

- `packet_id`
- `request_id`
- `marketplace = ebay`
- `target_marketplace = ebay`
- `target_item_id`
- `target_listing_id`
- `planned_mutation`
- `planned_mutation_fields`
- `confirmation_status`
- `approval_status`
- `would_call_ebay = true`
- `actual_ebay_call = false`
- `would_update_execution_result = true`
- `actual_database_write = false`

## Validation commands

Syntax checks passed:

```bash
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Dry-run adapter validation:

```bash
npm run hermes:agent -- ebay-listing-quality-execute --packet-id=1 --dry-run
```

Observed dry-run summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "target_item_id": "202551129453",
  "target_listing_id": "202551129453",
  "planned_mutation_fields": ["title"],
  "confirmation_status": "confirmed",
  "approval_status": "approved",
  "ready_for_marketplace_call": true,
  "blockers": [],
  "would_call_ebay": true,
  "actual_ebay_call": false,
  "would_update_execution_result": true,
  "actual_database_write": false
}
```

Planned mutation:

```json
{
  "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card ",
  "description": null,
  "item_specifics": {}
}
```

Execution detail validation passed:

```bash
npm run hermes:agent -- execution-detail --id=1
```

## Direct safety assertions

Direct post-validation assertions:

```json
{
  "packet_id": 1,
  "confirmation_status": "confirmed",
  "final_approval_status": "approved",
  "planned_mutation_allowed_fields_only": true,
  "no_price_quantity_fields": true,
  "no_end_create_relist_fields": true,
  "no_ebay_api_call": true,
  "no_marketplace_writes": true,
  "no_listing_changed": true,
  "no_price_changed": true,
  "no_inventory_changed": true,
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "external_action_executed_false": true,
  "marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0
}
```

## Write mode note

The CLI accepts a `--write` form:

```bash
npm run hermes:agent -- ebay-listing-quality-execute --packet-id=1 --write
```

Phase 12A did not run this command.

The adapter file intentionally does not import or call an eBay API client in this phase. In write mode, the adapter remains guarded and reports that Phase 12A live eBay revision is not enabled unless a later explicit phase wires credentials, marketplace API calls, response persistence, rollback handling, and execution-field updates.

## Safety grep

Safety grep covered focused implementation and documentation files for:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- route `POST/PUT/PATCH/DELETE`
- UI HTTP write methods
- price/quantity mutation fields

Unsafe findings:

- no marketplace write API call was added or used
- no eBay/Shopee/Shopify API call was added or used
- no route write method was added
- no UI write fetch method was added
- no price/quantity mutation field was added

Expected benign matches:

- false safety flags
- forbidden-field regex/check strings
- cached read column names such as `price_usd` and `stock`
- internal adapter write-shaped guard text
- existing read-only UI GET fetches

## Final state

Phase 12A provides the first guarded adapter layer for a future eBay listing quality live execution path, but the completed validation is dry-run only.

No eBay API was called.
No marketplace execution occurred.
No listing changed.
No price or inventory changed.
No execution result was written.
