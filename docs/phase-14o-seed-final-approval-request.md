# Hermes Phase 14O — Seed Final Approval Request

## Purpose

Phase 14O creates exactly one internal approval request artifact for the confirmed Phase 14N final mutation packet.

This phase is not final approval.
This phase is not an execution request.
This phase is not a marketplace action.

Baseline:

```text
b3b04f3 Add Phase 14N seed final mutation packet
```

Phase 14O does not redo Phase 14A through Phase 14N.

## Target packet/request

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "final_request_id": 5,
  "final_packet_id": 4,
  "final_mutation_fields": ["title", "item_specifics"]
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

Dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-approval --packet-id=4 --dry-run
```

Write:

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-approval --packet-id=4 --write
```

Detail:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --packet-id=4
```

## Approval artifact shape

The approval request is stored as an internal `opportunity_inbox` artifact.

```json
{
  "opportunity_type": "listing_quality_update_approval_request",
  "source_type": "phase_14o_seed_final_approval_request",
  "status": "approval_pending",
  "metadata": {
    "phase": "14O",
    "packet_artifact_id": 4,
    "request_id": 5,
    "opportunity_id": 36,
    "source_review_id": 19,
    "sku": "PMC-24141",
    "target_item_id": "206288370789",
    "marketplace": "ebay",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["title", "item_specifics"],
    "approval_status": "pending",
    "requires_final_operator_approval": true,
    "not_execution_candidate": true,
    "execution_request_id": null
  }
}
```

Created approval artifact:

```json
{
  "approval_id": 37,
  "opportunity_type": "listing_quality_update_approval_request",
  "source_type": "phase_14o_seed_final_approval_request",
  "status": "approval_pending",
  "approval_status": "pending",
  "packet_artifact_id": 4,
  "request_id": 5,
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "target_item_id": "206288370789",
  "planned_mutation_fields": ["title", "item_specifics"],
  "requires_final_operator_approval": true,
  "not_execution_candidate": true,
  "execution_request_id": null
}
```

## Validation gates

The create command validates before write:

- packet id `4` exists
- packet source is Phase 14N seed final mutation packet
- packet status is `packet_recorded`
- packet confirmation status is `confirmed`
- request id `5` exists
- request `executed_at` is null
- request `execution_result` is null
- planned mutation fields are exactly `["title", "item_specifics"]`
- no description mutation exists
- no price/inventory/quantity mutation exists
- target item id is exactly `206288370789`
- no existing Phase 14O approval request exists for packet id `4` before first write
- no additional execution request exists for opportunity id `36` beyond the Phase 14N source request
- no non-Phase-14N execution request exists for request id `5`
- no `marketplace_execution_completed` event exists for request id `5` or item id `206288370789`

## Idempotency

Phase 14O is idempotent by deterministic metadata:

```json
{
  "source_type": "phase_14o_seed_final_approval_request",
  "packet_artifact_id": 4,
  "request_id": 5
}
```

Observed behavior:

- first `--write` created approval id `37`
- repeated `--write` returned approval id `37`
- repeated `--write` did not create a duplicate
- detail command reports exactly one approval for packet id `4`

## Safety guarantees

Phase 14O does not:

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
- create live candidates
- record final approval
- call AI
- push commits

Allowed write in `--write` mode:

- one internal `opportunity_inbox` approval request artifact only

## Validation results

Required non-piped commands were run.

### Syntax checks

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### Phase 14N source detail

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-detail --opportunity-id=36
```

Observed:

```json
{
  "found": true,
  "final_request_id": 5,
  "final_packet_id": 4,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "target_item_id": "206288370789",
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

### Dry-run create

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-approval --packet-id=4 --dry-run
```

Observed:

```json
{
  "operation": "listing_quality_create_seed_final_approval",
  "packet_id": 4,
  "request_id": 5,
  "created": false,
  "idempotent_existing": false,
  "approval_id": null,
  "approval_status": "pending",
  "blocked": false,
  "blockers": [],
  "verification": {
    "packet_exists": true,
    "request_exists": true,
    "packet_remains_confirmed": true,
    "planned_mutation_fields": ["title", "item_specifics"],
    "final_mutation_fields_exact_title_and_item_specifics": true,
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "target_item_id_exact": true,
    "existing_approval_count_before": 0,
    "execution_request_count_for_opportunity": 0,
    "execution_request_count_for_request": 0,
    "marketplace_execution_completed_event_count": 0,
    "execution_request_created": false,
    "execution_state_updated": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false
  },
  "actual_database_write": false
}
```

### First write

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-approval --packet-id=4 --write
```

Observed:

```json
{
  "operation": "listing_quality_create_seed_final_approval",
  "packet_id": 4,
  "request_id": 5,
  "created": true,
  "idempotent_existing": false,
  "approval_id": 37,
  "approval_status": "pending",
  "blocked": false,
  "blockers": [],
  "verification": {
    "exactly_one_approval_for_packet": true,
    "packet_remains_confirmed": true,
    "existing_approval_count_before": 0,
    "approval_count_after": 1,
    "execution_request_count_for_opportunity": 0,
    "execution_request_count_for_request": 0,
    "marketplace_execution_completed_event_count": 0,
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
  },
  "actual_database_write": true
}
```

### Repeated write

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-approval --packet-id=4 --write
```

Observed:

```json
{
  "operation": "listing_quality_create_seed_final_approval",
  "packet_id": 4,
  "request_id": 5,
  "created": false,
  "idempotent_existing": true,
  "approval_id": 37,
  "approval_status": "pending",
  "verification": {
    "exactly_one_approval_for_packet": true,
    "packet_remains_confirmed": true,
    "existing_approval_count_before": 1,
    "approval_count_after": 1,
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
  },
  "actual_database_write": false
}
```

### Detail

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-approval-detail --packet-id=4
```

Observed:

```json
{
  "read_only": true,
  "packet_id": 4,
  "request_id": 5,
  "approval_id": 37,
  "approval_status": "pending",
  "found": true,
  "count": 1,
  "verification": {
    "exactly_one_approval_for_packet": true,
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
    "revise_fixed_price_item_called": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "description_changes": false
  }
}
```

## Final Phase 14O state

```json
{
  "approval_id": 37,
  "approval_status": "pending",
  "packet_artifact_id": 4,
  "request_id": 5,
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "target_item_id": "206288370789",
  "planned_mutation_fields": ["title", "item_specifics"],
  "requires_final_operator_approval": true,
  "not_execution_candidate": true,
  "execution_request_id": null,
  "exactly_one_approval_for_packet": true,
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
