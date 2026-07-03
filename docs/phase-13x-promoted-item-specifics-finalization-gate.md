# Hermes Phase 13X — Promoted Item Specifics Finalization Gate

## Scope

Phase 13X blocks placeholder/internal `item_specifics` from any promoted live execution path for:

```json
{
  "approval_id": 15,
  "request_id": 3,
  "legacy_packet_id": 2,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update"
}
```

Current Phase 13V/13W payload is item-specifics-only, but it contains an internal placeholder field:

```json
{
  "required_human_review": true
}
```

Phase 13X does not execute eBay and does not mutate the confirmed packet. It adds an audit gate and an operator-supplied JSON preview gate.

## Safety boundary

Phase 13X must not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call live transport
- perform a marketplace write
- write database execution state
- update `request.executed_at`
- update `request.execution_result`
- create marketplace execution events
- change price
- change inventory
- change quantity
- change title
- change description
- mutate confirmed packet id `2` silently

If final item specifics are later accepted, the safer path is a superseding packet requiring reconfirmation/reapproval, not silent mutation of confirmed packet id `2`.

## CLI

Audit current promoted item specifics:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-item-specifics-audit --approval-id=15
```

Preview operator-supplied final item specifics:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-item-specifics-preview --approval-id=15 --item-specifics-json='{}'
```

Example non-empty operator preview:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-item-specifics-preview --approval-id=15 --item-specifics-json='{"Brand":"Pokemon","Type":"Magnet"}'
```

The preview accepts only operator-supplied JSON. It does not guess item specifics from the title.

## Placeholder/internal blocker rules

The audit blocks:

- `required_human_review`
- `internal_review`
- `human_review`
- `placeholder`
- `todo`
- empty item-specifics objects
- empty field names
- empty values
- boolean-only fake fields such as `true` / `false`

## Hard live blocker

Phase 13X adds the item-specifics audit into:

- `ebay-listing-quality-promoted-live-readiness`
- `ebay-listing-quality-promoted-live-transport`

As long as confirmed packet id `2` contains placeholder/internal item specifics, promoted readiness and transport are blocked.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added helpers:

```js
auditPhase13XItemSpecificsValue(itemSpecifics)
auditEbayListingQualityPromotedItemSpecifics({ approvalId })
previewEbayListingQualityPromotedItemSpecifics({ approvalId, itemSpecificsJson })
```

## Validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both passed.

Audit command detected the current placeholder blocker:

```json
{
  "approval_id": 15,
  "request_id": 3,
  "packet_id": 2,
  "target_item_id": "206315990948",
  "blocked": true,
  "blockers": [
    "placeholder_item_specifics_present",
    "boolean_only_fake_item_specifics_present"
  ],
  "item_specifics": {
    "required_human_review": true
  },
  "item_specifics_audit": {
    "blocked": true,
    "findings": [
      {
        "type": "placeholder_field_name",
        "field": "required_human_review",
        "value": "true",
        "matched": "required_human_review"
      },
      {
        "type": "boolean_only_fake_field",
        "field": "required_human_review",
        "value": "true"
      }
    ]
  }
}
```

Promoted live readiness is now blocked because placeholder item specifics are present:

```json
{
  "approval_id": 15,
  "request_id": 3,
  "legacy_packet_id": 2,
  "ready_for_promoted_live_path_review": false,
  "ready_for_live_execution": false,
  "blockers": [
    "placeholder_item_specifics_present",
    "boolean_only_fake_item_specifics_present"
  ],
  "checks": {
    "item_specifics_audit_blocked": true,
    "item_specifics_audit_blockers": [
      "placeholder_item_specifics_present",
      "boolean_only_fake_item_specifics_present"
    ],
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "no_previous_marketplace_execution_event": true
  }
}
```

Promoted live transport dry-run is also blocked:

```json
{
  "approval_id": 15,
  "request_id": 3,
  "packet_id": 2,
  "ready_for_live_call": false,
  "would_call_ebay": false,
  "blocked": true,
  "blockers": [
    "placeholder_item_specifics_present",
    "boolean_only_fake_item_specifics_present"
  ],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false
}
```

Preview with empty operator JSON works and returns a safe blocker without writes:

```json
{
  "approval_id": 15,
  "request_id": 3,
  "source_packet_id": 2,
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "blocked": true,
  "blockers": [
    "item_specifics_empty",
    "operator_item_specifics_json_empty"
  ],
  "final_item_specifics_preview": {},
  "actual_database_write": false,
  "actual_ebay_call": false,
  "marketplace_write_performed": false
}
```

Preview with non-empty operator JSON builds an item-specifics-only payload without writes:

```json
{
  "blocked": false,
  "blockers": [],
  "final_item_specifics_preview": {
    "Brand": "Pokemon",
    "Type": "Magnet"
  },
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["ItemSpecifics"],
    "forbidden_fields_present": false
  },
  "superseding_packet_required_for_write": true,
  "would_mutate_confirmed_packet_id_2": false,
  "approval_reconfirmation_required_for_future_write": true
}
```

Execution events for request id `3` remain empty:

```json
{
  "count": 0,
  "data": []
}
```

## Final Phase 13X state

```json
{
  "approval_id": 15,
  "request_id": 3,
  "legacy_packet_id": 2,
  "target_item_id": "206315990948",
  "current_item_specifics": {
    "required_human_review": true
  },
  "placeholder_item_specifics_blocked": true,
  "promoted_live_readiness_blocked": true,
  "promoted_live_transport_blocked": true,
  "requires_operator_supplied_json": true,
  "guesses_from_title": false,
  "superseding_packet_required_for_write": true,
  "confirmed_packet_2_mutated": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false,
  "actual_database_write": false,
  "marketplace_execution_event_count_for_request_3": 0
}
```
