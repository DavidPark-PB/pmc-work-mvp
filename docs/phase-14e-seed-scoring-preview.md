# Phase 14E Seed Scoring Preview

Status: implemented
Scope: read-only deterministic listing-quality scoring and shortlist preview from Phase 14D audit rows

## Command

```bash
npm run hermes:agent -- ebay-listing-quality-seed-scoring-preview --limit=100 --top=20
```

## Purpose

Phase 14E scores only Phase 14D audit rows that may have listing-quality action potential. It remains a preview-only shortlist and does not create opportunities or any execution artifacts.

Phase 14D observed:

- `audited_seed_count=94`
- `listing_quality_issue_with_price_inventory_context=88`
- `price_inventory_dominant_no_listing_action=2`
- `insufficient_listing_evidence=3`
- `already_executed_excluded=1`

Phase 14E converts the eligible audit rows into a ranked, deterministic, read-only shortlist preview.

## Hard safety boundary

Phase 14E must not:

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

## Input source

Phase 14E calls the Phase 14D dominance audit function in read-only mode and scores the returned audit rows.

It scores only rows classified as:

- `listing_quality_only_possible`
- `listing_quality_issue_with_price_inventory_context`

It excludes these rows from shortlist scoring:

- `already_executed_excluded`
- `insufficient_listing_evidence`
- `price_inventory_dominant_no_listing_action`
- `no_listing_quality_issue`

## Deterministic scoring inputs

No AI is used. Scoring is generated entirely in code from Phase 14D row fields.

The score considers:

- listing-quality issue signal count
- issue severity weights
- `title_too_short`
- `title_too_long`
- `missing_brand_specific`
- `missing_type_specific`
- `missing_country_specific`
- `item_specifics_sparse`
- `description_missing`
- `image_count_low`
- evidence completeness
- safe proposed mutation fields
- price/inventory/stock context as warning penalty only

## Score formula

Each scored row includes `score_breakdown` with:

```text
issue_severity
+ issue_count
+ evidence_completeness
+ safe_mutation_scope
- price_inventory_warning_penalty
- warning_penalty
- hard_blocker_penalty
```

Issue severity weights:

```json
{
  "title_too_short": 15,
  "title_too_long": 15,
  "missing_brand_specific": 13,
  "missing_type_specific": 13,
  "missing_country_specific": 11,
  "item_specifics_sparse": 12,
  "description_missing": 14,
  "image_count_low": 8
}
```

## Allowed proposed mutation fields

Phase 14E only allows proposed listing-quality mutation fields:

- `title`
- `description`
- `item_specifics`

Rows are hard blocked if their proposed mutation scope would affect:

- price
- quantity
- inventory
- stock
- end/create/relist
- shipping
- payment
- returns

## Preserved hard exclusions

Phase 14E preserves:

- `item_id=202551129453`
- `item_id=206315990948`
- any marketplace_execution_completed item
- any request with `executed_at` or `execution_result`
- `request_id=4`
- `packet_id=3`
- `approval_id=15`

## Output fields

The command returns JSON containing:

- `scanned_counts`
- `scored_row_count`
- `shortlist_rows`
- `score_breakdown`
- `issue_signals`
- `warnings`
- `blockers`
- `proposed_safe_listing_mutation_fields`
- `recommended_next_safe_action`
- `safety`

## Latest validation output summary

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-scoring-preview --limit=100 --top=20
```

Observed summary:

```json
{
  "read_only": true,
  "phase": "14E",
  "operation": "listing_quality_seed_scoring_preview",
  "limit": 100,
  "top": 20,
  "source_audit": {
    "phase": "14D",
    "operation": "listing_quality_seed_signal_dominance_audit",
    "audited_seed_count": 94,
    "source": "phase_14d_seed_signal_dominance_audit_v1"
  },
  "scanned_counts": {
    "audit_row_count": 94,
    "eligible_for_scoring_count": 88,
    "excluded_from_scoring_count": 6,
    "scored_row_count": 88,
    "shortlist_row_count": 20,
    "audit_classification_counts": {
      "listing_quality_issue_with_price_inventory_context": 88,
      "price_inventory_dominant_no_listing_action": 2,
      "insufficient_listing_evidence": 3,
      "already_executed_excluded": 1
    },
    "scored_classification_counts": {
      "listing_quality_issue_with_price_inventory_context": 88
    },
    "excluded_classification_counts": {
      "price_inventory_dominant_no_listing_action": 2,
      "insufficient_listing_evidence": 3,
      "already_executed_excluded": 1
    },
    "rows_with_price_inventory_stock_warning_context": 88,
    "rows_hard_blocked_for_forbidden_scope": 0
  },
  "excluded_executed_item_ids": [
    "202551129453",
    "206315990948"
  ],
  "scored_row_count": 88,
  "shortlist_row_count": 20,
  "issue_signals": [
    "description_missing",
    "image_count_low",
    "item_specifics_sparse",
    "missing_brand_specific",
    "missing_country_specific",
    "missing_type_specific",
    "title_too_short"
  ],
  "warnings": [
    "price_inventory_stock_context_present_but_listing_mutation_scope_is_safe"
  ],
  "blockers": [],
  "proposed_safe_listing_mutation_fields": [
    "description",
    "item_specifics",
    "title"
  ],
  "recommended_next_safe_action": "Review shortlist rows in a later explicit read-only packet/opportunity preview phase; Phase 14E creates no opportunities, packets, approvals, requests, live candidates, DB writes, or marketplace writes."
}
```

Top shortlist examples from validation:

1. `PMC-24091` / `206273302162` / score `100`
2. `PMC-24092` / `206273302295` / score `100`
3. `PMC-24110` / `206273369517` / score `100`
4. `PMC-24141` / `206288370789` / score `100`
5. `PMC-24152` / `206288375702` / score `100`

## Safety object

The preview returns:

```json
{
  "read_only": true,
  "scoring_preview_only": true,
  "deterministic_scoring_only": true,
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

## Phase 14E conclusion

Phase 14E produced a deterministic read-only top-20 shortlist from 88 eligible listing-quality audit rows. Price/inventory/stock context remains a warning penalty only because proposed mutation fields are limited to `title`, `description`, and `item_specifics`.

The next safe action is a later explicit read-only shortlist review or packet/opportunity preview phase. Phase 14E does not create opportunities, packets, approvals, execution requests, live candidates, database writes, marketplace writes, AI calls, GetItem calls, or ReviseFixedPriceItem calls.
