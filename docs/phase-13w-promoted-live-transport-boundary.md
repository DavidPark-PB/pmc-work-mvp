# Hermes Phase 13W — Promoted Live Transport Boundary

## Scope

Phase 13W adds a dedicated promoted live transport boundary validation path for:

```json
{
  "approval_id": 15,
  "request_id": 3,
  "packet_id": 2,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["item_specifics"]
}
```

This phase does not execute eBay.

It validates the promoted packet payload and live transport boundary without calling the existing Phase 12 live transport function, without calling eBay, and without writing execution state.

## Safety boundary

Phase 13W must not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call the live transport path
- perform a marketplace write
- write database execution state
- update `request.executed_at`
- update `request.execution_result`
- create a marketplace execution event
- change title
- change description
- change price
- change inventory
- change quantity
- change live listing content

The existing Phase 12I hard guard for `packet_id=1` remains intact. Phase 13W adds a dedicated promoted guard/path for `packet_id=2` only.

## CLI

Dry-run boundary validation:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-transport --approval-id=15 --dry-run
```

Disabled write boundary validation:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-transport --approval-id=15 --write
```

Do not run the command with:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true
```

in Phase 13W.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
validatePhase13WPromotedLiveTransportBoundary({ approval, request, legacyPacket, payload, marketplaceEventCount })
callEbayListingQualityPromotedLiveTransportBoundary({ approvalId, dryRun, write })
```

Added CLI command:

```text
ebay-listing-quality-promoted-live-transport
```

## Dedicated promoted validation gates

The promoted transport boundary validates:

- `approval_id` exactly `15`
- `request_id` exactly `3`
- `packet_id` exactly `2`
- `target_item_id` exactly `206315990948`
- operation exactly `listing_quality_update`
- planned mutation fields exactly `["item_specifics"]`
- payload fields exactly `["ItemSpecifics"]`
- `request.final_approval_status=approved`
- `request.executed_at=null`
- `request.execution_result=null`
- `metadata.external_action_executed=false`
- `metadata.marketplace_execution_approved=false`
- no previous marketplace execution event for request id `3`
- no title mutation
- no description mutation
- no price mutation
- no inventory mutation
- no quantity mutation

## Dry-run behavior

Dry-run builds the payload and reports that the boundary would be ready to call eBay if a later phase explicitly permits live execution.

Observed dry-run summary:

```json
{
  "dry_run": true,
  "write_requested": false,
  "approval_id": 15,
  "request_id": 3,
  "packet_id": 2,
  "target_item_id": "206315990948",
  "ready_for_live_call": true,
  "would_call_ebay": true,
  "blocked": false,
  "blockers": [],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "payload_ready": true,
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["ItemSpecifics"],
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "non_allowed_fields": []
  }
}
```

Payload built:

```json
{
  "Item": {
    "ItemID": "206315990948",
    "ItemSpecifics": {
      "NameValueList": [
        {
          "Name": "required_human_review",
          "Value": "true"
        }
      ]
    }
  }
}
```

## Disabled write behavior

Disabled write was run without `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true`.

Observed summary:

```json
{
  "dry_run": false,
  "write_requested": true,
  "approval_id": 15,
  "request_id": 3,
  "packet_id": 2,
  "target_item_id": "206315990948",
  "ready_for_live_call": true,
  "would_call_ebay": true,
  "blocked": true,
  "blockers": [
    "live_ebay_execution_disabled",
    "live_ebay_execution_env_disabled",
    "phase_13w_live_execution_not_permitted"
  ],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "executed_at_updated": false,
  "execution_result_updated": false
}
```

The blocker list includes live execution disabled. No eBay call, network call, marketplace write, database write, or execution-state update occurred.

## Validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
```

All passed.

Boundary validation commands:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-transport --approval-id=15 --dry-run
npm run hermes:agent -- ebay-listing-quality-promoted-live-transport --approval-id=15 --write
npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=15
npm run hermes:agent -- execution-events --id=3 --limit=20
```

Readiness after disabled write still showed:

```json
{
  "request_id": 3,
  "legacy_packet_id": 2,
  "target_item_id": "206315990948",
  "ready_for_promoted_live_path_review": true,
  "ready_for_live_execution": false,
  "blockers": [],
  "checks": {
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "metadata_external_action_executed_false": true,
    "metadata_marketplace_execution_approved_false": true,
    "no_previous_marketplace_execution_event": true,
    "previous_marketplace_execution_event_count": 0,
    "payload_fields": ["ItemSpecifics"],
    "payload_item_specifics_only": true,
    "live_transport_called": false
  }
}
```

Execution events for request id `3` remained empty:

```json
{
  "count": 0,
  "data": []
}
```

## Final Phase 13W state

```json
{
  "approval_id": 15,
  "request_id": 3,
  "packet_id": 2,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["item_specifics"],
  "payload_fields": ["ItemSpecifics"],
  "request_final_approval_status": "approved",
  "request_executed_at": null,
  "request_execution_result": null,
  "metadata_external_action_executed": false,
  "metadata_marketplace_execution_approved": false,
  "marketplace_execution_event_count_for_request": 0,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "marketplace_write_performed": false,
  "actual_database_write": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "title_changes": false,
  "description_changes": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false
}
```
