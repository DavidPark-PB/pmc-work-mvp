# Hermes Phase 13K — Borderline Human Review Inbox

## Scope

Phase 13K creates an internal human-review inbox path for the Phase 13J borderline listing-quality improvement candidates.

Baseline:

```text
4d0be5d Add Phase 13J borderline improvement preview
```

Phase 13K does not redo Phase 13J. The records created here are not `listing_quality_low` opportunities and are not execution candidates.

## Hard boundary

Phase 13K allows only an optional internal review-record write.

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

Dry-run is the default behavior:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-inbox --limit=20 --dry-run
```

Optional internal write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-inbox --limit=20 --write
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helper:

```js
writeEbayListingQualityBorderlineInbox({ limit, dryRun, write })
```

The helper:

1. Reuses Phase 13J cached-evidence-only borderline preview.
2. Plans internal review records for each eligible borderline candidate.
3. In dry-run mode, writes nothing.
4. In `--write` mode, inserts only internal human-review records into `opportunity_inbox` with a special non-execution type.
5. Verifies internal review records exist and packet / approval / listing-quality-low opportunity counts did not increase.

## Internal review record markers

Each inserted review record is marked:

```json
{
  "opportunity_type": "listing_quality_borderline_review",
  "source_type": "phase_13j_borderline_preview",
  "metadata": {
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  }
}
```

The record metadata includes:

- `item_id`
- `sku`
- `title`
- `score`
- `detected_gaps`
- `borderline_gaps`
- `proposed_mutation_fields`
- `evidence_source`
- `risk_level`
- `why_not_listing_quality_low`
- `recommended_next_action`
- `rank`
- `phase: 13K`

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-inbox --limit=20 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "operation": "listing_quality_borderline_human_review_inbox",
  "preview_candidate_count": 6,
  "existing_review_record_count_before": 0,
  "records_to_insert_count": 6,
  "inserted_count": 0,
  "verification": {
    "internal_review_records_exist": false,
    "matching_review_record_count": 0,
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

Dry-run safety output confirmed:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
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

## Write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-inbox --limit=20 --write
```

Observed summary:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "operation": "listing_quality_borderline_human_review_inbox",
  "preview_candidate_count": 6,
  "existing_review_record_count_before": 0,
  "records_to_insert_count": 6,
  "inserted_count": 6,
  "verification": {
    "internal_review_records_exist": true,
    "matching_review_record_count": 6,
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

Inserted internal review records:

```json
[
  {
    "id": 7,
    "item_id": "206284142714",
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  },
  {
    "id": 8,
    "item_id": "206286078077",
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  },
  {
    "id": 9,
    "item_id": "206315990948",
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  },
  {
    "id": 10,
    "item_id": "206332929888",
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  },
  {
    "id": 11,
    "item_id": "206371786121",
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  },
  {
    "id": 12,
    "item_id": "206387679082",
    "type": "listing_quality_borderline_review",
    "source": "phase_13j_borderline_preview",
    "status": "reviewing",
    "not_listing_quality_low": true,
    "not_execution_candidate": true,
    "requires_human_review": true
  }
]
```

Write safety output confirmed:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": true,
  "database_write_scope": "opportunity_inbox internal review records only",
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
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

The only database write was the internal review-record insert. No marketplace write or execution mutation occurred.

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

The selector's `opportunity_count` increased from the internal review rows, but no execution candidate was selected because these records are typed as `listing_quality_borderline_review`, marked `not_listing_quality_low`, and not converted into execution requests.

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-inbox --limit=20 --dry-run
npm run hermes:agent -- ebay-listing-quality-borderline-inbox --limit=20 --write
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- packet creation
- approval creation
- execution-state mutation

The Phase 13K diff adds no eBay call, no marketplace write path, no packet creation path, no approval creation path, and no execution-state mutation path. It does add an intentional `opportunity_inbox` `.insert()` path that is only reached by explicit `--write` and only writes internal review records with `not_listing_quality_low=true`, `not_execution_candidate=true`, and `requires_human_review=true`.

Historical shared-service write helpers remain present from previous phases, but Phase 13K does not invoke them.

## Final Phase 13K state

```json
{
  "borderline_human_review_inbox_added": true,
  "internal_review_records_inserted": 6,
  "internal_review_records_exist": true,
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
