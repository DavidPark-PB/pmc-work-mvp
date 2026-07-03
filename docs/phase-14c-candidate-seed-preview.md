# Phase 14C Candidate Seed Preview

Status: implemented
Scope: read-only deterministic candidate seed preview from internal catalog/listing data

## Command

```bash
npm run hermes:agent -- ebay-listing-quality-candidate-seed-preview --limit=100
```

## Purpose

Phase 14C adds a preview-only seed scan so Phase 14 can inspect fresh listing-quality seed rows without reusing already executed items and without creating opportunities.

Phase 14C does not redo Phase 14A or Phase 14B. It builds on the Phase 14A/14B exclusion posture and remains read-only.

## Hard safety boundary

Phase 14C must not:

- execute eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- write database rows
- create opportunities
- create packets
- create approvals
- create execution requests
- create live candidates
- change execution state
- call AI
- push commits

## Internal/local sources only

The preview reads only internal/local data already available to the app:

- cached product/listing rows
- cached listing evidence tables
- opportunity/request metadata needed for exclusions
- marketplace execution event metadata needed for exclusions
- local SKU context/signal builders with external connectors disabled (`skipConnector: true`)

## Exclusion policy

The preview excludes or blocks:

- `item_id=202551129453`
- `item_id=206315990948`
- any item with `marketplace_execution_completed`
- any request with `executed_at` present
- any request with `execution_result` present
- `request_id=4`
- `packet_id=3`
- `approval_id=15`

## Seed classifications

Each possible seed row is classified as one of:

- `seed_ready_for_listing_quality_scoring`
- `seed_needs_cached_evidence`
- `seed_missing_item_id`
- `seed_missing_title`
- `seed_no_listing_quality_issue`
- `seed_blocked_already_executed`
- `seed_blocked_price_inventory_related`

The classification is advisory only. Phase 14C never creates opportunity rows or execution state.

## Deterministic listing-quality issue signals

All issue signals are generated in code from cached/internal data only:

- `title_too_short`
- `title_too_long`
- `missing_brand_specific`
- `missing_type_specific`
- `missing_country_specific`
- `item_specifics_sparse`
- `description_missing`
- `image_count_low`

No AI is used to generate issue signals.

## Output fields

The command returns JSON containing:

- `scanned_counts`
- `excluded_executed_item_ids`
- `excluded_records`
- `seed_rows`
- `issue_signals`
- `blockers`
- `recommended_next_safe_action`
- `safety`

## Latest validation output summary

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-candidate-seed-preview --limit=100
```

Observed summary:

```json
{
  "read_only": true,
  "phase": "14C",
  "operation": "listing_quality_candidate_seed_preview",
  "limit": 100,
  "scanned_counts": {
    "cached_listing_row_count": 100,
    "seed_count": 94,
    "returned_seed_count": 94,
    "marketplace_execution_event_count": 2,
    "marketplace_execution_completed_event_count": 2,
    "executed_request_count": 2,
    "classification_counts": {
      "seed_blocked_price_inventory_related": 93,
      "seed_blocked_already_executed": 1
    },
    "returned_classification_counts": {
      "seed_blocked_price_inventory_related": 93,
      "seed_blocked_already_executed": 1
    },
    "source_type_counts": {
      "cached_product_listing": 94
    }
  },
  "excluded_executed_item_ids": [
    "202551129453",
    "206315990948"
  ],
  "issue_signals": [
    "description_missing",
    "image_count_low",
    "item_specifics_sparse",
    "missing_brand_specific",
    "missing_country_specific",
    "missing_type_specific",
    "title_too_short"
  ],
  "blockers": [
    "item_already_executed_or_hard_excluded",
    "price_or_inventory_signal_present"
  ],
  "recommended_next_safe_action": "No seed row is ready for listing-quality scoring. Continue read-only internal discovery and keep executed items excluded."
}
```

## Safety object

The preview returns:

```json
{
  "read_only": true,
  "preview_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_api_call": false,
  "ai_calls": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "database_write_performed": false,
  "marketplace_write_performed": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "title_changes": false,
  "description_changes": false
}
```

## Phase 14C conclusion

Phase 14C found deterministic listing-quality issue signals in cached data, but no seed row was ready for listing-quality scoring because current local context signals classify the returned rows as price/inventory/stock related, and the already executed item remains blocked.

The next safe action is continued read-only internal discovery or a later explicitly authorized read-only evidence/scoring refinement phase. Phase 14C does not create opportunities, packets, approvals, execution requests, live candidates, database writes, marketplace writes, AI calls, GetItem calls, or ReviseFixedPriceItem calls.
