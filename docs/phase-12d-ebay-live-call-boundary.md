# Hermes Phase 12D — eBay Live Call Boundary v1

Report timestamp: 2026-07-02T13:57:04Z

## Scope

Phase 12D implements the controlled live-call boundary for future eBay `listing_quality_update` execution.

Baseline:

```text
6365bfa Add Phase 12C eBay revise payload builder
```

Phase 12D did not redo Phase 12A, 12B, or 12C. It adds only the boundary where a future live eBay call would happen.

## Hard boundary

Phase 12D validation did not perform a network call.
Phase 12D validation did not call eBay.
Phase 12D validation did not write to a marketplace.
Phase 12D validation did not change a listing.
Phase 12D validation did not change price or inventory.
Phase 12D validation did not write `executed_at`.
Phase 12D validation did not write `execution_result`.
No push was performed.

## Implementation

Updated:

```text
src/adapters/ebayListingQualityExecutionAdapter.js
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added adapter boundary:

```js
callEbayListingQualityRevise({ packet, request, payload, dryRun, liveEnabled, writeRequested })
```

Added service wrapper:

```js
callEbayListingQualityBoundary({ packetId, dryRun, liveEnabled, writeRequested })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-call-boundary --packet-id=<PACKET_ID> [--dry-run|--write]
```

Default behavior is dry-run.

Live execution remains disabled unless all gates pass and the environment explicitly enables it.

## Live call gates

The boundary blocks live execution unless all conditions are true:

- `dryRun === false`
- `liveEnabled === true`
- explicit CLI `--write` is present
- environment variable `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true`
- packet `confirmation_status = confirmed`
- request `final_approval_status = approved`
- payload contains only allowed fields
- no forbidden price/quantity/inventory/end/create/relist/shipping/payment/returns fields
- target item id exists
- rollback snapshot is present

Allowed mutation fields remain:

- `title`
- `description`
- `item_specifics`

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-call-boundary --packet-id=1 --dry-run
```

Observed output summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "ready_for_live_call": true,
  "dry_run": true,
  "live_enabled": false,
  "env_live_enabled": false,
  "explicit_write_requested": false,
  "blocked": false,
  "would_call_ebay": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "blockers": [],
  "live_blockers": [],
  "rollback_snapshot_present": true
}
```

Payload included in the boundary output:

```json
{
  "Item": {
    "ItemID": "202551129453",
    "Title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card "
  }
}
```

## Disabled write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-call-boundary --packet-id=1 --write
```

No live environment was set.

Observed output summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "ready_for_live_call": true,
  "dry_run": false,
  "live_enabled": false,
  "env_live_enabled": false,
  "explicit_write_requested": true,
  "blocked": true,
  "would_call_ebay": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "blockers": [
    "live_ebay_execution_disabled",
    "live_ebay_execution_env_disabled"
  ],
  "live_blockers": [
    "live_ebay_execution_disabled",
    "live_ebay_execution_env_disabled"
  ],
  "rollback_snapshot_present": true
}
```

This proves the write-shaped path is present but remains blocked when live eBay execution is not explicitly enabled.

## Other validation commands

Syntax checks passed:

```bash
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Payload builder still passes:

```bash
npm run hermes:agent -- ebay-listing-quality-build-payload --packet-id=1
```

Execution detail still passes:

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
  "rollback_snapshot_present": true,
  "planned_mutation_allowed_fields_only": true,
  "no_forbidden_mutation_fields": true,
  "live_env_enabled": false,
  "no_network_call": true,
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

## Safety grep

Safety grep covered focused files for:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- route `POST/PUT/PATCH/DELETE`
- UI HTTP write methods
- price/quantity/inventory mutation fields

Unsafe findings:

- no eBay API client import or invocation was added
- no network call was added
- no marketplace write API invocation was added
- no route write method was added
- no UI write fetch method was added
- no execution result update was added
- no executed_at update was added

Expected benign matches:

- `ReviseFixedPriceItem` appears only as the payload `api_operation` string and documentation, not as a function call
- false safety flags
- forbidden-field regex/check strings
- cached read column names such as `price_usd` and `stock`
- documentation text explaining forbidden fields

## Final state

Phase 12D creates the controlled eBay live-call boundary, but live calls remain disabled by default.

A future phase can enable the live path only by explicitly setting the live environment gate, passing `--write`, and preserving all existing safety checks and rollback/result handling.

No eBay API call occurred in Phase 12D.
