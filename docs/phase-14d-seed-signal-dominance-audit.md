# Phase 14D Seed Signal Dominance Audit

Status: implemented
Scope: read-only audit/preview separating listing-quality issue signals from price/inventory/stock context

## Command

```bash
npm run hermes:agent -- ebay-listing-quality-seed-signal-dominance-audit --limit=100
```

## Purpose

Phase 14C found deterministic listing-quality issue signals in cached seed rows, but classified nearly all rows as price/inventory related:

- `seed_count=94`
- `seed_blocked_price_inventory_related=93`
- `seed_blocked_already_executed=1`
- no seed was ready for listing-quality scoring

Phase 14D audits those Phase 14C seed rows and separates:

- actual listing-quality issue signals generated in code
- price/inventory/stock context signals from local SKU context
- hard blockers
- context warnings
- possible safe listing mutation scope

The audit is preview only. It does not turn rows into candidates and does not create opportunities.

## Hard safety boundary

Phase 14D must not:

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

The audit calls the Phase 14C seed preview function in read-only mode and inspects its returned seed rows.

The source data remains internal/local only:

- cached product/listing rows
- cached listing evidence tables
- execution/event metadata used for exclusions
- local SKU context/signal builders with external connectors disabled

## Classification buckets

Each audit row is classified as one of:

- `listing_quality_only_possible`
- `listing_quality_issue_with_price_inventory_context`
- `price_inventory_dominant_no_listing_action`
- `insufficient_listing_evidence`
- `already_executed_excluded`
- `no_listing_quality_issue`

## Price/inventory/stock dominance policy

Price/inventory/stock signals are treated as hard blockers only when the proposed mutation would affect forbidden fields:

- price
- quantity
- inventory
- stock
- end/create/relist
- shipping
- payment
- returns

If deterministic listing-quality issue signals exist and proposed mutation scope is limited to:

- title
- description
- item_specifics

then price/inventory/stock signals are reported as context warnings, not hard blockers.

Phase 14D still does not create opportunities or candidates.

## Output fields per row

Each audit row includes:

- `sku`
- `item_id`
- `title`
- `listing_quality_issue_signals`
- `price_inventory_stock_signal_types`
- `evidence_gaps`
- `proposed_safe_listing_mutation_fields`
- `mutation_scope`
- `blockers`
- `warnings`
- `blocker_vs_warning`
- `classification`
- `recommended_next_safe_action`

## Preserved hard exclusions

Phase 14D preserves:

- `item_id=202551129453`
- `item_id=206315990948`
- any marketplace_execution_completed item
- any request with `executed_at` or `execution_result`
- `request_id=4`
- `packet_id=3`
- `approval_id=15`

## Latest validation output summary

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-signal-dominance-audit --limit=100
```

Observed summary:

```json
{
  "read_only": true,
  "phase": "14D",
  "operation": "listing_quality_seed_signal_dominance_audit",
  "limit": 100,
  "source_seed_preview": {
    "phase": "14C",
    "operation": "listing_quality_candidate_seed_preview",
    "seed_count": 94,
    "returned_seed_count": 94,
    "source": "phase_14c_candidate_seed_preview_v1"
  },
  "scanned_counts": {
    "audited_seed_count": 94,
    "classification_counts": {
      "listing_quality_issue_with_price_inventory_context": 88,
      "price_inventory_dominant_no_listing_action": 2,
      "insufficient_listing_evidence": 3,
      "already_executed_excluded": 1
    },
    "rows_with_listing_quality_issues": 92,
    "rows_with_price_inventory_stock_context": 94,
    "rows_with_context_warnings": 94,
    "rows_with_hard_blockers": 6
  },
  "excluded_executed_item_ids": [
    "202551129453",
    "206315990948"
  ],
  "blockers": [
    "already_executed_or_hard_excluded",
    "insufficient_listing_evidence",
    "price_inventory_stock_context_without_listing_quality_issue"
  ],
  "warnings": [
    "deterministic_listing_quality_issue_absent",
    "price_inventory_stock_context_present_but_listing_mutation_scope_is_safe"
  ],
  "recommended_next_safe_action": "Use audit rows only for a later read-only listing-quality scoring preview. Treat price/inventory/stock as warnings when proposed scope is title/description/item_specifics only; do not create opportunities in Phase 14D."
}
```

## Safety object

The audit returns:

```json
{
  "read_only": true,
  "audit_preview_only": true,
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

## Phase 14D conclusion

Phase 14D shows that many rows have listing-quality issue signals plus price/inventory/stock context. For rows where proposed mutation scope is only title, description, or item_specifics, price/inventory/stock context is a warning rather than a hard blocker.

The next safe action is a later explicit read-only listing-quality scoring preview. Phase 14D does not create opportunities, packets, approvals, execution requests, live candidates, database writes, marketplace writes, AI calls, GetItem calls, or ReviseFixedPriceItem calls.
