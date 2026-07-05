# Hermes Phase 17D — Profit / Inventory Manual Cost Input Template

## Purpose

Phase 17D creates a safe manual cost input template and a read-only CSV validator so cost data can be prepared before any future DB import phase.

This phase follows Phase 17C's finding that current cost coverage is 0%:

```json
{
  "scanned": 500,
  "with_cost": 0,
  "missing_cost": 500,
  "recommendation_unblocked_count": 0,
  "recommendation_blocked_count": 100
}
```

Phase 17D does not import costs. It only outputs a CSV-compatible template and validates operator-filled CSV files.

## Commands

```bash
npm run hermes:agent -- profit-inventory-cost-input-template --limit=100
npm run hermes:agent -- profit-inventory-cost-input-validate --file=<CSV_FILE>
```

## Template columns

The template output includes these required columns:

- `sku`
- `item_id`
- `title`
- `current_price`
- `available_quantity`
- `recent_sales`
- `opportunity_type`
- `current_cost`
- `new_cost`
- `cost_currency`
- `cost_source`
- `operator_note`

`new_cost` is intentionally blank for operator input. `cost_currency` defaults to `USD`, and `cost_source` defaults to `manual_operator_input`.

The template excludes obvious test/sandbox rows where possible using the same deterministic `test|sample|mock|demo` SKU/title guard used by Phase 17B/17C.

## Template output shape

```json
{
  "phase": "17D",
  "mode": "read_only",
  "columns": [
    "sku",
    "item_id",
    "title",
    "current_price",
    "available_quantity",
    "recent_sales",
    "opportunity_type",
    "current_cost",
    "new_cost",
    "cost_currency",
    "cost_source",
    "operator_note"
  ],
  "template_rows": 99,
  "rows": [],
  "csv": "sku,item_id,title,current_price,...",
  "validation": {
    "valid": false,
    "valid_rows": 0,
    "invalid_rows": 0,
    "blocked_rows": 0,
    "errors": []
  },
  "ready_for_cost_import": false,
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

## Validator rules

The validator checks:

- required columns exist;
- `sku` exists;
- `item_id` exists;
- `new_cost` is numeric;
- `new_cost > 0`;
- `cost_currency` is present;
- duplicate `sku` rows are flagged;
- test/sandbox rows are blocked;
- no marketplace write will occur;
- no DB write will occur.

The validator is read-only. `ready_for_cost_import=true` only means the CSV is structurally ready for a future explicit import phase; it does not perform an import.

## Validator output shape

```json
{
  "phase": "17D",
  "mode": "read_only",
  "template_rows": 0,
  "validation": {
    "valid": false,
    "valid_rows": 0,
    "invalid_rows": 0,
    "blocked_rows": 0,
    "errors": []
  },
  "ready_for_cost_import": false,
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

## Observed validation results

Template command:

```json
{
  "phase": "17D",
  "mode": "read_only",
  "template_rows": 99,
  "ready_for_cost_import": false,
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

A temporary valid local CSV sample with three filled `new_cost` values validated as:

```json
{
  "valid": true,
  "valid_rows": 3,
  "invalid_rows": 0,
  "blocked_rows": 0,
  "errors": []
}
```

A temporary invalid local CSV sample confirmed duplicate SKU, zero cost, and test/sandbox blocking:

```json
{
  "valid": false,
  "valid_rows": 0,
  "invalid_rows": 3,
  "blocked_rows": 1
}
```

## Safety

Phase 17D does not:

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

Local CSV/template output is allowed.

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
npm run hermes:agent -- profit-inventory-cost-input-template --limit=100
npm run hermes:agent -- profit-inventory-cost-input-validate --file=<CSV_FILE>
git diff --stat
```
