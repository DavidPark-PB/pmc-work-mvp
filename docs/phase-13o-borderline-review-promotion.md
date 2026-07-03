# Hermes Phase 13O — Borderline Review Promotion

## Scope

Phase 13O promotes an eligible shortlisted borderline listing-quality review into one normal internal human-review opportunity.

Baseline:

```text
0c7b4e2 Add Phase 13N shortlist allowed borderline review
```

Phase 13O does not redo Phase 13N. Review `id=9` was already shortlisted and promotion eligibility returned `eligible_for_promotion=true`.

## Starting state

- Borderline review `id=9` is shortlisted.
- Review `id=9` targets item `206315990948`.
- `proposed_mutation_fields=["item_specifics"]`.
- `allowed_mutation_fields=["item_specifics"]`.
- No normal opportunity, packet, approval, execution-state mutation, or marketplace write had occurred for this promoted review.

## Hard boundary

Phase 13O creates only a normal internal opportunity for human review when explicitly run with `--write`.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- create packets
- create approvals / execution requests
- update execution state
- mark marketplace execution
- modify marketplace listings
- change price, inventory, quantity, or listing content
- push commits

## CLI

Dry-run is the default:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --dry-run
```

Write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --write
```

Repeat write is idempotent:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --write
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helper:

```js
promoteEbayListingQualityBorderlineReview({ id, dryRun, write })
```

Added CLI:

```text
ebay-listing-quality-promote-borderline-review --id=<REVIEW_ID> [--dry-run|--write]
```

The command defaults to dry-run unless `--write` is supplied.

## Promotion record

The promoted normal internal opportunity is inserted into `opportunity_inbox` only when:

- the Phase 13M eligibility check passes
- review is shortlisted
- proposed mutation fields are allowed
- no promoted opportunity already exists for the source review
- `--write` is explicitly supplied

Inserted row shape:

```json
{
  "opportunity_type": "listing_quality_improvement",
  "source_type": "phase_13_borderline_review_promotion",
  "input_channel": "api",
  "source_name": "phase_13o_borderline_review_promotion",
  "status": "reviewing",
  "category": "ebay_listing_quality",
  "priority": "normal",
  "metadata": {
    "type": "listing_quality_improvement",
    "source": "phase_13_borderline_review_promotion",
    "phase": "13O",
    "source_review_id": 9,
    "item_id": "206315990948",
    "target_item_id": "206315990948",
    "sku": "206315990948",
    "not_listing_quality_low": true,
    "requires_human_review": true,
    "requires_human_approval": true,
    "not_execution_candidate": true,
    "proposed_mutation_fields": ["item_specifics"],
    "allowed_mutation_fields": ["item_specifics"],
    "forbidden_field_check": {
      "price_changes": false,
      "inventory_changes": false,
      "quantity_changes": false
    }
  }
}
```

This is not a packet, approval, execution request, or marketplace write.

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "operation": "listing_quality_promote_borderline_review",
  "id": 9,
  "eligible_for_promotion": true,
  "blockers": [],
  "created": false,
  "idempotent_existing": false,
  "promoted_opportunity_id": null,
  "existing_promoted_opportunity_count_before": 0,
  "promoted_opportunity_count_after": 0,
  "verification": {
    "normal_opportunity_created": false,
    "packet_count_before": 1,
    "packet_count_after": 1,
    "packet_created": false,
    "approval_request_count_before": 2,
    "approval_request_count_after": 2,
    "approval_created": false,
    "execution_state_updated": false
  }
}
```

Dry-run safety confirmed `actual_database_write=false`.

## Write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --write
```

