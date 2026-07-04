# Phase 14H Seed Promotion Eligibility

## Purpose

Phase 14H adds a read-only promotion eligibility checker for shortlisted Phase 14F/14G seed review records.

It determines whether an internal seed review record can later be promoted into a safe internal listing-quality opportunity. Phase 14H does not perform that promotion.

## Commands

Check one shortlisted seed review:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=<REVIEW_ID>
```

Scan seed review records for promotion candidates:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-candidates --limit=20
```

Related read-only review commands:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=<REVIEW_ID>
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
```

## Source rows

The checker only reads Phase 14F/14G seed review rows:

```text
opportunity_type = listing_quality_seed_review
source_type = phase_14e_seed_scoring_preview
```

A row can be eligible only when:

```json
{
  "metadata.review_status": "shortlisted"
}
```

## Eligibility rules

A seed review is eligible for a later promotion phase only if all of these are true:

- review exists;
- `review_status = shortlisted`;
- hard exclusion check is not excluded;
- item id is present;
- SKU is present;
- score is present;
- cached listing evidence exists;
- cached listing appears active or sufficiently reviewable;
- proposed mutation fields are non-empty;
- proposed mutation fields contain only:
  - `title`
  - `description`
  - `item_specifics`
- proposed mutation fields do not contain:
  - `price`
  - `inventory`
  - `quantity`
  - `images`
  - `shipping`
  - `category`
- no previous `marketplace_execution_completed` event exists for the item;
- no existing packet, approval, execution request, live candidate, or promoted opportunity exists for the same review/item;
- enough cached evidence exists for rollback/review.

Enough cached evidence means:

- cached `listing_details` exists;
- cached title exists;
- if `description` is proposed, cached description must be present;
- if `item_specifics` is proposed, cached item specifics evidence must be present.

## Hard exclusions

Phase 14H never marks eligible:

- `item_id=202551129453`
- `item_id=206315990948`
- `approval_id=15`
- `request_id=4`
- `packet_id=3`
- any item already completed by a `marketplace_execution_completed` event

## Safety boundary

Phase 14H is read-only.

It guarantees:

- no database writes;
- no eBay live calls;
- no `GetItem` calls;
- no `ReviseFixedPriceItem` calls;
- no marketplace writes;
- no price/inventory/quantity changes;
- no title/description/item_specifics mutations;
- no packet creation;
- no approval creation;
- no execution request creation;
- no live candidate creation;
- no opportunity creation;
- no AI calls.

The checker returns safety flags equivalent to:

```json
{
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "ai_called": false
}
```

## Validation result for review_id=19

Selected Phase 14G shortlisted review:

```text
review_id=19
sku=PMC-24141
item_id=206288370789
score=100
```

Detail command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=19
```

Observed:

- found=true;
- review_status=shortlisted;
- sku=PMC-24141;
- item_id=206288370789;
- score=100;
- hard_exclusion.excluded=false;
- safety flags show no database write, no marketplace write, no eBay call, no GetItem, no ReviseFixedPriceItem, no packet/approval/execution request/live candidate creation, no listing mutation, and no AI call.

Promotion check command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=19
```

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_seed_promotion_check",
  "review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "score": 100,
  "review_status": "shortlisted",
  "eligible_for_promotion": false,
  "blockers": [
    "insufficient_cached_evidence_for_rollback_review"
  ],
  "warnings": [
    "source_review_evidence_gap:cached_description"
  ],
  "allowed_mutation_fields": [
    "description",
    "item_specifics",
    "title"
  ],
  "forbidden_mutation_fields": [],
  "enough_cached_evidence_for_rollback_review": false
}
```

Cached evidence observed for review `19`:

```json
{
  "cached_listing_evidence_exists": true,
  "source_tables": [
    "ebay_products",
    "listing_details",
    "listing_item_specifics",
    "listing_images",
    "listing_policies"
  ],
  "description_present": false,
  "listing_status": "active",
  "listing_status_active": true,
  "sufficiently_reviewable": true,
  "limitations": [
    "cached_description_missing"
  ]
}
```

Conclusion: review `19` is not eligible in Phase 14H because the proposed mutation fields include `description`, but cached description evidence is missing. No promotion or downstream artifact was created.

## Candidate scan result

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-candidates --limit=20
```

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_seed_promotion_candidates",
  "scanned_count": 20,
  "shortlisted_count": 1,
  "eligible_promotion_count": 0,
  "eligible_promotion_candidates": [],
  "recommended_next_review_id": null,
  "blockers_by_type": {
    "insufficient_cached_evidence_for_rollback_review": 20,
    "review_status_not_shortlisted": 19
  }
}
```

Ineligible shortlisted review:

```json
{
  "review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "eligible_for_promotion": false,
  "blockers": [
    "insufficient_cached_evidence_for_rollback_review"
  ],
  "warnings": [
    "source_review_evidence_gap:cached_description"
  ]
}
```

No eligible promotion candidate was found. No opportunity, packet, approval, execution request, live candidate, database write, AI call, or marketplace write was created.

## Validation commands run

Non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=19
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=19
npm run hermes:agent -- ebay-listing-quality-seed-promotion-candidates --limit=20
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
git diff --stat
```

Results:

- syntax checks passed;
- review detail confirmed review `19` is shortlisted;
- promotion check returned `eligible_for_promotion=false` due to missing cached description evidence for rollback/review;
- candidate scan returned scanned_count=20, shortlisted_count=1, eligible_promotion_count=0;
- review list remained read-only and returned 20 review rows;
- no write or external side effect was performed.
