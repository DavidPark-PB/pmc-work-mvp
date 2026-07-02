# Hermes Phase 11B — eBay Operator Mutation Packet

Report timestamp: 2026-07-02T12:09:17Z

## Scope

Phase 11B adds an internal operator-provided eBay `listing_quality_update` mutation packet flow.

This phase is dry-run/read-only only. It creates an internal packet preview from operator-provided fields and does not perform marketplace execution.

Phase 11B does not:

- implement real eBay revision
- call eBay APIs
- call Shopee or Shopify APIs
- call marketplace APIs
- write to database
- change price
- change inventory
- change live listings
- revise, end, create, or relist listings
- add UI buttons
- add UI write fetch calls
- push commits

## Baseline

Phase 11A is complete and committed:

```text
80acbc0 Add Phase 11A eBay listing quality execution packet
```

Phase 11A blocker for request id 1:

```json
{
  "execution_packet_ready": false,
  "operator_packet": {
    "blockers": ["planned_mutation_empty"]
  },
  "target": {
    "item_id": "202551129453"
  },
  "rollback_snapshot": {
    "available": true
  }
}
```

## Implementation

Updated:

- `src/services/hermesExecutionApproval.js`
- `scripts/hermes-agent.js`
- `public/js/hermesExecutionRequests.js`

Added service function:

```js
buildOperatorEbayListingQualityPacket({ requestId, title, description, itemSpecifics })
```

Added CLI command:

```bash
npm run hermes:agent -- ebay-listing-quality-operator-packet --id=<REQUEST_ID> [--title="..."] [--description="..."] [--item-specifics-json='{}']
```

Execution detail now includes:

```text
operator_ebay_listing_quality_packet
```

The default detail preview calls the operator packet builder without operator fields, so it remains blocked by `operator_mutation_empty` until an operator provides a title, description, or item specifics through the read-only CLI.

## Accepted mutation fields

The service accepts only:

```json
{
  "title": "string or null",
  "description": "string or null",
  "item_specifics": {}
}
```

Input field mapping:

- CLI `--title` maps to `title`
- CLI `--description` maps to `description`
- CLI `--item-specifics-json='{}'` maps to `item_specifics`

The builder normalizes blank values to empty/null and drops blank item-specific values.

## Blocked mutation fields

The service rejects unsafe field families if they appear in the mutation object:

- price
- quantity
- inventory
- stock
- end listing
- create listing
- relist
- revise operation indicators outside the internal preview boundary

The Phase 11B packet includes `blocked_fields` and blocks readiness when any blocked field is detected.

## Packet format

The service returns:

```json
{
  "request_id": 1,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "execution_packet_ready": true,
  "target": {},
  "before_snapshot": {},
  "planned_mutation": {
    "title": "...",
    "description": null,
    "item_specifics": {}
  },
  "rollback_snapshot": {},
  "operator_packet": {
    "ready": true,
    "blockers": [],
    "warnings": [],
    "allowed_fields": ["title", "description", "item_specifics"],
    "required_confirmations": []
  },
  "blocked_fields": [],
  "allowed_fields": ["title", "description", "item_specifics"],
  "packet_preview": {
    "send_to_marketplace": false,
    "write_to_database": false
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

## Readiness rules

`execution_packet_ready` can be true only when all are true:

- target review resolves the cached/internal eBay item id
- rollback snapshot is available
- at least one allowed mutation field is non-empty
- no blocked fields are present
- target review remains dry-run
- marketplace API call flag remains false
- execution performed flag remains false

For request id 1, Phase 11B can make the packet ready with a safe title-only operator mutation because Phase 10B already resolved the cached target and rollback title snapshot.

## Validation command

Safe title-only validation command:

```bash
npm run hermes:agent -- ebay-listing-quality-operator-packet --id=1 --title="BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card - Operator Review"
```

Observed result:

```json
{
  "request_id": 1,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "execution_packet_ready": true,
  "target": {
    "sku": "202551129453",
    "item_id": "202551129453",
    "source": "cached_internal"
  },
  "operator_packet": {
    "ready": true,
    "blockers": [],
    "allowed_fields": ["title", "description", "item_specifics"]
  },
  "blocked_fields": [],
  "packet_preview": {
    "send_to_marketplace": false,
    "write_to_database": false
  },
  "safety": {
    "marketplace_api_calls": false,
    "execution_performed": false,
    "ebay_api_calls": false,
    "external_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_revisions": false,
    "database_writes": false
  }
}
```

Warnings remain expected because cached description and item-specific rollback context are unavailable:

- `cached_description_missing_for_rollback_context`
- `cached_item_specifics_missing_for_rollback_context`
- `cached_description_missing`
- `cached_item_specifics_missing`
- `listing_details_cache_missing_for_sku`

## UI/detail visibility

Execution detail includes `operator_ebay_listing_quality_packet`.

The UI displays:

- packet readiness
- operator packet readiness
- target item id
- allowed fields
- blocked fields
- operator blockers
- operator warnings
- required confirmations
- operator planned mutation JSON
- rollback snapshot JSON
- raw operator packet JSON

Safety copy shown:

- “Operator mutation packet is internal-only.”
- “No eBay API call is made.”
- “No listing revision is performed.”

No buttons were added.
No write fetch calls were added.

## Validation

Syntax validation passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check public/js/hermesExecutionRequests.js
```

Functional validation passed:

```bash
npm run hermes:agent -- ebay-listing-quality-operator-packet --id=1 --title="BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card - Operator Review"
npm run hermes:agent -- execution-detail --id=1
```

Direct safety assertions:

```json
{
  "dry_run": true,
  "execution_packet_ready": true,
  "operator_packet_ready": true,
  "blocked_fields_count": 0,
  "allowed_fields": ["title", "description", "item_specifics"],
  "planned_mutation_keys": ["title", "description", "item_specifics"],
  "title_present": true,
  "no_price_quantity_fields": true,
  "no_end_create_relist_fields": true,
  "marketplace_api_calls_false": true,
  "execution_performed_false": true,
  "no_ebay_api_call_occurred": true,
  "no_listing_changed": true,
  "no_price_inventory_changed": true,
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
- no live listing change added

Expected benign matches:

- existing safety strings and false flags
- forbidden-field regex/check strings
- existing read-only UI GET `fetch()` calls
- cached/internal table reads

## Boundary

Phase 11B creates an internal operator mutation packet preview only.

No eBay API was called.
No marketplace execution occurred.
No listing changed.
No price or inventory changed.
No database write path was added.
No live listing revision was implemented.
No push was performed.