Observed summary:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "operation": "listing_quality_promote_borderline_review",
  "id": 9,
  "eligible_for_promotion": true,
  "blockers": [],
  "created": true,
  "idempotent_existing": false,
  "promoted_opportunity_id": 13,
  "existing_promoted_opportunity_count_before": 0,
  "promoted_opportunity_count_after": 1,
  "verification": {
    "exactly_one_promoted_opportunity_for_review": true,
    "promoted_opportunity_count_before": 0,
    "promoted_opportunity_count_after": 1,
    "duplicate_created": false,
    "normal_opportunity_created": true,
    "created_exactly_one_normal_internal_opportunity": true,
    "packet_count_before": 1,
    "packet_count_after": 1,
    "packet_created": false,
    "approval_request_count_before": 2,
    "approval_request_count_after": 2,
    "approval_created": false,
    "execution_state_updated": false
  }
}
```

Promoted opportunity:

```json
{
  "id": 13,
  "opportunity_type": "listing_quality_improvement",
  "source": "phase_13_borderline_review_promotion",
  "status": "reviewing",
  "title": "Pokemon Store Korea Official Jeju Edition RANDOM Magnet",
  "item_id": "206315990948",
  "sku": "206315990948",
  "source_review_id": 9,
  "not_listing_quality_low": true,
  "requires_human_approval": true,
  "not_execution_candidate": true,
  "proposed_mutation_fields": ["item_specifics"],
  "allowed_mutation_fields": ["item_specifics"]
}
```

Write safety output confirmed:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": true,
  "database_write_scope": "opportunity_inbox normal internal human-review opportunity only",
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "normal_opportunity_created": true,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "listing_changed": false
}
```

## Idempotency validation

Command repeated:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --write
```

Observed summary:

```json
{
  "created": false,
  "idempotent_existing": true,
  "promoted_opportunity_id": 13,
  "existing_promoted_opportunity_count_before": 1,
  "promoted_opportunity_count_after": 1,
  "verification": {
    "exactly_one_promoted_opportunity_for_review": true,
    "duplicate_created": false,
    "normal_opportunity_created": false,
    "packet_count_before": 1,
    "packet_count_after": 1,
    "packet_created": false,
    "approval_request_count_before": 2,
    "approval_request_count_after": 2,
    "approval_created": false,
    "execution_state_updated": false
  }
}
```

The repeat write returned existing promoted opportunity `id=13` and did not create a duplicate.

## Next-candidate selector validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed result remains safe:

```json
{
  "scanned": {
    "opportunity_count": 13,
    "completed_marketplace_item_ids": ["202551129453"]
  },
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

The promoted opportunity is not treated as executable. A later explicit packet/approval phase is required before any execution path.

## Validation commands

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --dry-run
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --write
npm run hermes:agent -- ebay-listing-quality-promote-borderline-review --id=9 --write
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
git diff --stat
```

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- packet creation
- approval creation
- execution-state mutation

The Phase 13O service diff adds only:

- read-only eligibility checks
- existing promoted-opportunity lookup
- one guarded `.insert()` into `opportunity_inbox` for the normal internal human-review opportunity
- no eBay call
- no `GetItem` call
- no `ReviseFixedPriceItem` call
- no marketplace write path
- no packet creation path
- no approval / execution request creation path
- no execution-state mutation path

Historical shared-service write helpers remain present from previous phases, but Phase 13O does not invoke packet, approval, execution, or marketplace write helpers.

## Final Phase 13O state

```json
{
  "review_9_shortlisted": true,
  "review_9_eligible_for_promotion": true,
  "promoted_opportunity_id": 13,
  "promoted_opportunity_count_for_review_9": 1,
  "promotion_idempotent": true,
  "source_review_id": 9,
  "source": "phase_13_borderline_review_promotion",
  "opportunity_type": "listing_quality_improvement",
  "not_listing_quality_low": true,
  "requires_human_approval": true,
  "not_execution_candidate": true,
  "target_item_id": "206315990948",
  "proposed_mutation_fields": ["item_specifics"],
  "allowed_mutation_fields": ["item_specifics"],
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "price_changes": false,
  "inventory_changes": false,
  "listing_changed": false,
  "selected_execution_candidate": null
}
```
