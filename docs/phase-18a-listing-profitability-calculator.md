# Hermes Phase 18A — Listing Profitability Calculator

## Purpose

Phase 18A creates an automated listing profitability input template and a read-only profitability calculator keyed by `item_id`.

It uses the full eBay listing CSV as the listing source and only requires the operator to fill:

- `item_id`
- `product_cost_krw`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`

The phase does not import data, update listings, create execution requests, create packets, call eBay, call AI, or write to the database.

## Inputs

Listing CSV used for validation:

```text
/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv
```

Shipping reference adapted from:

```text
/Users/parksungmin/Downloads/pmc_shipping_engine_v2.py
```

The Phase 18A JavaScript implementation adapts the reference shipping engine for the default destination country `미국` and calculates all available U.S. quotes from:

- K-Packet
- KPL
- 쉽터
- 윤익스프레스
- EMS프리미엄 for 71kg+ shipments

## Commands

```bash
npm run hermes:agent -- listing-profitability-input-export --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --out=data/hermes-profitability-input-template.csv
npm run hermes:agent -- listing-profitability-input-validate --file=<CSV_FILE>
npm run hermes:agent -- listing-profitability-calculate --file=<CSV_FILE>
```

## Business assumptions

```json
{
  "usd_krw": 1450,
  "ebay_fee_pct": 0.18,
  "destination_country": "미국"
}
```

## Export template columns

The export command creates a local CSV with listing data and blank operator fields:

- `item_id`
- `sku`
- `title`
- `current_price_usd`
- `quantity`
- `quantity_sold`
- `listing_type`
- `view_url`
- `image_url`
- `product_cost_krw`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`
- `operator_note`

## Validator rules

The validator checks:

- `item_id` exists;
- `current_price_usd` is numeric;
- `product_cost_krw` is numeric and greater than 0;
- `weight_kg` is numeric and greater than 0;
- `length_cm`, `width_cm`, and `height_cm` are numeric and greater than or equal to 0;
- duplicate `item_id` rows are flagged;
- test/sandbox rows are blocked;
- invalid rows do not enter calculation.

The exported blank template is expected to validate as invalid until operator cost/weight/dimension fields are filled.

## Calculator logic

For each valid row, the calculator computes:

- `revenue_krw = current_price_usd * 1450`
- `ebay_fee_krw = revenue_krw * 0.18`
- all available shipping quotes for `미국`
- cheapest recommended shipping quote
- `shipping_krw`
- `product_cost_krw`
- `estimated_profit_krw`
- `margin_pct`
- `profitability_status`

Status rules:

- `blocked` if required input is missing or no shipping quote is available;
- `loss` if `estimated_profit_krw < 0`;
- `low_margin` if `margin_pct < 0.10`;
- `healthy` if `margin_pct >= 0.10`.

Invalid rows are excluded from calculation.

## Output shape

```json
{
  "phase": "18A",
  "mode": "read_only",
  "assumptions": {
    "usd_krw": 1450,
    "ebay_fee_pct": 0.18,
    "destination_country": "미국"
  },
  "rows_scanned": 0,
  "rows_calculated": 0,
  "blocked_rows": 0,
  "loss_count": 0,
  "low_margin_count": 0,
  "healthy_count": 0,
  "results": []
}
```

All outputs also include explicit safety booleans:

```json
{
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false,
  "no_ebay_call": true,
  "no_execution_requests_created": true,
  "no_packets_created": true,
  "no_price_inventory_listing_changes": true
}
```

## Observed validation

Export command result:

```json
{
  "phase": "18A",
  "mode": "read_only",
  "rows_scanned": 9168,
  "template_rows": 9168,
  "output_file": "/Users/parksungmin/pmc-work-mvp/data/hermes-profitability-input-template.csv",
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

Validation of the exported blank template returned:

```json
{
  "valid": false,
  "valid_rows": 0,
  "invalid_rows": 9168,
  "blocked_rows": 31
}
```

This is expected because operator fields are blank in the exported template.

A temporary local filled sample of 5 rows was calculated successfully:

```json
{
  "rows_scanned": 5,
  "rows_calculated": 5,
  "blocked_rows": 0,
  "loss_count": 0,
  "low_margin_count": 1,
  "healthy_count": 4
}
```

The first sample row selected `윤익스프레스` as the cheapest U.S. shipping quote at `12000 KRW`, while also calculating K-Packet, KPL, and 쉽터 alternatives.

## Safety

Phase 18A does not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- create execution requests;
- create packets;
- write DB rows;
- call AI;
- update price data;
- update inventory data;
- update listing data;
- push commits.

Local CSV export is allowed.

## Validation commands

```bash
node --check scripts/hermes-agent.js
node --check src/services/listingProfitabilityCalculator.js
npm run hermes:agent -- listing-profitability-input-export --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --out=data/hermes-profitability-input-template.csv
npm run hermes:agent -- listing-profitability-input-validate --file=data/hermes-profitability-input-template.csv
git diff --stat
```
