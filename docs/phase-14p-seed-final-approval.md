# Hermes Phase 14P — Seed Final Approval

## Purpose

Phase 14P adds the final operator approval action for the Phase 14O internal approval artifact.

This records final approval internally only.

It is still not an execution request and still not live execution.

Baseline:

```text
2f369a7 Add Phase 14O seed final approval request
```

Phase 14P does not redo Phase 14A through Phase 14O.

## Target approval/packet/request

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

Phase 14N final mutation:

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

Approval detail by approval id:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --approval-id=37
```

Dry-run approve:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=37 --action=approve --actor=operator --reason="final approval for seed final mutation packet" --dry-run
```

Write approve:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=37 --action=approve --actor=operator --reason="final approval for seed final mutation packet" --write
```

Dry-run reject:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=37 --action=reject --actor=operator --reason="not approved for execution bridge" --dry-run
```

Supported actions:

- `approve`
- `reject`

Default is dry-run unless `--write` is provided.

## Validation gates

Before write, Phase 14P validates:

- approval artifact id `37` exists
- `opportunity_type=listing_quality_update_approval_request`
- `source_type=phase_14o_seed_final_approval_request`
- current `approval_status=pending`
- `packet_artifact_id=4`
- `request_id=5`
- packet id `4` exists
- packet `confirmation_status=confirmed`
- request id `5` exists
- request `executed_at` is null
- request `execution_result` is null
- planned mutation fields are exactly `["title", "item_specifics"]`
- no description mutation exists
- no price/inventory/quantity mutation exists
- target item id is exactly `206288370789`
- approval artifact has no `execution_request_id`
- packet has no `execution_request_id`
- no execution request exists for opportunity id `36` beyond the Phase 14N source request
- no `marketplace_execution_completed` event exists for request id `5` or item id `206288370789`
- actor and reason are present for write mode

## Approve behavior

For `--action=approve --write`, Phase 14P updates only the internal Phase 14O approval artifact metadata/status:

```json
{
  "approval_status": "approved",
  "approved_by_actor": "operator",
  "approval_reason": "final approval for seed final mutation packet",
  "approved_at": "ISO8601",
  "final_operator_approval": true,
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "execution_request_id": null,
  "request_id": 5,
  "phase_14p_seed_final_approval": true
}
```

The `opportunity_inbox.status` becomes `approval_approved`.

## Reject behavior

For `--action=reject`, Phase 14P would update only the same internal approval artifact with:

```json
{
  "approval_status": "rejected",
  "final_operator_approval": false,
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "execution_request_id": null,
  "request_id": 5,
  "phase_14p_seed_final_approval": true
}
```

After approval has already been written, the required pending-status validation blocks a later reject dry-run with `approval_status_not_pending`. The reject dry-run remains read-only and creates no execution request or marketplace action.

## Safety guarantees

Phase 14P does not:

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
- create execution requests
- update execution state
- create live candidates
- call AI
- push commits

Allowed write in `--write` mode:

- update only internal approval artifact metadata/status for approval id `37`

## Validation results

Required non-piped commands were run.

### Syntax checks

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### Approval detail before write

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --approval-id=37
```

Observed:

```json
{
  "operation": "listing_quality_seed_final_approval_detail",
  "packet_id": 4,
  "request_id": 5,
  "approval_id": 37,
  "approval_status": "pending",
  "final_operator_approval": false,
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
    "final_mutation_fields_exact_title_and_item_specifics": true,
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

### Approve dry-run

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=37 --action=approve --actor=operator --reason="final approval for seed final mutation packet" --dry-run
```

Observed:

```json
{
  "operation": "listing_quality_seed_final_approval_action",
  "approval_id": 37,
  "packet_id": 4,
  "request_id": 5,
  "action": "approve",
  "updated": false,
  "approval_status": "approved",
  "final_operator_approval": true,
  "blocked": false,
  "blockers": [],
  "verification": {
    "approval_exists": true,
    "source_type_valid": true,
    "approval_status_pending": true,
    "packet_remains_confirmed": true,
    "planned_mutation_fields": ["title", "item_specifics"],
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "target_item_id_exact": true,
    "execution_request_count_for_opportunity": 0,
    "marketplace_execution_completed_event_count": 0,
    "execution_request_created": false,
    "execution_state_updated": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false
  },
  "actual_database_write": false
}
```

### Approve write

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=37 --action=approve --actor=operator --reason="final approval for seed final mutation packet" --write
```

Observed:

```json
{
  "operation": "listing_quality_seed_final_approval_action",
  "approval_id": 37,
  "packet_id": 4,
  "request_id": 5,
  "action": "approve",
  "updated": true,
  "approval_status": "approved",
  "final_operator_approval": true,
  "blocked": false,
  "blockers": [],
  "verification": {
    "approval_exists": true,
    "source_type_valid": true,
    "approval_status_pending": true,
    "packet_remains_confirmed": true,
    "planned_mutation_fields": ["title", "item_specifics"],
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "target_item_id_exact": true,
    "execution_request_count_for_opportunity": 0,
    "marketplace_execution_completed_event_count": 0,
    "approval_status": "approved",
    "final_operator_approval": true,
    "still_not_execution_candidate": true,
    "not_execution_candidate": true,
    "execution_request_created": false,
    "execution_state_updated": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false
  },
  "actual_database_write": true
}
```

### Approval detail after write

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --approval-id=37
```

Observed:

```json
{
  "operation": "listing_quality_seed_final_approval_detail",
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

### Reject dry-run after approval

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-action --approval-id=37 --action=reject --actor=operator --reason="not approved for execution bridge" --dry-run
```

Observed:

```json
{
  "operation": "listing_quality_seed_final_approval_action",
  "approval_id": 37,
  "packet_id": 4,
  "request_id": 5,
  "action": "reject",
  "updated": false,
  "approval_status": "approved",
  "final_operator_approval": true,
  "blocked": true,
  "blockers": ["approval_status_not_pending"],
  "verification": {
    "approval_exists": true,
    "source_type_valid": true,
    "approval_status_pending": false,
    "packet_remains_confirmed": true,
    "planned_mutation_fields": ["title", "item_specifics"],
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "target_item_id_exact": true,
    "execution_request_count_for_opportunity": 0,
    "marketplace_execution_completed_event_count": 0,
    "execution_request_created": false,
    "execution_state_updated": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false
  },
  "actual_database_write": false
}
```

## Final Phase 14P state

```json
{
  "approval_id": 37,
  "approval_status": "approved",
  "approved_by_actor": "operator",
  "approval_reason": "final approval for seed final mutation packet",
  "final_operator_approval": true,
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "packet_artifact_id": 4,
  "request_id": 5,
  "opportunity_id": 36,
  "source_review_id": 19,
  "target_item_id": "206288370789",
  "planned_mutation_fields": ["title", "item_specifics"],
  "execution_request_id": null,
  "execution_request_created": false,
  "execution_state_updated": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "description_changes": false
}
```
