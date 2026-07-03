# Hermes Phase 13L — Borderline Review Decision Gate

## Scope

Phase 13L adds a reader and internal decision gate for Phase 13K borderline listing-quality human-review records.

Baseline:

```text
3f4fff7 Add Phase 13K borderline human review inbox
```

Phase 13L does not redo Phase 13K. The six internal review records remain not `listing_quality_low` opportunities and remain not execution candidates.

## Hard boundary

Phase 13L is an internal reader / decision-gate phase only.

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

The only optional write is an internal update to the existing `opportunity_inbox` review row's `status`, `updated_at`, and `metadata` fields.

## CLI

List reviews:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-reviews --limit=20
```

Show one review detail:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-detail --id=<REVIEW_ID>
```

Dry-run a review decision:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=<REVIEW_ID> --action=shortlist --actor=<USER> --reason="..." --dry-run
```

Supported actions:

- `shortlist`
- `reject`

Optional internal write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=<REVIEW_ID> --action=shortlist --actor=<USER> --reason="..." --write
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
listEbayListingQualityBorderlineReviews({ limit })
getEbayListingQualityBorderlineReviewDetail({ id })
actOnEbayListingQualityBorderlineReview({ id, action, actor, reason, dryRun, write })
```

The decision helper validates that the target row is an internal borderline review row:

```text
opportunity_type = listing_quality_borderline_review
source_type = phase_13j_borderline_preview
```

In `--write` mode it updates only the internal review row with metadata such as:

```json
{
  "review_status": "shortlisted",
  "reviewed_by": "operator",
  "reviewed_at": "ISO8601",
  "review_reason": "candidate for manual review",
  "review_action": "shortlist",
  "still_not_execution_candidate": true,
  "not_listing_quality_low": true,
  "not_execution_candidate": true,
  "requires_human_review": true,
  "phase_13l_decision_gate": true
}
```

For `shortlist`, table `status` remains `reviewing` because this is still not an execution candidate. For `reject`, table `status` is set to `rejected`. No schema change was necessary because `opportunity_inbox.metadata` can safely store review decision fields.

## Review list validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-reviews --limit=20
```

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_review_list",
  "limit": 20,
  "count": 6
}
```

The six records were returned with these IDs:

```text
12, 11, 10, 9, 8, 7
```

Each record reports:

- `type=listing_quality_borderline_review`
- `source=phase_13j_borderline_preview`
- `not_listing_quality_low=true`
- `not_execution_candidate=true`
- `requires_human_review=true`

Safety output:

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

## Review detail validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-detail --id=7
```

Observed summary before the write decision:

```json
{
  "read_only": true,
  "operation": "listing_quality_borderline_review_detail",
  "id": 7,
  "found": true,
  "review": {
    "id": 7,
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "item_id": "206284142714",
    "score": 85,
    "detected_gaps": ["pictures_below_2"],
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  }
}
```

## Decision dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=7 --action=shortlist --actor=operator --reason="candidate for manual review" --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "operation": "listing_quality_borderline_review_action",
  "id": 7,
  "action": "shortlist",
  "planned_decision": {
    "review_status": "shortlisted",
    "status": "reviewing",
    "reviewed_by": "operator",
    "review_reason": "candidate for manual review",
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

Dry-run safety confirmed no DB write.

## Decision write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=7 --action=shortlist --actor=operator --reason="candidate for manual review" --write
```

Observed summary:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "operation": "listing_quality_borderline_review_action",
  "id": 7,
  "action": "shortlist",
  "updated_review": {
    "id": 7,
    "status": "reviewing",
    "review_status": "shortlisted",
    "reviewed_by": "operator",
    "review_reason": "candidate for manual review",
    "still_not_execution_candidate": true,
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
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

Write safety output:

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

A post-write detail read confirmed review `id=7` contains:

```json
{
  "review_status": "shortlisted",
  "reviewed_by": "operator",
  "review_reason": "candidate for manual review",
  "still_not_execution_candidate": true,
  "phase_13l_decision_gate": true
}
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

The decision gate did not convert the shortlisted review into an execution candidate.

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-reviews --limit=20
npm run hermes:agent -- ebay-listing-quality-borderline-review-detail --id=7
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=7 --action=shortlist --actor=operator --reason="candidate for manual review" --dry-run
npm run hermes:agent -- ebay-listing-quality-borderline-review-action --id=7 --action=shortlist --actor=operator --reason="candidate for manual review" --write
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- normal opportunity creation
- packet creation
- approval creation
- execution-state mutation

The Phase 13L diff adds no eBay call, no marketplace write path, no normal opportunity creation path, no packet creation path, no approval creation path, and no execution-state mutation path. It adds only an intentional `.update()` path on `opportunity_inbox`, guarded by explicit `--write`, constrained to `opportunity_type=listing_quality_borderline_review` and `source_type=phase_13j_borderline_preview`.

Historical shared-service write helpers remain present from previous phases, but Phase 13L does not invoke them.

## Schema note

No schema change was necessary. `opportunity_inbox.metadata` can store review decision fields safely for this phase.

If later phases need querying/reporting by review decision at scale, a safe migration could add generated or explicit nullable columns such as:

- `review_status`
- `reviewed_by_text`
- `reviewed_at`
- `review_reason`

That migration is not required for Phase 13L.

## Final Phase 13L state

```json
{
  "borderline_review_reader_added": true,
  "borderline_review_detail_added": true,
  "borderline_review_decision_gate_added": true,
  "review_7_status": "shortlisted",
  "review_7_still_not_execution_candidate": true,
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
