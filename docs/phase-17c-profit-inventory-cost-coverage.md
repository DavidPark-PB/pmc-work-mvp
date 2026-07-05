# Hermes Phase 17C — Profit / Inventory Cost Coverage Audit

## Purpose

Phase 17C addresses the bottleneck discovered in Phase 17B: profit/inventory recommendations are blocked because current cached/internal listing rows do not have usable cost data.

Phase 17C is read-only. It audits cost coverage and builds a cost enrichment plan before any future execution or recommendation workflow is considered.

## Commands

```bash
npm run hermes:agent -- profit-inventory-cost-coverage-audit --limit=500
npm run hermes:agent -- profit-inventory-cost-enrichment-plan --limit=100
```

## Implementation

Implemented in:

- `scripts/hermes-agent.js`
- `src/services/hermesExecutionApproval.js`

The commands read cached/internal `ebay_products` rows and reuse Phase 17B hygiene results to identify opportunity types blocked by missing cost.

No marketplace API, eBay `GetItem`, eBay write, DB write, AI call, execution request, packet, or listing mutation is performed.

## Cost coverage fields

The audit checks common cached cost fields when present:

- `cost_usd`
- `cost`
- `unit_cost`
- `purchase_cost`
- `supplier_cost`
- `item_cost`
- `landed_cost`
- `average_cost`
- `avg_cost`
- matching nested fields under `raw`, `raw_data`, or `metadata`

Rows are classified as:

- `with_cost`: detected cost value is greater than 0;
- `zero_cost`: detected cost value exists but is 0 or less;
- `missing_cost`: no supported cost field/value is present.

## Enrichment classifications

Missing/zero-cost rows are classified into:

- `can_infer_from_purchase_data`
- `can_infer_from_supplier_data`
- `can_infer_from_recent_import`
- `needs_manual_cost_input`
- `should_exclude_test_or_sandbox`
- `insufficient_data`

The current classifier is deterministic and metadata-based. It does not infer or write costs; it only explains the most likely next collection path.

## Output shape

Both commands emit the Phase 17C safety envelope:

```json
{
  "phase": "17C",
  "mode": "read_only",
  "cost_coverage": {
    "scanned": 0,
    "with_cost": 0,
    "missing_cost": 0,
    "zero_cost": 0,
    "coverage_pct": 0
  },
  "recommendation_unblocked_count": 0,
  "recommendation_blocked_count": 0,
  "enrichment_candidates": [],
  "next_step": "cost_enrichment_required",
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

Additional fields include:

- `profit_inventory_recommendations_blocked`
- `affected_opportunity_types`
- `top_skus_blocked_by_missing_cost`
- `enrichment_classification_summary` for the enrichment plan command
- explicit no-write/no-eBay/no-AI safety booleans

## Observed validation result

Cost coverage audit with `--limit=500` returned:

```json
{
  "scanned": 500,
  "with_cost": 0,
  "missing_cost": 500,
  "zero_cost": 0,
  "coverage_pct": 0
}
```

Recommendation state:

```json
{
  "recommendation_unblocked_count": 0,
  "recommendation_blocked_count": 100,
  "profit_inventory_recommendations_blocked": true,
  "affected_opportunity_types": {
    "dead_stock": 100
  },
  "next_step": "cost_enrichment_required"
}
```

Cost enrichment plan with `--limit=100` returned:

```json
{
  "enrichment_classification_summary": {
    "needs_manual_cost_input": 98,
    "should_exclude_test_or_sandbox": 2
  }
}
```

This confirms the next bottleneck is not AI, marketplace execution, or listing mutation. It is cost data coverage.

## Safety

Phase 17C does not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- create execution requests;
- create packets;
- write DB rows;
- call AI;
- update price data;
- update inventory data;
- update listing data;
- push commits.

Top-level safety booleans:

```json
{
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false,
  "no_execution_requests_created": true,
  "no_packets_created": true,
  "no_ebay_call": true,
  "no_get_item_call": true,
  "no_revise_fixed_price_item_call": true,
  "no_price_inventory_listing_changes": true
}
```

## Validation

```bash
node --check src/engines/signalEngine.js
node --check src/services/skuContextBuilder.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- profit-inventory-cost-coverage-audit --limit=500
npm run hermes:agent -- profit-inventory-cost-enrichment-plan --limit=100
git diff --stat
```
