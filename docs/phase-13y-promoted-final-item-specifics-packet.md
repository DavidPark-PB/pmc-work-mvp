# Hermes Phase 13Y — Promoted Final Item Specifics Packet

## Scope

Phase 13Y creates a superseding internal final `item_specifics` request/packet path for approval artifact `15`.

It does not mutate confirmed placeholder packet id `2`.
It does not execute eBay.

Baseline:

```json
{
  "approval_artifact_id": 15,
  "source_request_id": 3,
  "source_legacy_packet_id": 2,
  "target_item_id": "206315990948",
  "source_packet_blocker": {
    "required_human_review": true
  },
  "source_request_marketplace_execution_event_count": 0
}
```

Operator-supplied final item specifics:

```json
{
  "Brand": "Pokemon",
  "Franchise": "Pokemon",
  "Type": "Magnet",
  "Country/Region of Manufacture": "Korea, Republic of",
  "Theme": "Anime & Manga",
  "Original/Licensed Reproduction": "Original"
}
```

No item specifics were guessed from the title.

## Safety boundary

Phase 13Y must not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call live transport
- perform a marketplace write
- update `request.executed_at`
- update `request.execution_result`
- create marketplace execution events
- mutate packet id `2`
- change title
- change description
- change price
- change inventory
- change quantity

Phase 13Y may write only internal superseding request/packet records.

## CLI

Dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-final-item-specifics-packet --approval-id=15 --item-specifics-json='{"Brand":"Pokemon","Franchise":"Pokemon","Type":"Magnet","Country/Region of Manufacture":"Korea, Republic of","Theme":"Anime & Manga","Original/Licensed Reproduction":"Original"}' --actor=operator --reason="final item specifics supplied" --dry-run
```

Write:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-final-item-specifics-packet --approval-id=15 --item-specifics-json='{"Brand":"Pokemon","Franchise":"Pokemon","Type":"Magnet","Country/Region of Manufacture":"Korea, Republic of","Theme":"Anime & Manga","Original/Licensed Reproduction":"Original"}' --actor=operator --reason="final item specifics supplied" --write
```

Detail:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-final-item-specifics-detail --approval-id=15
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
phase13YFinalItemSpecificsHash(itemSpecifics)
listPhase13YFinalItemSpecificsRows({ approvalId, itemSpecificsHash })
buildPhase13YFinalRequestRecord(...)
buildPhase13YFinalLegacyPacketRecord(...)
createEbayListingQualityPromotedFinalItemSpecificsPacket(...)
getEbayListingQualityPromotedFinalItemSpecificsDetail({ approvalId })
```

The promoted live readiness selector now prefers the Phase 13Y final non-placeholder request/packet when present, while preserving source request/packet references.

## Internal records created

Write mode created:

```json
{
  "final_request_id": 4,
  "final_packet_id": 3,
  "source_request_id": 3,
  "source_packet_id": 2,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update",
  "final_item_specifics_hash": "sha256:5b41616cf57fcc794c1763ed66d2fd92344f1a0558fb7db002f0ffc1f0226e7b"
}
```

The final request is an internal `hermes_execution_requests` row:

```json
{
  "id": 4,
  "sku": "206315990948",
  "execution_type": "listing_quality_update",
  "status": "dry_run_ready",
  "final_approval_status": "approved",
  "executed_at": null,
  "execution_result": null,
  "metadata": {
    "hermes_phase": "13Y",
    "phase13y_promoted_final_item_specifics_packet": true,
    "promoted_approval_artifact_id": 15,
    "supersedes_request_id": 3,
    "supersedes_packet_id": 2,
    "target_item_id": "206315990948",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "operator_supplied_json_only": true,
    "guesses_from_title": false,
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false,
    "live_transport_called": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "title_changes": false,
    "description_changes": false
  }
}
```

The final packet is an internal `hermes_ebay_listing_quality_packets` row:

```json
{
  "id": 3,
  "request_id": 4,
  "item_id": "206315990948",
  "status": "packet_recorded",
  "confirmation_status": "confirmed",
  "planned_mutation": {
    "item_specifics": {
      "Brand": "Pokemon",
      "Franchise": "Pokemon",
      "Type": "Magnet",
      "Country/Region of Manufacture": "Korea, Republic of",
      "Theme": "Anime & Manga",
      "Original/Licensed Reproduction": "Original"
    }
  }
}
```

## Idempotency

The final path is keyed by:

```json
{
  "phase13y_promoted_final_item_specifics_packet": true,
  "promoted_approval_artifact_id": 15,
  "final_item_specifics_hash": "sha256:5b41616cf57fcc794c1763ed66d2fd92344f1a0558fb7db002f0ffc1f0226e7b"
}
```

Repeated write returned:

```json
{
  "created": false,
  "request_created": false,
  "packet_created": false,
  "idempotent_existing": true,
  "final_request_id": 4,
  "final_packet_id": 3
}
```

No duplicate final request or packet was created.

## Validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both passed.

Audit still shows source packet id `2` placeholder blocker:

```json
{
  "request_id": 3,
  "packet_id": 2,
  "blocked": true,
  "blockers": [
    "placeholder_item_specifics_present",
    "boolean_only_fake_item_specifics_present"
  ],
  "item_specifics": {
    "required_human_review": true
  }
}
```

Dry-run final packet creation validated:

```json
{
  "blocked": false,
  "source_request_id": 3,
  "source_packet_id": 2,
  "target_item_id": "206315990948",
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["ItemSpecifics"],
    "forbidden_fields_present": false
  },
  "validation": {
    "target_item_id_exact": true,
    "operation_listing_quality_update": true,
    "payload_item_specifics_only": true,
    "no_title_mutation": true,
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "request_executed_at": null,
    "request_execution_result": null,
    "source_request_marketplace_execution_event_count": 0
  }
}
```

Detail command shows final request/packet:

```json
{
  "approval_id": 15,
  "source_request_id": 3,
  "source_packet_id": 2,
  "final_request_id": 4,
  "final_packet_id": 3,
  "target_item_id": "206315990948",
  "item_specifics_audit": {
    "blocked": false,
    "blockers": []
  },
  "payload_summary": {
    "payload_fields": ["ItemSpecifics"],
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": true,
    "forbidden_fields_present": false
  },
  "validation": {
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "marketplace_execution_event_count": 0,
    "no_marketplace_execution_events": true,
    "source_packet_2_not_mutated": true
  }
}
```

Execution events remained empty:

```json
{
  "request_3_execution_events_count": 0,
  "request_4_execution_events_count": 0
}
```

Promoted live readiness now points to the final non-placeholder packet only:

```json
{
  "request_id": 4,
  "legacy_packet_id": 3,
  "source_request_id": 3,
  "source_legacy_packet_id": 2,
  "using_final_item_specifics_packet": true,
  "ready_for_promoted_live_path_review": true,
  "ready_for_live_execution": false,
  "blockers": [],
  "checks": {
    "payload_fields": ["ItemSpecifics"],
    "payload_item_specifics_only": true,
    "item_specifics_audit_blocked": false,
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "no_previous_marketplace_execution_event": true,
    "previous_marketplace_execution_event_count": 0
  }
}
```

## Final Phase 13Y state

```json
{
  "approval_id": 15,
  "source_request_id": 3,
  "source_packet_id": 2,
  "final_request_id": 4,
  "final_packet_id": 3,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update",
  "payload_fields": ["ItemSpecifics"],
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "source_packet_2_mutated": false,
  "request_3_execution_events_count": 0,
  "request_4_execution_events_count": 0,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "marketplace_write_performed": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "title_changes": false,
  "description_changes": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false
}
```
