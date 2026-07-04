# Hermes Phase 14N — Seed Final Mutation Packet

## Purpose

Phase 14N creates one idempotent internal superseding final mutation request/packet artifact for the Phase 14 seed-promoted opportunity.

It uses only the operator-supplied final JSON. It does not generate title, description, or item specifics. It does not create an approval request, live candidate, eBay call, or marketplace write.

Baseline:

```text
e3a8a27 Add Phase 14M seed final mutation preview gate
```

Phase 14N does not redo Phase 14A through Phase 14M.

## Target

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789"
}
```

## Operator-supplied final mutation JSON

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

Only these final mutation fields are allowed for Phase 14N:

- `title`
- `item_specifics`

Description is intentionally not updated.

## CLI

Dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-mutation-packet --opportunity-id=36 --final-mutation-json='{"title":"Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks","item_specifics":{"Brand":"Torune","Type":"Food Pick","Theme":"Dolphin Sea Friend","Number in Pack":"8"}}' --actor=operator --reason="final title and item specifics supplied" --dry-run
```

Write:

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-mutation-packet --opportunity-id=36 --final-mutation-json='{"title":"Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks","item_specifics":{"Brand":"Torune","Type":"Food Pick","Theme":"Dolphin Sea Friend","Number in Pack":"8"}}' --actor=operator --reason="final title and item specifics supplied" --write
```

Detail:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-detail --opportunity-id=36
```

## Implementation summary

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service functions:

```js
phase14NFinalMutationHash(finalMutation)
listPhase14NSeedFinalMutationRows({ opportunityId, finalMutationHash })
buildPhase14NFinalRequestRecord(...)
buildPhase14NFinalPacketRecord(...)
createEbayListingQualitySeedFinalMutationPacket(...)
getEbayListingQualitySeedFinalMutationDetail({ opportunityId })
```

The write path is idempotent by:

```json
{
  "phase14n_seed_final_mutation_packet": true,
  "source_seed_promoted_opportunity_id": 36,
  "final_mutation_hash": "sha256:56a280ecd0196b8b32bb732a2a910654da721a89c41801ef59dfb77b549926b8"
}
```

## Validation gates

The create command reuses Phase 14M final mutation preview validation and additionally requires:

- `blocked=false`
- final mutation fields exactly `title,item_specifics`
- no `description` mutation
- no price/inventory/quantity mutation
- target item id exactly `206288370789`
- source review id exactly `19`
- opportunity id exactly `36`

## Safety boundary

Phase 14N does not:

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
- create approval requests
- create live candidates
- call AI
- push commits

Allowed write in `--write` mode:

- one internal superseding request artifact
- one internal superseding packet artifact

The artifacts are internal only and carry flags showing no marketplace execution approval, no external action, no eBay call, and no marketplace write.

## Internal records created

Write mode created:

```json
{
  "final_request_id": 5,
  "final_packet_id": 4,
  "opportunity_id": 36,
  "source_review_id": 19,
  "target_item_id": "206288370789",
  "operation": "listing_quality_update",
  "final_mutation_hash": "sha256:56a280ecd0196b8b32bb732a2a910654da721a89c41801ef59dfb77b549926b8",
  "planned_mutation_fields": ["title", "item_specifics"]
}
```

The internal final request has:

```json
{
  "id": 5,
  "opportunity_id": 36,
  "sku": "PMC-24141",
  "execution_type": "listing_quality_update",
  "status": "dry_run_ready",
  "final_approval_status": "approved",
  "executed_at": null,
  "execution_result": null,
  "metadata": {
    "hermes_phase": "14N",
    "phase14n_seed_final_mutation_packet": true,
    "source_seed_promoted_opportunity_id": 36,
    "source_review_id": 19,
    "target_item_id": "206288370789",
    "planned_mutation_fields": ["title", "item_specifics"],
    "operator_supplied_json_only": true,
    "guesses_from_title": false,
    "external_action_executed": false,
    "marketplace_execution_approved": false,
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

The internal final packet has:

```json
{
  "id": 4,
  "request_id": 5,
  "item_id": "206288370789",
  "status": "packet_recorded",
  "confirmation_status": "confirmed",
  "planned_mutation": {
    "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
    "item_specifics": {
      "Brand": "Torune",
      "Type": "Food Pick",
      "Theme": "Dolphin Sea Friend",
      "Number in Pack": "8"
    }
  }
}
```

## Validation results

Required non-piped commands were run.

### Syntax checks

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### Phase 14M preview for operator JSON

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-preview --opportunity-id=36 --final-mutation-json='{"title":"Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks","item_specifics":{"Brand":"Torune","Type":"Food Pick","Theme":"Dolphin Sea Friend","Number in Pack":"8"}}'
```

