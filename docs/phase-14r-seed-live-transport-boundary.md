# Hermes Phase 14R — Seed Live Transport Boundary

## Purpose

Phase 14R adds a dedicated seed live transport boundary validation path for the Phase 14 final approved seed mutation.

It validates the final payload and live boundary for `approval_id=37` without calling eBay and without writing execution state.

Phase 14R does not redo Phase 14A through Phase 14Q. Phase 14Q baseline:

```text
28a965b Add Phase 14Q seed live readiness
```

## Target approval/request/packet

```json
{
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789"
}
```

Final mutation:

```json
{
  "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
  "item_specifics": {
    "Brand": "Torune",
    "Type": "Food Pick",
    "Theme": "Dolphin Sea Friend",
    "Number in Pack": "8"
  }
}
```

## Commands

Dry-run boundary validation:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --dry-run
```

Disabled write boundary validation:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --write
```

Do not run with:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true
```

Phase 14R does not permit real live execution.

## Validation gates

The dedicated seed transport boundary validates:

- approval id is exactly `37`
- request id is exactly `5`
- packet id is exactly `4`
- target item id is exactly `206288370789`
- operation is exactly `listing_quality_update`
- planned mutation fields are exactly `["title", "item_specifics"]`
- payload fields are exactly `["Title", "ItemSpecifics"]`
- `request.final_approval_status=approved`
- `request.executed_at` is null
- `request.execution_result` is null
- `approval_status=approved`
- `final_operator_approval=true`
- no previous `marketplace_execution_completed` event for request id `5`
- no previous `marketplace_execution_completed` event for item id `206288370789`
- no description mutation
- no price mutation
- no inventory mutation
- no quantity mutation
- no shipping/payment/returns/category/image mutation
- rollback snapshot exists

## Payload summary

The payload is built with existing adapter logic.

Payload preview:

```json
{
  "Item": {
    "ItemID": "206288370789",
    "Title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
    "ItemSpecifics": {
      "NameValueList": [
        { "Name": "Type", "Value": "Food Pick" },
        { "Name": "Brand", "Value": "Torune" },
        { "Name": "Theme", "Value": "Dolphin Sea Friend" },
        { "Name": "Number in Pack", "Value": "8" }
      ]
    }
  }
}
```

Payload summary:

```json
{
  "updates_title": true,
  "updates_description": false,
  "updates_item_specifics": true,
  "payload_fields": ["Title", "ItemSpecifics"],
  "forbidden_fields_present": false,
  "forbidden_fields": [],
  "non_allowed_fields": []
}
```

The payload does not include:

- `Description`
- price fields
- quantity fields
- inventory fields
- shipping fields
- payment fields
- returns fields
- category fields
- image fields

## Dry-run behavior

Dry-run loads `approval_id=37`, `request_id=5`, and `packet_id=4`, builds the payload, validates live transport gates, and reports the payload as ready for a later live call.

Observed dry-run summary:

```json
{
  "dry_run": true,
  "write_requested": false,
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "target_item_id": "206288370789",
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
  "marketplace_execution_event_created": false,
  "payload_ready": true,
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["Title", "ItemSpecifics"],
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "non_allowed_fields": []
  }
}
```

Dry-run still does not call eBay and does not write database state.

## Disabled write behavior

When run with `--write` and without `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true`, Phase 14R blocks the call.

Expected and observed blockers:

```json
[
  "live_ebay_execution_disabled",
  "live_ebay_execution_env_disabled",
  "phase_14r_live_execution_not_permitted"
]
```

Observed disabled-write summary:

```json
{
  "dry_run": false,
  "write_requested": true,
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "target_item_id": "206288370789",
  "ready_for_live_call": true,
  "would_call_ebay": true,
  "blocked": true,
  "blockers": [
    "live_ebay_execution_disabled",
    "live_ebay_execution_env_disabled",
    "phase_14r_live_execution_not_permitted"
  ],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "marketplace_execution_event_created": false,
  "payload_ready": true,
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["Title", "ItemSpecifics"],
    "forbidden_fields_present": false
  }
}
```

The disabled write path does not call eBay, does not call live transport, and does not update execution state.

## Safety guarantees

Phase 14R does not:

- run with `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true`
- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call live transport
- perform marketplace writes
- write database execution state
- set `executed_at`
- set `execution_result`
- create marketplace execution events
- mutate listings
- change price
- change inventory
- change quantity
- change description
- call AI
- push commits

Real live execution still requires separate explicit user approval in a later phase.

## Validation results

Required non-piped commands were run.

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
```

All exited `0`.

Readiness before transport:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=37
```

Observed:

```json
{
  "ready_for_seed_live_path_review": true,
  "ready_for_live_execution": false,
  "blockers": [],
  "previous_marketplace_execution_event_count": 0,
  "actual_ebay_call": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "marketplace_write_performed": false,
  "actual_database_write": false
}
```

Transport dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --dry-run
```

Observed:

```json
{
  "ready_for_live_call": true,
  "would_call_ebay": true,
  "blocked": false,
  "blockers": [],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "live_transport_called": false,
  "payload_ready": true
}
```

Disabled write:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --write
```

Observed:

```json
{
  "ready_for_live_call": true,
  "would_call_ebay": true,
  "blocked": true,
  "blockers": [
    "live_ebay_execution_disabled",
    "live_ebay_execution_env_disabled",
    "phase_14r_live_execution_not_permitted"
  ],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "marketplace_execution_event_created": false
}
```

Readiness after disabled write:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=37
```

Still observed:

```json
{
  "ready_for_seed_live_path_review": true,
  "ready_for_live_execution": false,
  "blockers": [],
  "previous_marketplace_execution_event_count": 0,
  "actual_ebay_call": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "marketplace_write_performed": false,
  "actual_database_write": false
}
```

Execution events remained empty:

```bash
npm run hermes:agent -- execution-events --id=5 --limit=20
```

Observed:

```json
{
  "count": 0,
  "data": []
}
```

`git diff --stat` was run after implementation.

## Final Phase 14R state

```json
{
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "target_item_id": "206288370789",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["title", "item_specifics"],
  "payload_fields": ["Title", "ItemSpecifics"],
  "payload_ready": true,
  "ready_for_live_call": true,
  "would_call_ebay": true,
  "disabled_write_blocked": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "marketplace_execution_event_created": false
}
```
