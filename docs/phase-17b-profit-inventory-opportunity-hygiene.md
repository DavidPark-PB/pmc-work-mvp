# Hermes Phase 17B — Profit / Inventory Opportunity Hygiene

## Purpose

Phase 17B adds a read-only data hygiene and actionable shortlist layer on top of the Phase 17A profit/inventory opportunity planner.

The immediate reason is that Phase 17A surfaced `OPK-PR-TEST-001` as the top opportunity with `current_price=999.99` and `cost=0`. That row is useful for validating planner mechanics, but it is not safe to treat as an actionable operator opportunity.

Phase 17B therefore blocks obvious test/sandbox records and incomplete records before any future execution flow is considered.

## Commands

```bash
npm run hermes:agent -- profit-inventory-opportunity-hygiene --limit=50
npm run hermes:agent -- profit-inventory-actionable-shortlist --limit=25
```

## Classification buckets

Each Phase 17A opportunity is classified into one of:

- `actionable`
- `data_quality_blocked`
- `test_or_sandbox_blocked`
- `missing_cost_blocked`
- `missing_listing_evidence_blocked`
- `needs_human_review`

Only `actionable` rows are included in the actionable shortlist.

`needs_human_review` is intentionally treated as blocked from the automated actionable shortlist because it may involve sensitive margin or competitive pricing decisions. It remains safe for read-only review but is not a direct execution candidate.

## Hygiene rules

Phase 17B blocks non-actionable records when:

- SKU or title contains `TEST`, `test`, `sample`, `mock`, or `demo`;
- price is suspiciously high and the row looks like test/sandbox data;
- cost is `0` or missing when margin/risk decision depends on cost;
- `item_id` is missing;
- title is missing;
- listing status is present but not one of `active`, `in_stock`, or `available`;
- opportunity type is missing or unclear;
- the opportunity would require an immediate marketplace write.

Cost-dependent opportunity types/signals include:

- `missing_cost`
- `competitor_lower_price`
- `price_attack`
- `low_margin_risk`

## Output shape

Both Phase 17B commands return the same safety envelope:

```json
{
  "phase": "17B",
  "mode": "read_only",
  "input_limit": 50,
  "actionable_count": 0,
  "blocked_count": 0,
  "blocked_reasons_summary": {},
  "actionable_opportunities": [],
  "blocked_opportunities": [],
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

The actionable shortlist command additionally includes `shortlist_limit` and trims `actionable_opportunities` to the requested limit.

## Observed validation behavior

In validation against the current cached/internal data, the known Phase 17A top row is blocked:

```json
{
  "sku": "OPK-PR-TEST-001",
  "item_id": "206286785601",
  "classification": "test_or_sandbox_blocked",
  "blocked_reasons": [
    "test_or_sandbox_record",
    "suspicious_test_price",
    "missing_or_zero_cost_for_margin_or_risk_decision"
  ]
}
```

This is expected and is the primary Phase 17B hygiene fix.

## Safety

Phase 17B does not:

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

Top-level safety booleans remain explicit:

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
npm run hermes:agent -- profit-inventory-opportunity-plan --limit=50
npm run hermes:agent -- profit-inventory-opportunity-hygiene --limit=50
npm run hermes:agent -- profit-inventory-actionable-shortlist --limit=25
git diff --stat
```