Observed:

```json
{
  "blocked": false,
  "blockers": [],
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "final_mutation_preview": {
    "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
    "item_specifics": {
      "Brand": "Torune",
      "Type": "Food Pick",
      "Theme": "Dolphin Sea Friend",
      "Number in Pack": "8"
    }
  },
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["title", "item_specifics"],
    "forbidden_fields_present": false
  },
  "actual_database_write": false,
  "actual_ebay_call": false,
  "marketplace_write_performed": false
}
```

### Dry-run create command

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-mutation-packet --opportunity-id=36 --final-mutation-json='{"title":"Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks","item_specifics":{"Brand":"Torune","Type":"Food Pick","Theme":"Dolphin Sea Friend","Number in Pack":"8"}}' --actor=operator --reason="final title and item specifics supplied" --dry-run
```

Observed:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "blocked": false,
  "created": false,
  "request_created": false,
  "packet_created": false,
  "idempotent_existing": false,
  "final_mutation_hash": "sha256:56a280ecd0196b8b32bb732a2a910654da721a89c41801ef59dfb77b549926b8",
  "validation": {
    "planned_mutation_fields": ["title", "item_specifics"],
    "final_mutation_fields_exact_title_and_item_specifics": true,
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "target_item_id_exact": true,
    "operation_listing_quality_update": true,
    "request_executed_at": null,
    "request_execution_result": null
  },
  "actual_database_write": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false
}
```

### First write command

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-mutation-packet --opportunity-id=36 --final-mutation-json='{"title":"Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks","item_specifics":{"Brand":"Torune","Type":"Food Pick","Theme":"Dolphin Sea Friend","Number in Pack":"8"}}' --actor=operator --reason="final title and item specifics supplied" --write
```

Observed:

```json
{
  "blocked": false,
  "created": true,
  "request_created": true,
  "packet_created": true,
  "internal_request_artifact_created": true,
  "internal_packet_artifact_created": true,
  "idempotent_existing": false,
  "final_request_id": 5,
  "final_packet_id": 4,
  "validation": {
    "planned_mutation_fields": ["title", "item_specifics"],
    "final_mutation_fields_exact_title_and_item_specifics": true,
    "no_description_mutation": true,
    "no_price_inventory_quantity_mutation": true,
    "target_item_id_exact": true,
    "operation_listing_quality_update": true,
    "request_executed_at": null,
    "request_execution_result": null,
    "final_request_marketplace_execution_event_count": 0,
    "packet_count_before": 3,
    "packet_count_after": 4
  },
  "actual_database_write": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false
}
```

### Repeated write command is idempotent

```bash
npm run hermes:agent -- ebay-listing-quality-create-seed-final-mutation-packet --opportunity-id=36 --final-mutation-json='{"title":"Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks","item_specifics":{"Brand":"Torune","Type":"Food Pick","Theme":"Dolphin Sea Friend","Number in Pack":"8"}}' --actor=operator --reason="final title and item specifics supplied" --write
```

Observed:

```json
{
  "blocked": false,
  "created": false,
  "request_created": false,
  "packet_created": false,
  "internal_request_artifact_created": false,
  "internal_packet_artifact_created": false,
  "idempotent_existing": true,
  "final_request_id": 5,
  "final_packet_id": 4,
  "validation": {
    "packet_count_before": 4,
    "packet_count_after": 4,
    "approval_request_count_before": 5,
    "approval_request_count_after": 5,
    "final_request_marketplace_execution_event_count": 0
  },
  "actual_database_write": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false
}
```

### Detail command

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
  "final_mutation_hash": "sha256:56a280ecd0196b8b32bb732a2a910654da721a89c41801ef59dfb77b549926b8",
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

## Final Phase 14N state

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "final_request_id": 5,
  "final_packet_id": 4,
  "final_mutation_fields": ["title", "item_specifics"],
  "description_changes": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "idempotent_existing_on_second_write": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false,
  "marketplace_execution_event_count": 0
}
```
