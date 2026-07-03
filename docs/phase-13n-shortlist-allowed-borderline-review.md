# Hermes Phase 13N — Shortlist Allowed Borderline Review

## Scope

Phase 13N shortlists the Phase 13M-recommended borderline review with an allowed mutation field and verifies promotion eligibility.

Baseline:

```text
c923f28 Add Phase 13M borderline promotion eligibility
```

Phase 13N does not redo Phase 13M. It does not create a normal opportunity yet.

## Starting state

- Review `id=7` is shortlisted but cannot be promoted because it has no allowed mutation fields.
- Review `id=9` was recommended by Phase 13M because it has `item_specifics` in `proposed_mutation_fields`.
- Review `id=9` was not shortlisted before this phase.
- No normal opportunity, packet, approval, execution-state mutation, or marketplace write had occurred.

## Hard boundary

Phase 13N allows only an internal review decision update for review `id=9` using the existing Phase 13L decision gate.

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

## Commands run

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Review detail:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-detail --id=9
```

Dry-run shortlist:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=9 --action=shortlist --actor=operator --reason="allowed item_specifics improvement candidate" --dry-run
```

Write shortlist:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=9 --action=shortlist --actor=operator --reason="allowed item_specifics improvement candidate" --write
```

Promotion check:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-check --id=9
```

Promotion candidate scan:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-candidates --limit=20
```

Next-candidate selector:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Review id=9 detail before shortlist

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_review_detail",
  "id": 9,
  "found": true,
  "review": {
    "id": 9,
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "item_id": "206315990948",
    "title": "Pokemon Store Korea Official Jeju Edition RANDOM Magnet",
    "score": 85,
    "detected_gaps": ["item_specifics_below_5"],
    "proposed_mutation_fields": ["item_specifics"],
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true,
    "review_status": null
  }
}
```

Safety flags confirmed no eBay call, no DB write, no normal opportunity, no packet, no approval, and no execution-state mutation.

## Dry-run shortlist result

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "operation": "listing_quality_borderline_review_action",
  "id": 9,
  "action": "shortlist",
  "planned_decision": {
    "review_status": "shortlisted",
    "status": "reviewing",
    "reviewed_by": "operator",
    "review_reason": "allowed item_specifics improvement candidate",
    "still_not_execution_candidate": true
  },
  "updated_review": null,
  "verification": {
    "normal_listing_quality_low_opportunity_count_before": 0,
    "normal_listing_quality_low_opportunity_count_after": 0,
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

## Write shortlist result

Observed summary:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "operation": "listing_quality_borderline_review_action",
  "id": 9,
  "action": "shortlist",
  "updated_review": {
    "id": 9,
    "status": "reviewing",
    "review_status": "shortlisted",
    "reviewed_by": "operator",
    "review_reason": "allowed item_specifics improvement candidate",
    "still_not_execution_candidate": true,
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true,
    "proposed_mutation_fields": ["item_specifics"]
  },
  "verification": {
    "normal_listing_quality_low_opportunity_count_before": 0,
    "normal_listing_quality_low_opportunity_count_after": 0,
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

Write safety output confirmed:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": true,
  "database_write_scope": "opportunity_inbox internal review metadata/status only",
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

The only DB write was the existing internal review metadata/status update on `opportunity_inbox`.

## Promotion check for id=9

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-check --id=9
```

Observed result:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_promotion_check",
  "id": 9,
  "eligible_for_promotion": true,
  "blockers": [],
  "opportunity_created": false
}
```

Assessment details:

```json
{
  "review_id": 9,
  "item_id": "206315990948",
  "title": "Pokemon Store Korea Official Jeju Edition RANDOM Magnet",
  "score": 85,
  "review_status": "shortlisted",
  "requires_human_review": true,
  "not_execution_candidate": true,
  "still_not_execution_candidate": true,
  "listing_status_active": true,
  "proposed_mutation_fields": ["item_specifics"],
  "allowed_mutation_fields": ["item_specifics"],
  "detected_gaps": ["item_specifics_below_5"],
  "previous_marketplace_execution_completed": false,
  "enough_cached_evidence_for_rollback_review": true,
  "eligible_for_promotion": true,
  "blockers": []
}
```

The eligibility check also confirmed:

- no forbidden fields
- no price changes
- no inventory changes
- no quantity changes
- no marketplace execution completion event for the item
- cached evidence source includes `listing_details` and `listing_item_specifics`

No normal opportunity was created.

## Promotion candidate scan

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-promotion-candidates --limit=20
```

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_promotion_candidates",
  "scanned_count": 6,
  "eligible_promotion_count": 1,
  "recommended_next_review_id": 9,
  "opportunity_created": false
}
```

Eligible promotion candidates:

```json
[
  {
    "review_id": 9,
    "item_id": "206315990948",
    "review_status": "shortlisted",
    "proposed_mutation_fields": ["item_specifics"],
    "allowed_mutation_fields": ["item_specifics"],
    "eligible_for_promotion": true,
    "blockers": []
  }
]
```

Ineligible shortlisted records still include review `id=7`:

```json
[
  {
    "review_id": 7,
    "item_id": "206284142714",
    "review_status": "shortlisted",
    "proposed_mutation_fields": [],
    "eligible_for_promotion": false,
    "blockers": ["no_allowed_mutation_fields"]
  }
]
```

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

Shortlisting review `id=9` and verifying promotion eligibility did not create an execution candidate.

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- normal opportunity creation
- packet creation
- approval creation
- execution-state mutation

Phase 13N introduced no service/CLI code changes. The only repository change is this documentation file. Runtime validation confirmed the only write was the internal review metadata/status update already implemented in Phase 13L.

## Final Phase 13N state

```json
{
  "review_9_shortlisted": true,
  "review_9_eligible_for_promotion": true,
  "review_9_allowed_mutation_fields": ["item_specifics"],
  "review_7_eligible_for_promotion": false,
  "review_7_blockers": ["no_allowed_mutation_fields"],
  "eligible_promotion_count": 1,
  "recommended_next_review_id": 9,
  "normal_opportunity_created": false,
  "listing_quality_low_opportunities_created": 0,
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
