# Hermes Phase 14J — Seed Review Promotion

## Purpose

Phase 14J promotes one eligible Phase 14 seed review into one normal internal listing-quality opportunity for human review.

This phase is still not a packet, not an approval, not an execution request, not a live candidate, and not a marketplace/live action.

Baseline:

```text
134119e Add Phase 14I seed evidence completion
```

Phase 14J does not redo Phase 14A through Phase 14I.

## Target

```json
{
  "review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "score": 100,
  "phase_14h_eligible_for_promotion_before_write": true,
  "blockers_before_write": [],
  "warnings_before_write": [],
  "cached_description_present": true,
  "allowed_mutation_fields": ["description", "item_specifics", "title"]
}
```

## CLI

Dry-run is the default:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=19 --dry-run
```

Write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=19 --write
```

Repeat write is idempotent:

```bash
npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=19 --write
```

## Promotion gates

The command:

- loads the Phase 14F/14G seed review by id
- verifies `review_status="shortlisted"`
- reuses the Phase 14H promotion eligibility check
- requires the review to be eligible before first creation
- verifies no blockers before first creation
- verifies `hard_exclusion.excluded=false`
- checks for an existing promoted opportunity with the deterministic key
- defaults to dry-run unless `--write` is explicitly supplied

The deterministic idempotency key is based on:

```json
{
  "source_type": "phase_14_seed_review_promotion",
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789"
}
```

If that promoted opportunity already exists, repeat `--write` returns the existing opportunity with `created=false` and `idempotent_existing=true`; no duplicate is inserted.

## Promoted opportunity shape

When `--write` is used and no existing promoted opportunity exists, Phase 14J inserts exactly one row into `opportunity_inbox`:

```json
{
  "opportunity_type": "listing_quality_improvement",
  "source_type": "phase_14_seed_review_promotion",
  "input_channel": "api",
  "source_name": "phase_14j_seed_review_promotion",
  "status": "reviewing",
  "category": "ebay_listing_quality",
  "priority": "normal",
  "metadata": {
    "type": "listing_quality_improvement",
    "source": "phase_14_seed_review_promotion",
    "phase": "14J",
    "source_review_id": 19,
    "sku": "PMC-24141",
    "item_id": "206288370789",
    "target_item_id": "206288370789",
    "score": 100,
    "requires_human_review": true,
    "requires_human_approval": true,
    "not_execution_candidate": true,
    "not_packet": true,
    "not_approval": true,
    "not_execution_request": true,
    "not_live_candidate": true,
    "proposed_mutation_fields": ["description", "item_specifics", "title"],
    "allowed_mutation_fields": ["description", "item_specifics", "title"],
    "forbidden_field_check": {
      "price_changes": false,
      "inventory_changes": false,
      "quantity_changes": false,
      "forbidden_fields_present": false,
      "forbidden_fields": []
    }
  }
}
```

## Hard exclusions

Phase 14J does not promote hard-excluded records/items:

- `item_id=202551129453`
- `item_id=206315990948`
- `approval_id=15`
- `request_id=4`
- `packet_id=3`
- any item with a `marketplace_execution_completed` event

## Safety guarantees

Phase 14J does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call eBay write APIs
- write to marketplaces
- mutate listings
- change price, inventory, quantity, title, description, or item specifics
- create packets
- create approvals
- create execution requests
- create live candidates
- call AI
- push commits

The only write in this phase is one internal `opportunity_inbox` human-review opportunity row, and only when `--write` is explicitly supplied.

## Validation results

Required non-piped validations were run.

### Syntax

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### Source review detail

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=19
```

Observed:

```json
{
  "found": true,
  "review_status": "shortlisted",
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "score": 100,
  "hard_exclusion": { "excluded": false }
}
```

### Phase 14H promotion check before write

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=19
```

Observed before Phase 14J write:

```json
{
  "eligible_for_promotion": true,
  "blockers": [],
  "warnings": [],
  "cached_evidence": {
    "description_present": true,
    "item_specifics_count": 2,
    "images_count": 1,
    "listing_status_active": true,
    "ebay_api_call_made": false
  },
  "existing_artifacts": {
    "opportunities": [],
    "packets": [],
    "requests": []
  }
}
```

### Dry-run promotion

```bash
npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=19 --dry-run
```

Observed:

```json
{
  "operation": "listing_quality_promote_seed_review",
  "review_id": 19,
  "eligible_for_promotion": true,
  "created": false,
  "idempotent_existing": false,
  "promoted_opportunity_id": null,
  "blockers": [],
  "verification": {
    "duplicate_created": false,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "ai_called": false
  }
}
```

### Write promotion

```bash
npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=19 --write
```

Observed:

```json
{
  "operation": "listing_quality_promote_seed_review",
  "review_id": 19,
  "eligible_for_promotion": true,
  "created": true,
  "idempotent_existing": false,
  "promoted_opportunity_id": 36,
  "blockers": [],
  "verification": {
    "exactly_one_promoted_opportunity_for_review": true,
    "duplicate_created": false,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "ai_called": false
  }
}
```

### Repeat write idempotency

```bash
npm run hermes:agent -- ebay-listing-quality-promote-seed-review --id=19 --write
```

Observed:

```json
{
  "created": false,
  "idempotent_existing": true,
  "promoted_opportunity_id": 36,
  "existing_promoted_opportunity_count_before": 1,
  "promoted_opportunity_count_after": 1,
  "verification": {
    "exactly_one_promoted_opportunity_for_review": true,
    "duplicate_created": false,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "live_candidate_created": false,
    "marketplace_write_performed": false,
    "listing_changed": false,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "ai_called": false
  }
}
```

### Candidate scan after promotion

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-candidates --limit=20
```

Observed after Phase 14J write:

```json
{
  "scanned_count": 20,
  "shortlisted_count": 1,
  "eligible_promotion_count": 0,
  "ineligible_shortlisted_reviews": [
    {
      "review_id": 19,
      "eligible_for_promotion": false,
      "blockers": ["existing_opportunity_for_review_or_item"],
      "existing_artifacts": {
        "opportunities": [
          {
            "id": 36,
            "opportunity_type": "listing_quality_improvement",
            "source_type": "phase_14_seed_review_promotion",
            "status": "reviewing"
          }
        ],
        "packets": [],
        "requests": []
      }
    }
  ]
}
```

This confirms the seed review is no longer eligible for another promotion because the promoted opportunity already exists.

## Final Phase 14J state

```json
{
  "review_19_shortlisted": true,
  "promoted_opportunity_id": 36,
  "promoted_opportunity_count_for_review_19": 1,
  "promotion_idempotent": true,
  "source_type": "phase_14_seed_review_promotion",
  "opportunity_type": "listing_quality_improvement",
  "status": "reviewing",
  "requires_human_review": true,
  "requires_human_approval": true,
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
