# Hermes Phase 13U — Promoted Final Approval

## Scope

Phase 13U implements the final operator approval action for the Phase 13T internal promoted approval artifact.

Baseline:

```text
d9cd885 Add Phase 13T promoted approval request
```

Phase 13U does not redo Phase 13T. The existing approval artifact remains the source object:

- approval artifact id: `15`
- packet artifact id: `14`
- source opportunity id: `13`
- source review id: `9`
- target item id: `206315990948`
- planned mutation: `item_specifics` only
- approval status before action: `pending`
- no execution request exists
- no marketplace write has occurred

## Hard boundary

Phase 13U updates only the internal approval artifact metadata/status.

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

## CLI

Dry-run approve:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-approval-action --approval-id=15 --action=approve --actor=operator --reason="final approval for promoted packet" --dry-run
```

Dry-run reject is also supported:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-approval-action --approval-id=15 --action=reject --actor=operator --reason="..." --dry-run
```

Write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-approval-action --approval-id=15 --action=approve --actor=operator --reason="final approval for promoted packet" --write
```

Approval detail by approval artifact id:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-approval-detail --approval-id=15
```

Default is dry-run unless `--write` is supplied.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helper:

```js
actOnEbayListingQualityPromotedApproval({ approvalId, action, actor, reason, dryRun, write })
```

Enhanced approval detail:

```js
getEbayListingQualityPromotedApprovalDetail({ packetId, approvalId })
```

## Write fields

For `--action=approve --write`, Phase 13U records:

```json
{
  "approval_status": "approved",
  "approved_by_actor": "operator",
  "approval_reason": "final approval for promoted packet",
  "approved_at": "ISO8601",
  "final_operator_approval": true,
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "execution_request_id": null,
  "request_id": null
}
```

For `--action=reject`, Phase 13U records an internal rejection status and rejection metadata while keeping execution unavailable.

## Validation gates before write

The approval action helper validates:

- approval artifact exists
- `opportunity_type=listing_quality_update_approval_request`
- `source_type=phase_13t_promoted_approval_request`
- current `approval_status=pending`
- `packet_artifact_id=14`
- packet artifact exists
- packet `confirmation_status=confirmed`
- planned mutation fields are exactly `["item_specifics"]`
- no forbidden price/inventory/quantity/stock/end/create/relist mutation fields exist
- target item id is exactly `206315990948`
- approval artifact has no execution request id
- packet artifact has no execution request id
- no execution request exists for source opportunity id `13`
- actor and reason are present for write mode

## Observed validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both passed.

Approval detail before write showed:

```json
{
  "approval_id": 15,
  "approval_status": "pending",
  "final_operator_approval": false,
  "packet_artifact_id": 14,
  "target_item_id": "206315990948",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "still_not_execution_candidate": true,
  "execution_request_id": null
}
```

Dry-run approval was unblocked:

```json
{
  "dry_run": true,
  "updated": false,
  "blocked": false,
  "blockers": [],
  "approval_id": 15,
  "action": "approve",
  "verification": {
    "approval_exists": true,
    "source_type_valid": true,
    "approval_status_pending": true,
    "packet_artifact_id": 14,
    "packet_exists": true,
    "packet_confirmation_status": "confirmed",
    "packet_remains_confirmed": true,
    "planned_mutation_fields": ["item_specifics"],
    "planned_mutation_item_specifics_only": true,
    "forbidden_fields_absent": true,
    "target_item_id": "206315990948",
    "target_item_id_valid": true,
    "execution_request_count_for_source_opportunity_before": 0,
    "execution_request_count_for_source_opportunity_after": 0
  }
}
```

Write approval completed:

```json
{
  "dry_run": false,
  "updated": true,
  "approval_id": 15,
  "action": "approve",
  "verification": {
    "approval_id": 15,
    "approval_status": "approved",
    "approved_by_actor": "operator",
    "approval_reason": "final approval for promoted packet",
    "final_operator_approval": true,
    "still_not_execution_candidate": true,
    "not_execution_candidate": true,
    "packet_artifact_id": 14,
    "packet_remains_confirmed": true,
    "planned_mutation_fields": ["item_specifics"],
    "planned_mutation_item_specifics_only": true,
    "execution_request_count_for_source_opportunity_before": 0,
    "execution_request_count_for_source_opportunity_after": 0,
    "execution_request_created": false,
    "execution_state_updated": false
  }
}
```

Approval detail after write confirmed:

```json
{
  "approval_id": 15,
  "approval_status": "approved",
  "final_operator_approval": true,
  "approved_by_actor": "operator",
  "approval_reason": "final approval for promoted packet",
  "packet_artifact_id": 14,
  "target_item_id": "206315990948",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "still_not_execution_candidate": true,
  "execution_request_id": null
}
```

Packet detail after approval confirmed the packet remains confirmed and non-executable:

```json
{
  "packet_id": 14,
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

## Final Phase 13U state

```json
{
  "approval_artifact_id": 15,
  "approval_status": "approved",
  "approved_by_actor": "operator",
  "approval_reason": "final approval for promoted packet",
  "final_operator_approval": true,
  "packet_artifact_id": 14,
  "packet_confirmation_status": "confirmed",
  "source_opportunity_id": 13,
  "source_review_id": 9,
  "target_item_id": "206315990948",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "still_not_execution_candidate": true,
  "execution_request_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "selected_execution_candidate": null
}
```
