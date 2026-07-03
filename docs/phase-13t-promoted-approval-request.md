# Hermes Phase 13T — Promoted Approval Request

## Scope

Phase 13T creates exactly one internal approval request for the confirmed Phase 13S promoted packet artifact.

Baseline:

```text
a4f1f75 Add Phase 13S promoted packet confirmation
```

Phase 13T does not redo Phase 13S. The existing promoted packet artifact remains the source object:

- packet artifact id: `14`
- source opportunity id: `13`
- source review id: `9`
- target item id: `206315990948`
- source type: `phase_13r_promoted_packet_creation`
- packet status: `packet_recorded`
- confirmation status: `confirmed`
- planned mutation: `item_specifics` only
- not execution candidate: `true`

## Hard boundary

Phase 13T creates an internal approval request only.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- create an execution request
- update execution state
- execute marketplace actions
- modify price, inventory, quantity, shipping, payment, returns, title, description, or live listing content
- push commits

## Storage

The approval request is stored as an internal `opportunity_inbox` artifact:

```text
opportunity_type=listing_quality_update_approval_request
source_type=phase_13t_promoted_approval_request
status=approval_pending
metadata.packet_artifact_id=14
```

This intentionally remains separate from `hermes_execution_requests`; no execution request is created in Phase 13T.

## CLI

Dry-run, default behavior:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-approval --packet-id=14 --dry-run
```

Write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-approval --packet-id=14 --write
```

Approval detail:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-approval-detail --packet-id=14
```

Default is dry-run unless `--write` is supplied.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
createEbayListingQualityPromotedApproval({ packetId, dryRun, write })
getEbayListingQualityPromotedApprovalDetail({ packetId })
```

## Approval request contents

The created approval request includes:

```json
{
  "packet_artifact_id": 14,
  "opportunity_id": 13,
  "source_review_id": 9,
  "target_item_id": "206315990948",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "planned_mutation": {
    "item_specifics": {
      "required_human_review": true
    }
  },
  "planned_mutation_fields": ["item_specifics"],
  "approval_status": "pending",
  "not_execution_candidate": true,
  "requires_final_operator_approval": true,
  "request_id": null,
  "execution_request_id": null
}
```

## Validation gates before write

The approval creation helper validates:

- packet artifact exists
- `opportunity_type=listing_quality_update_packet`
- `source_type=phase_13r_promoted_packet_creation`
- packet row `status=packet_recorded`
- packet `confirmation_status=confirmed`
- planned mutation fields are exactly `["item_specifics"]`
- no forbidden price/inventory/quantity/stock/end/create/relist mutation fields exist
- target item id is exactly `206315990948`
- packet remains `not_execution_candidate=true`
- packet has no execution request id
- no execution request exists for source opportunity id `13`
- duplicate approval requests do not already exist

## Idempotency

Approval creation is idempotent by `metadata.packet_artifact_id=14` and `source_type=phase_13t_promoted_approval_request`.

- First write creates one internal approval request.
- Repeat write returns the existing approval request.
- No duplicate approval request is created.

## Observed validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both passed.

Dry-run creation was unblocked:

```json
{
  "dry_run": true,
  "created": false,
  "blocked": false,
  "blockers": [],
  "packet_id": 14,
  "approval_preview": {
    "packet_artifact_id": 14,
    "opportunity_id": 13,
    "source_review_id": 9,
    "target_item_id": "206315990948",
    "marketplace": "ebay",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "approval_status": "pending",
    "not_execution_candidate": true,
    "requires_final_operator_approval": true,
    "execution_request_id": null
  },
  "verification": {
    "packet_confirmation_status": "confirmed",
    "packet_remains_confirmed": true,
    "planned_mutation_item_specifics_only": true,
    "forbidden_fields_absent": true,
    "target_item_id_valid": true,
    "approval_request_count_for_packet_before": 0,
    "approval_request_count_for_packet_after": 0,
    "execution_request_count_for_source_opportunity_before": 0,
    "execution_request_count_for_source_opportunity_after": 0
  }
}
```

Write creation completed:

```json
{
  "dry_run": false,
  "created": true,
  "idempotent_existing": false,
  "packet_id": 14,
  "approval": {
    "id": 15,
    "opportunity_type": "listing_quality_update_approval_request",
    "source_type": "phase_13t_promoted_approval_request",
    "status": "approval_pending",
    "packet_artifact_id": 14,
    "opportunity_id": 13,
    "source_review_id": 9,
    "target_item_id": "206315990948",
    "marketplace": "ebay",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "approval_status": "pending",
    "not_execution_candidate": true,
    "requires_final_operator_approval": true,
    "execution_request_id": null,
    "request_id": null
  },
  "verification": {
    "approval_request_count_for_packet_before": 0,
    "approval_request_count_for_packet_after": 1,
    "exactly_one_approval_for_packet": true,
    "packet_remains_confirmed": true,
    "execution_request_count_for_source_opportunity_before": 0,
    "execution_request_count_for_source_opportunity_after": 0,
    "execution_request_created": false,
    "execution_state_updated": false
  }
}
```

Repeat write returned existing approval request id `15` and did not create a duplicate:

```json
{
  "created": false,
  "idempotent_existing": true,
  "approval": {
    "id": 15,
    "packet_artifact_id": 14,
    "approval_status": "pending",
    "execution_request_id": null
  },
  "verification": {
    "approval_request_count_for_packet_before": 1,
    "approval_request_count_for_packet_after": 1,
    "exactly_one_approval_for_packet": true,
    "packet_remains_confirmed": true,
    "execution_request_count_for_source_opportunity_before": 0,
    "execution_request_count_for_source_opportunity_after": 0,
    "execution_request_created": false,
    "execution_state_updated": false
  }
}
```

Approval detail confirmed exactly one internal approval request:

```json
{
  "found": true,
  "count": 1,
  "verification": {
    "exactly_one_approval_for_packet": true,
    "approval_status": "pending",
    "packet_artifact_id": 14,
    "opportunity_id": 13,
    "source_review_id": 9,
    "target_item_id": "206315990948",
    "planned_mutation_fields": ["item_specifics"],
    "planned_mutation_item_specifics_only": true,
    "not_execution_candidate": true,
    "requires_final_operator_approval": true,
    "execution_request_id": null
  }
}
```

Packet detail after approval creation confirmed the packet remains confirmed and non-executable:

```json
{
  "confirmation_status": "confirmed",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "execution_request_id": null
}
```

Next-candidate selector remains safe:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed:

```json
{
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists.",
  "safety": {
    "read_only": true,
    "actual_ebay_call": false,
    "get_item_called": false,
    "actual_network_call": false,
    "actual_database_write": false,
    "marketplace_write_performed": false,
    "revise_fixed_price_item_called": false,
    "packet_created": false,
    "approval_created": false,
    "execution_state_changed": false,
    "price_changes": false,
    "inventory_changes": false
  }
}
```

## Final Phase 13T state

```json
{
  "packet_artifact_id": 14,
  "approval_request_artifact_id": 15,
  "source_opportunity_id": 13,
  "source_review_id": 9,
  "target_item_id": "206315990948",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["item_specifics"],
  "approval_status": "pending",
  "not_execution_candidate": true,
  "requires_final_operator_approval": true,
  "packet_confirmation_status": "confirmed",
  "exactly_one_approval_for_packet": true,
  "execution_request_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "selected_execution_candidate": null
}
```
