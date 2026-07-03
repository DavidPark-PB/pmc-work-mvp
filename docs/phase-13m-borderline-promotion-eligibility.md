# Hermes Phase 13M — Borderline Promotion Eligibility

## Scope

Phase 13M adds a read-only eligibility check for promoting shortlisted borderline listing-quality human-review records into a future safe internal opportunity.

Baseline:

```text
8178027 Add Phase 13L borderline review decision gate
```

Phase 13M does not redo Phase 13L. It does not create a normal opportunity yet.

## Hard boundary

Phase 13M is read-only.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- create normal opportunities
- create `listing_quality_low` opportunities
- create packets
- create approvals / execution requests
- update execution state
- mark marketplace execution
- modify marketplace listings
- change price, inventory, quantity, or listing content
- push commits

## CLI

Check one review:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-check --id=7
```

Scan all review records:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-candidates --limit=20
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added helpers:

```js
checkEbayListingQualityBorderlinePromotionEligibility({ id })
scanEbayListingQualityBorderlinePromotionCandidates({ limit })
```

The checker reads the Phase 13K/13L internal review record, reads cached listing evidence only, and evaluates promotion eligibility. It does not write anything.

## Eligibility rules

A review can be eligible for future promotion only if all of these are true:

- `review_status = shortlisted`
- `requires_human_review = true`
- `not_execution_candidate = true`
- cached eBay listing is active
- `item_id != 202551129453`
- no previous `marketplace_execution_completed` event exists for the item
- `proposed_mutation_fields` is non-empty
- `proposed_mutation_fields` contains only:
  - `title`
  - `description`
  - `item_specifics`
- no price / inventory / quantity fields are present
- enough cached evidence exists for rollback/review

Enough cached evidence means the record has cached title/evidence, cached `listing_details`, and field-specific supporting evidence where applicable. For `item_specifics`, cached `listing_item_specifics` must be present. For `description`, cached description text must be present.

## Review id=7 validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-check --id=7
```

Observed result:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_promotion_check",
  "id": 7,
  "eligible_for_promotion": false,
  "blockers": ["no_allowed_mutation_fields"],
  "opportunity_created": false,
  "recommended_next_review_id": 9
}
```

Review 7 details:

```json
{
  "review_id": 7,
  "item_id": "206284142714",
  "score": 85,
  "review_status": "shortlisted",
  "requires_human_review": true,
  "not_execution_candidate": true,
  "still_not_execution_candidate": true,
  "listing_status_active": true,
  "proposed_mutation_fields": [],
  "allowed_mutation_fields": [],
  "detected_gaps": ["pictures_below_2"],
  "previous_marketplace_execution_completed": false,
  "enough_cached_evidence_for_rollback_review": true,
  "eligible_for_promotion": false,
  "blockers": ["no_allowed_mutation_fields"]
}
```

This is the expected Phase 13M result for review `id=7`: it is shortlisted, active, safe, and backed by cached evidence, but it has no allowed mutation fields because the only gap is `pictures_below_2`. Image changes are not part of the allowed Phase 13M promotion fields.

Recommended alternate review:

```json
{
  "review_id": 9,
  "item_id": "206315990948",
  "proposed_mutation_fields": ["item_specifics"],
  "allowed_mutation_fields": ["item_specifics"],
  "blockers": ["review_status_not_shortlisted"]
}
```

Review 9 has allowed mutation fields and may be a better next human-review/shortlist candidate, but it is not promoted in Phase 13M.

## Candidate scan validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-candidates --limit=20
```

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_promotion_candidates",
  "limit": 20,
  "scanned_count": 6,
  "eligible_promotion_count": 0,
  "eligible_promotion_candidates": [],
  "recommended_next_review_id": 9,
  "opportunity_created": false
}
```

Ineligible shortlisted records:

```json
[
  {
    "review_id": 7,
    "item_id": "206284142714",
    "review_status": "shortlisted",
    "listing_status_active": true,
    "proposed_mutation_fields": [],
    "allowed_mutation_fields": [],
    "eligible_for_promotion": false,
    "blockers": ["no_allowed_mutation_fields"]
  }
]
```

Review records with allowed mutation fields:

```json
[
  {
    "review_id": 9,
    "item_id": "206315990948",
    "proposed_mutation_fields": ["item_specifics"],
    "allowed_mutation_fields": ["item_specifics"],
    "eligible_for_promotion": false,
    "blockers": ["review_status_not_shortlisted"]
  },
  {
    "review_id": 8,
    "item_id": "206286078077",
    "proposed_mutation_fields": ["item_specifics"],
    "allowed_mutation_fields": ["item_specifics"],
    "eligible_for_promotion": false,
    "blockers": ["review_status_not_shortlisted"]
  }
]
```

No review was promoted. No normal opportunity was created.

## Next-candidate selector validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed result remains safe:

```json
{
  "ranked_candidates": [],
  "selected_candidate": null,
  "completed_marketplace_item_ids": ["202551129453"],
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

The promotion eligibility check did not create an execution candidate.

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-check --id=7
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-candidates --limit=20
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Safety output

Promotion check and scan return safety flags equivalent to:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "normal_opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "listing_changed": false
}
```

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- normal opportunity creation
- DB writes
- packet creation
- approval creation
- execution-state mutation

The Phase 13M diff adds no eBay call, no marketplace write path, no DB write path, no normal opportunity creation path, no packet creation path, no approval creation path, and no execution-state mutation path.

Historical shared-service write helpers remain present from previous phases, but Phase 13M does not invoke them.

## Final Phase 13M state

```json
{
  "promotion_eligibility_check_added": true,
  "promotion_candidate_scan_added": true,
  "review_7_eligible_for_promotion": false,
  "review_7_blockers": ["no_allowed_mutation_fields"],
  "eligible_promotion_count": 0,
  "recommended_next_review_id": 9,
  "listing_quality_low_opportunities_created": 0,
  "normal_opportunity_created": false,
  "selected_execution_candidate": null,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "price_changes": false,
  "inventory_changes": false,
  "listing_changed": false,
  "phase_12_item_reused": false
}
```
