# Hermes Phase 17A — Profit / Inventory Opportunity Planner

## Purpose

Phase 17A pivots Hermes away from image-only public PictureURL rollout expansion and back toward the AI Business Operating System direction: profit, inventory, cost, sales velocity, and competitor-pressure opportunity planning.

This phase is read-only planning only.

It does not create execution requests, packets, approvals, marketplace writes, DB writes, or listing/price/inventory mutations.

## Baseline

Do not redo Phase 14, Phase 15, or Phase 16.

Latest completed baseline:

```text
bed7489 Add Phase 16F public PictureURL mini-batch post-live audit
```

Image pipeline expansion is paused for Phase 17A:

```json
{
  "image_pipeline_expansion_paused": true
}
```

## Command added

```bash
npm run hermes:agent -- profit-inventory-opportunity-plan --limit=50
```

## Implementation

The command is implemented through:

- `scripts/hermes-agent.js`
- `src/services/hermesExecutionApproval.js`
- existing `src/services/skuContextBuilder.js`
- existing `src/engines/signalEngine.js`

The planner loads cached/internal `ebay_products` rows, builds read-only SKU contexts with connector usage skipped, reuses existing Signal Engine signals, and adds deterministic Phase 17A-only planning signals when supported by cached fields:

- `low_margin_risk` when cost/price fields exist and margin is below threshold;
- `overstock` when cached inventory is high and recent sales are zero;
- `slow_mover` when available stock exists but cached total/recent sales are low.

No AI call is made.

## Priority opportunity types

Phase 17A ranks and emits these opportunity types:

- `dead_stock`
- `no_recent_sales`
- `stock_risk`
- `missing_cost`
- `competitor_lower_price`
- `price_attack`
- `low_margin_risk` if cost/price data exists
- `overstock` / `slow_mover` if sales velocity data exists

Ranking is deterministic and rule-based. It weighs signal priority, estimated impact, available quantity, and current price.

## Output shape

The command returns:

```json
{
  "phase": "17A",
  "mode": "read_only",
  "image_pipeline_expansion_paused": true,
  "limit": 50,
  "opportunities": [
    {
      "rank": 1,
      "sku": "OPK-PR-TEST-001",
      "item_id": "206286785601",
      "title": "Bandai One Piece Card Game Promotion Pack 2025 Vol.1 Updated Test Listing",
      "opportunity_type": "dead_stock",
      "signals": ["stock_risk", "no_recent_sales", "dead_stock", "missing_cost", "slow_mover"],
      "current_price": 999.99,
      "cost": 0,
      "available_quantity": 1,
      "recent_sales": 0,
      "estimated_impact": "high",
      "recommended_next_action": "review_inventory",
      "requires_ai": false,
      "requires_marketplace_write": false,
      "reasoning": "Signals and cached price/inventory/sales facts explain why this row is ranked."
    }
  ],
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

The actual command output includes full signal objects rather than only signal type strings, preserving the Phase 1C signal format:

```json
{
  "type": "dead_stock",
  "severity": "warning",
  "value": {
    "available_quantity": 1,
    "window_days": 30,
    "orders_30d": 0
  },
  "detected_at": "ISO8601"
}
```

## Observed validation summary

The validation command returned 50 read-only opportunities.

Top-ranked observed row:

```json
{
  "rank": 1,
  "sku": "OPK-PR-TEST-001",
  "item_id": "206286785601",
  "opportunity_type": "dead_stock",
  "current_price": 999.99,
  "cost": 0,
  "available_quantity": 1,
  "recent_sales": 0,
  "estimated_impact": "high",
  "recommended_next_action": "review_inventory",
  "requires_ai": false,
  "requires_marketplace_write": false
}
```

Top-row signal types observed:

```json
[
  "stock_risk",
  "no_recent_sales",
  "dead_stock",
  "missing_cost",
  "slow_mover"
]
```

The observed data set did not provide usable cost values for the top rows, so `missing_cost` appears frequently and `cost` is emitted as `0` in the public output shape. The planner can emit `low_margin_risk` when cost fields become available in cached data.

## Safety

Phase 17A does not:

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
- expand the image pipeline;
- push commits.

Top-level safety output:

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
git diff --stat
```
