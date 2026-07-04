# Hermes Phase 14L — Seed Promoted Packet Preview

## Purpose

Phase 14L adds a read-only packet preview for the Phase 14K-approved seed-promoted opportunity.

This phase builds a packet-shaped preview object only. It does not insert a packet row and has no write mode.

Baseline:

```text
2c7790e Add Phase 14K seed promoted opportunity human gate
```

Phase 14L does not redo Phase 14A through Phase 14K.

## Target opportunity

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "source_type": "phase_14_seed_review_promotion",
  "human_review_status": "approved_for_packet",
  "allowed_mutation_fields": ["title", "description", "item_specifics"]
}
```

## Command

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-packet-preview --opportunity-id=36
```

The command is read-only. It does not accept or require `--write`.

## Packet-shaped preview contents

The preview loads `opportunity_id=36`, verifies it is a Phase 14 seed-promoted listing-quality improvement, verifies the human gate is approved for packet preview, loads cached internal listing evidence only, and returns a packet-shaped object:

```json
{
  "id": null,
  "request_id": null,
  "opportunity_id": 36,
  "source_review_id": 19,
  "status": "packet_preview_only",
  "confirmation_status": "not_created",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "item_id": "206288370789",
  "target_item_id": "206288370789",
  "allowed_mutation_fields": ["title", "description", "item_specifics"],
  "planned_mutation": {
    "title": { "required_human_review": true },
    "description": { "required_human_review": true },
    "item_specifics": { "required_human_review": true }
  },
  "rollback_snapshot": {},
  "cached_evidence_snapshot": {},
  "safety_gates": {}
}
```

`packet_would_be_created=false` and `packet_created=false` are returned both at top level and in safety/verification fields.

## Planned mutation boundary

Phase 14L does not invent a final title, description, or item specifics.

For this target opportunity there are no explicit final proposed values in source metadata, so the preview uses human-review placeholders:

```json
{
  "title": {
    "required_human_review": true
  },
  "description": {
    "required_human_review": true
  },
  "item_specifics": {
    "required_human_review": true
  }
}
```

No AI call is made. No title, description, or item-specific value is auto-generated.

## Rollback and cached evidence source

Rollback and evidence snapshots are built from cached internal listing evidence only.

Observed cached evidence summary:

```json
{
  "source": "cached_internal_data_only",
  "source_tables": [
    "ebay_products",
    "listing_details",
    "listing_item_specifics",
    "listing_images",
    "listing_policies"
  ],
  "item_id": "206288370789",
  "sku": "PMC-24141",
  "title": "Torune Dolphin Sea Friend Pick 8p",
  "title_present": true,
  "description_present": true,
  "description_length": 863,
  "item_specifics_count": 2,
  "images_count": 1,
  "policies_present": true,
  "listing_status": "Active",
  "listing_status_active": true,
  "live_marketplace_state_fetched": false,
  "ebay_api_call_made": false
}
```

Observed rollback snapshot summary:

```json
{
  "title": "Torune Dolphin Sea Friend Pick 8p",
  "description_present": true,
  "item_specifics": {
    "Brand": "Unbranded",
    "Type": "See Description"
  },
  "available": true,
  "source": "phase_14l_cached_internal_evidence_preview"
}
```

## Forbidden field check

The preview proves no forbidden mutation families are present:

```json
{
  "forbidden_fields_present": false,
  "forbidden_fields": [],
  "non_allowed_fields": [],
  "allowed_mutation_fields": ["title", "description", "item_specifics"],
  "payload_fields": ["title", "description", "item_specifics"],
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "stock_changes": false,
  "shipping_changes": false,
  "payment_changes": false,
  "returns_changes": false,
  "category_changes": false,
  "image_changes": false,
  "listing_end_create_relist": false,
  "sku_remapping": false
}
```

## Safety gates

Observed safety gates:

```json
{
  "human_review_approved_for_packet": true,
  "packet_preview_only": true,
  "packet_would_be_created": false,
  "no_ebay_call": true,
  "no_get_item_call": true,
  "no_revise_fixed_price_item_call": true,
  "no_marketplace_write": true,
  "no_packet_created": true,
  "no_approval_created": true,
  "no_execution_request_created": true,
  "no_live_candidate_created": true,
  "allowed_fields_only": true,
  "forbidden_fields_absent": true,
  "no_price_inventory_quantity_fields": true
}
```

## Safety guarantees

Phase 14L does not:

- write to the database
- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call eBay write APIs
- write to marketplaces
- mutate listings
- change price, inventory, quantity, title, description, or item specifics
- create packets
- create approval requests
- create execution requests
- create live candidates
- call AI
- push commits

## Validation results

Required non-piped validations were run.

### Syntax

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### Target opportunity detail

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-detail --id=36
```

Observed:

```json
{
  "found": true,
  "promoted_opportunity": {
    "id": 36,
    "opportunity_type": "listing_quality_improvement",
    "source": "phase_14_seed_review_promotion",
    "status": "reviewing",
    "item_id": "206288370789",
    "sku": "PMC-24141",
    "source_review_id": 19,
    "human_review_status": "approved_for_packet",
    "phase_14k_human_gate": true,
    "still_not_execution_candidate": true,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false
  }
}
```

### Packet preview

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-packet-preview --opportunity-id=36
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "preview_type": "seed_promoted_packet_preview",
  "opportunity_id": 36,
  "source_review_id": 19,
  "item_id": "206288370789",
  "human_review_status": "approved_for_packet",
  "packet_would_be_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "planned_mutation_fields": ["title", "description", "item_specifics"],
  "allowed_mutation_fields": ["title", "description", "item_specifics"],
  "blockers": [],
  "warnings": [],
  "forbidden_field_check": {
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false
  },
  "verification": {
    "packet_count_before": 3,
    "packet_count_after": 3,
    "packet_created": false,
    "approval_request_count_before": 4,
    "approval_request_count_after": 4,
    "approval_created": false,
    "execution_request_count_before": 4,
    "execution_request_count_after": 4,
    "execution_request_created": false,
    "marketplace_execution_event_count_before": 2,
    "marketplace_execution_event_count_after": 2,
    "marketplace_execution_event_created": false,
    "actual_database_write": false
  }
}
```

### Seed-promoted opportunity list after preview

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunities --limit=20
```

Observed:

```json
{
  "count": 1,
  "promoted_opportunities": [
    {
      "id": 36,
      "source": "phase_14_seed_review_promotion",
      "status": "reviewing",
      "human_review_status": "approved_for_packet",
      "packet_created": false,
      "approval_created": false,
      "execution_request_created": false,
      "live_candidate_created": false,
      "marketplace_write_performed": false
    }
  ]
}
```

## Final Phase 14L state

```json
{
  "promoted_opportunity_id": 36,
  "source_review_id": 19,
  "item_id": "206288370789",
  "human_review_status": "approved_for_packet",
  "preview_type": "seed_promoted_packet_preview",
  "packet_would_be_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "marketplace_write_performed": false,
  "actual_database_write": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "ebay_write_api_called": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "ai_called": false
}
```
