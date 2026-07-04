# Hermes Phase 14Q — Seed Live Readiness

## Purpose

Phase 14Q adds read-only execution bridge readiness checks for the Phase 14 seed final approved mutation path.

It validates that the Phase 14P approval artifact, Phase 14N request, and Phase 14N packet are internally consistent and payload-ready for a later live-review path.

Phase 14Q does not execute eBay.

Baseline:

```text
c009e57 Add Phase 14P seed final approval
```

Phase 14Q does not redo Phase 14A through Phase 14P.

## Target approval/request/packet

```json
{
  "approval_id": 37,
  "packet_id": 4,
  "request_id": 5,
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "planned_mutation_fields": ["title", "item_specifics"]
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

Description is intentionally not updated.

## Commands

Readiness:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=37
```

Runbook:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-runbook --approval-id=37
```

Both commands are read-only.

## Readiness gates

Phase 14Q validates:

- approval artifact id `37` exists
- `approval_status=approved`
- `final_operator_approval=true`
- packet id `4` exists
- packet `confirmation_status=confirmed`
- request id `5` exists
- `request.final_approval_status=approved`
- `request.executed_at` is null
- `request.execution_result` is null
- target item id is exactly `206288370789`
- operation is exactly `listing_quality_update`
- planned mutation fields are exactly `["title", "item_specifics"]`
- generated adapter payload fields are exactly `["Title", "ItemSpecifics"]`
- no description mutation exists
- no price/inventory/quantity mutation exists
- no shipping/payment/returns/category/image mutation exists
- no previous `marketplace_execution_completed` event exists for request id `5`
- no previous `marketplace_execution_completed` event exists for item id `206288370789`
- rollback snapshot exists from cached evidence
- live transport was not called

## Payload summary

The payload preview is built using existing adapter logic.

Observed payload shape:

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

## Runbook summary

The runbook command returns a read-only operator checklist for a later live phase. It includes:

- exact approval/request/packet ids
- target item id
- planned mutation summary
- pre-live checks
- rollback snapshot summary
- payload summary and payload preview
- explicit note that Phase 14Q does not call eBay
- explicit note that a later phase requires separate explicit live execution approval from the user

## Safety guarantees

Phase 14Q does not:

- write to the database
- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call eBay write APIs
- perform marketplace writes
- mutate listings
- change price
- change inventory
- change quantity
- change description
- update execution state
- set `executed_at`
- set `execution_result`
- create marketplace execution events
- create live candidates
- call AI
- push commits

Allowed behavior:

- read internal approval/request/packet/event records
- build an in-memory payload preview using existing adapter logic
- return readiness and runbook JSON

## Validation results

Required non-piped commands were run.

### Syntax checks

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
```

All exited `0` with no syntax output.

### Phase 14P approval detail

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --approval-id=37
```

Observed:

```json
{
  "read_only": true,
  "packet_id": 4,
  "request_id": 5,
  "approval_id": 37,
  "approval_status": "approved",
  "final_operator_approval": true,
  "found": true,
  "count": 1,
  "verification": {
    "exactly_one_approval_for_packet": true,
    "approval_exists": true,
    "source_type_valid": true,
    "packet_remains_confirmed": true,
    "packet_id_exact": true,
    "request_id_exact": true,
    "planned_mutation_fields": ["title", "item_specifics"],
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "execution_request_created": false,
    "execution_state_updated": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false
  }
}
```

### Phase 14N final mutation detail

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-detail --opportunity-id=36
```

Observed:

```json
{
  "read_only": true,
  "found": true,
  "final_request_id": 5,
  "final_packet_id": 4,
  "target_item_id": "206288370789",
  "operation": "listing_quality_update",
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["title", "item_specifics"],
    "forbidden_fields_present": false
  },
  "validation": {
    "planned_mutation_fields": ["title", "item_specifics"],
    "final_mutation_fields_exact_title_and_item_specifics": true,
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "marketplace_execution_event_count": 0,
    "no_marketplace_execution_events": true
  },
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false
}
```

### Seed live readiness

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=37
```

Observed:

```json
{
  "read_only": true,
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "target_item_id": "206288370789",
  "ready_for_seed_live_path_review": true,
  "ready_for_live_execution": false,
  "phase_14q_does_not_execute_ebay": true,
  "blockers": [],
  "checks": {
    "approval_status_approved": true,
    "final_operator_approval": true,
    "packet_confirmed": true,
    "request_final_approval_status_approved": true,
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "no_previous_marketplace_execution_event": true,
    "payload_updates_title": true,
    "payload_updates_item_specifics": true,
    "payload_updates_description": false,
    "no_price_inventory_quantity_fields": true,
    "rollback_snapshot_exists": true,
    "live_transport_called": false
  },
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["Title", "ItemSpecifics"],
    "forbidden_fields_present": false
  },
  "actual_database_write": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false
}
```

### Seed live runbook

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-runbook --approval-id=37
```

Observed:

```json
{
  "read_only": true,
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "target_item_id": "206288370789",
  "phase_warning": "Phase 14Q is read-only readiness/runbook only. It does not call eBay, GetItem, ReviseFixedPriceItem, live transport, or update execution state.",
  "later_live_approval_required": true,
  "planned_mutation_summary": {
    "fields": ["title", "item_specifics"],
    "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
    "updates_description": false,
    "price_inventory_quantity_changes": false
  },
  "rollback_snapshot_summary": {
    "available": true,
    "title_present": true,
    "description_present": true,
    "item_specifics_count": 2,
    "source": "packet_internal_snapshots"
  }
}
```

### Execution events for request id 5

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

## Final Phase 14Q state

```json
{
  "approval_id": 37,
  "approval_status": "approved",
  "final_operator_approval": true,
  "packet_id": 4,
  "request_id": 5,
  "target_item_id": "206288370789",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["title", "item_specifics"],
  "payload_fields": ["Title", "ItemSpecifics"],
  "ready_for_seed_live_path_review": true,
  "ready_for_live_execution": false,
  "rollback_snapshot_exists": true,
  "marketplace_execution_event_count": 0,
  "actual_database_write": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "marketplace_write_performed": false,
  "execution_state_updated": false,
  "executed_at_updated": false,
  "execution_result_updated": false
}
```

Live execution still requires separate explicit user approval in a later phase.
