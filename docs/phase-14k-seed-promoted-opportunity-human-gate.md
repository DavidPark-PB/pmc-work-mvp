# Hermes Phase 14K — Seed Promoted Opportunity Human Gate

## Purpose

Phase 14K adds a human gate for the Phase 14J promoted seed opportunity.

This phase lets an operator mark the promoted opportunity as either:

- `approve_for_packet`
- `reject`

This is still not packet creation. It only updates internal `opportunity_inbox` metadata/status for the existing promoted opportunity when `--write` is explicitly provided.

Baseline:

```text
8a0345f Add Phase 14J seed review promotion
```

Phase 14K does not redo Phase 14A through Phase 14J.

## Target opportunity

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "opportunity_type": "listing_quality_improvement",
  "source_type": "phase_14_seed_review_promotion",
  "allowed_mutation_fields": ["description", "item_specifics", "title"]
}
```

## Commands

List Phase 14J seed-promoted opportunities:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunities --limit=20
```

Show opportunity detail:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-detail --id=36
```

Dry-run human decision:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-action --id=36 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --dry-run
```

Write human decision:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-action --id=36 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --write
```

Supported actions:

- `approve_for_packet`
- `reject`

Default is dry-run unless `--write` is supplied.

## Behavior

The Phase 14K commands operate only on rows where:

```text
opportunity_type = listing_quality_improvement
source_type = phase_14_seed_review_promotion
```

For validation, the target row was `id=36`.

### approve_for_packet

For `approve_for_packet`, table `status` remains `reviewing` and metadata is updated to include:

```json
{
  "human_review_status": "approved_for_packet",
  "review_action": "approve_for_packet",
  "reviewed_by": "operator",
  "reviewed_at": "ISO8601",
  "review_reason": "approved for packet preview",
  "phase_14k_human_gate": true,
  "still_not_execution_candidate": true,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "marketplace_write_performed": false
}
```

### reject

For `reject`, table `status` may become `rejected` and metadata includes:

```json
{
  "human_review_status": "rejected",
  "review_action": "reject",
  "phase_14k_human_gate": true,
  "still_not_execution_candidate": true,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "marketplace_write_performed": false
}
```

## Safety guarantees

Phase 14K does not:

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

The only allowed write is an internal `opportunity_inbox` metadata/status update for the existing `opportunity_id=36`, and only when `--write` is explicitly supplied.

## Verification counters

Before and after the write action, Phase 14K verifies counts did not change for:

- packets
- approval requests
- execution requests
- marketplace execution events

## Validation results

Required non-piped validations were run.

### Syntax

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### List seed-promoted opportunities

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunities --limit=20
```

Observed:

```json
{
  "operation": "listing_quality_seed_promoted_opportunity_list",
  "count": 1,
  "promoted_opportunities": [
    {
      "id": 36,
      "opportunity_type": "listing_quality_improvement",
      "source": "phase_14_seed_review_promotion",
      "status": "reviewing",
      "item_id": "206288370789",
      "sku": "PMC-24141",
      "source_review_id": 19,
      "requires_human_review": true,
      "requires_human_approval": true,
      "not_execution_candidate": true,
      "not_packet": true,
      "not_approval": true,
      "not_execution_request": true,
      "not_live_candidate": true
    }
  ]
}
```

### Detail before write

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-detail --id=36
```

Observed before write:

```json
{
  "found": true,
  "promoted_opportunity": {
    "id": 36,
    "source": "phase_14_seed_review_promotion",
    "status": "reviewing",
    "human_review_status": null,
    "phase_14k_human_gate": false,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false
  }
}
```

### Dry-run approval

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-action --id=36 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --dry-run
```

Observed:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "operation": "listing_quality_seed_promoted_opportunity_action",
  "id": 36,
  "action": "approve_for_packet",
  "planned_decision": {
    "human_review_status": "approved_for_packet",
    "status": "reviewing",
    "reviewed_by": "operator",
    "review_reason": "approved for packet preview",
    "phase_14k_human_gate": true,
    "still_not_execution_candidate": true,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false
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
    "live_candidate_created": false,
    "marketplace_write_performed": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "ai_called": false
  },
  "safety": {
    "actual_database_write": false,
    "marketplace_write_performed": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "ai_called": false
  }
}
```

### Write approval

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-action --id=36 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --write
```

Observed:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "operation": "listing_quality_seed_promoted_opportunity_action",
  "id": 36,
  "action": "approve_for_packet",
  "updated_promoted_opportunity": {
    "id": 36,
    "status": "reviewing",
    "human_review_status": "approved_for_packet",
    "review_action": "approve_for_packet",
    "reviewed_by": "operator",
    "review_reason": "approved for packet preview",
    "phase_14k_human_gate": true,
    "still_not_execution_candidate": true,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false
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
    "live_candidate_created": false,
    "marketplace_write_performed": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "ai_called": false
  },
  "safety": {
    "actual_database_write": true,
    "database_write_scope": "opportunity_inbox metadata/status only",
    "marketplace_write_performed": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "ai_called": false
  }
}
```

### Detail after write

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-opportunity-detail --id=36
```

Observed after write:

```json
{
  "found": true,
  "promoted_opportunity": {
    "id": 36,
    "status": "reviewing",
    "human_review_status": "approved_for_packet",
    "review_action": "approve_for_packet",
    "reviewed_by": "operator",
    "review_reason": "approved for packet preview",
    "phase_14k_human_gate": true,
    "still_not_execution_candidate": true,
    "not_execution_candidate": true,
    "not_packet": true,
    "not_approval": true,
    "not_execution_request": true,
    "not_live_candidate": true,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false
  }
}
```

## Final Phase 14K state

```json
{
  "promoted_opportunity_id": 36,
  "source_review_id": 19,
  "item_id": "206288370789",
  "sku": "PMC-24141",
  "human_review_status": "approved_for_packet",
  "review_action": "approve_for_packet",
  "reviewed_by": "operator",
  "review_reason": "approved for packet preview",
  "phase_14k_human_gate": true,
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "not_packet": true,
  "not_approval": true,
  "not_execution_request": true,
  "not_live_candidate": true,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "marketplace_write_performed": false,
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
