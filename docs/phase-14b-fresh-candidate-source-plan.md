# Phase 14B Fresh Candidate Source Plan

Status: implemented
Scope: read-only internal/local discovery for the next listing-quality expansion cycle

## Command

```bash
npm run hermes:agent -- ebay-listing-quality-fresh-candidate-source-plan --limit=100
```

## Purpose

Phase 14A confirmed that the current controlled-expansion queue had no actionable listing-quality candidate:

- `candidate_count=5`
- `blocked_already_executed=4`
- `blocked_missing_item_id=1`
- excluded executed items:
  - `202551129453`
  - `206315990948`

Phase 14B adds a separate fresh source planner that scans existing internal/local data for possible future candidate sources without creating any new workflow state.

## Internal/local sources scanned

The planner only reads existing application data:

- `hermes_execution_requests`
- `opportunity_inbox`
- `hermes_execution_events`
- cached eBay product/listing data already in the database
- cached listing-detail evidence already available through internal helpers
- existing SKU context/signal output generated locally with `skipConnector: true`

The planner does not call eBay, GetItem, ReviseFixedPriceItem, marketplace APIs, or AI.

## Exclusion policy

The planner excludes or blocks:

- `item_id=202551129453`
- `item_id=206315990948`
- any item with `marketplace_execution_completed`
- any request with `executed_at` present
- any request with `execution_result` present
- `request_id=4`
- `packet_id=3`
- `approval_id=15`

These records may still appear in the output as classified blocked rows if they are discovered from internal data, but they are marked non-actionable and are never recommended for packet/approval/request creation.

## Classifications

Each discovered source row is classified as one of:

- `candidate_source_ready_for_evidence_review`
- `candidate_source_needs_evidence_refresh`
- `candidate_source_missing_item_id`
- `candidate_source_missing_listing_quality_signal`
- `candidate_source_already_executed`
- `candidate_source_price_or_inventory_related`
- `candidate_source_insufficient_data`

## Output shape

The command returns JSON containing:

- `scanned_counts_by_source_type`
- `scanned_counts`
- `excluded_executed_item_ids`
- `excluded_records`
- `candidate_source_rows`
- `evidence_gaps`
- `blockers`
- `recommended_next_safe_action`
- `safety`

## Latest validation output summary

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-fresh-candidate-source-plan --limit=100
```

Observed summary:

```json
{
  "read_only": true,
  "phase": "14B",
  "operation": "listing_quality_fresh_candidate_source_plan",
  "limit": 100,
  "scanned_counts_by_source_type": {
    "opportunity": 8,
    "cached_product_listing": 92
  },
  "scanned_counts": {
    "request_count": 4,
    "opportunity_count": 15,
    "cached_listing_row_count": 100,
    "raw_source_count": 113,
    "returned_source_count": 100,
    "marketplace_execution_event_count": 2,
    "marketplace_execution_completed_event_count": 2,
    "executed_request_count": 2,
    "classification_counts": {
      "candidate_source_missing_item_id": 3,
      "candidate_source_missing_listing_quality_signal": 5,
      "candidate_source_price_or_inventory_related": 92
    }
  },
  "excluded_executed_item_ids": [
    "202551129453",
    "206315990948"
  ],
  "recommended_next_safe_action": "No fresh candidate source is actionable. Continue read-only internal discovery and keep executed items excluded."
}
```

## Safety object

The implemented planner returns:

```json
{
  "read_only": true,
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

## Phase 14B conclusion

The fresh source planner found no immediately actionable source rows. The next safe action is continued read-only discovery or a later explicitly authorized read-only evidence-refresh planning phase. Phase 14B does not create opportunities, packets, approvals, execution requests, live candidates, database writes, marketplace writes, AI calls, GetItem calls, or ReviseFixedPriceItem calls.
