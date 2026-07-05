# Hermes Phase 18B — Listing Profitability Overlay Workflow

## Purpose

Phase 18B adds a minimal `item_id`-based profitability overlay workflow so the operator does not need to edit the full 9,168-row listing profitability CSV from Phase 18A.

The overlay is read-only preparation and calculation only. It does not write to the database, call eBay, call AI, create execution requests, create packets, or mutate listings.

## Inputs

Full listing CSV:

```text
/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv
```

Full Phase 18A template:

```text
/Users/parksungmin/pmc-work-mvp/data/hermes-profitability-input-template.csv
```

Shipping reference adapted in Phase 18A:

```text
/Users/parksungmin/Downloads/pmc_shipping_engine_v2.py
```

## Commands

```bash
npm run hermes:agent -- listing-profitability-overlay-template --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --limit=200 --out=data/hermes-profitability-overlay-template.csv
npm run hermes:agent -- listing-profitability-overlay-validate --file=<CSV_FILE>
npm run hermes:agent -- listing-profitability-calculate-overlay --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --overlay=<CSV_FILE>
```

## Overlay columns

The overlay template intentionally omits SKU and other non-required listing columns. It includes only:

- `item_id`
- `title`
- `current_price_usd`
- `quantity`
- `quantity_sold`
- `product_cost_krw`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`
- `operator_note`

`item_id` is the primary key. SKU is not required.

The operator only needs to fill:

- `product_cost_krw`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`

## Business assumptions

```json
{
  "usd_krw": 1450,
  "ebay_fee_pct": 0.18,
  "destination_country": "미국"
}
```

## Overlay validation rules

The overlay validator checks:

- `item_id` exists;
- `item_id` exists in the listing CSV;
- `product_cost_krw > 0`;
- `weight_kg > 0`;
- `length_cm`, `width_cm`, and `height_cm >= 0`;
- duplicate `item_id` rows are flagged;
- test/sandbox rows are blocked.

Invalid overlay rows do not enter profitability calculation.

The standalone `listing-profitability-overlay-validate --file=<CSV_FILE>` command defaults the listing lookup to:

```text
/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv
```

The calculation command accepts the listing CSV explicitly and merges listing facts with the overlay rows by `item_id`.

## Calculator behavior

`listing-profitability-calculate-overlay`:

1. Loads the full listing CSV.
2. Loads the operator overlay CSV.
3. Validates overlay rows.
4. Drops invalid/blocked rows.
5. Merges listing facts by `item_id`.
6. Runs the existing Phase 18A profitability calculation logic.

It calculates:

- `revenue_krw`
- `ebay_fee_krw`
- all available U.S. shipping quotes
- recommended cheapest shipping quote
- `shipping_krw`
- `product_cost_krw`
- `estimated_profit_krw`
- `margin_pct`
- `profitability_status`

Status rules remain inherited from Phase 18A:

- `loss` if `estimated_profit_krw < 0`;
- `low_margin` if `margin_pct < 0.10`;
- `healthy` if `margin_pct >= 0.10`;
- `blocked` if required input is missing or no shipping quote is available.

## Output shape

```json
{
  "phase": "18B",
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
  "results": [],
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

## Observed validation

Overlay template export:

```json
{
  "phase": "18B",
  "mode": "read_only",
  "rows_scanned": 9168,
  "template_rows": 200,
  "output_file": "/Users/parksungmin/pmc-work-mvp/data/hermes-profitability-overlay-template.csv",
  "marketplace_write": false,
  "db_write": false,
  "ai_call": false
}
```

Validation of the blank 200-row overlay template:

```json
{
  "phase": "18B",
  "mode": "read_only",
  "rows_scanned": 200,
  "validation": {
    "valid": false,
    "valid_rows": 0,
    "invalid_rows": 200,
    "blocked_rows": 0
  }
}
```

This is expected because the operator fields are blank.

A temporary filled 5-row overlay sample calculated successfully:

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

The first sample selected `윤익스프레스` as the cheapest U.S. shipping quote at `12000 KRW`, while also calculating K-Packet, KPL, and 쉽터 alternatives.

## Safety

Phase 18B does not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- write DB rows;
- call AI;
- create execution requests;
- create packets;
- change price;
- change inventory;
- change listing content;
- push commits.

Local CSV export is allowed.

## Validation commands

```bash
node --check scripts/hermes-agent.js
node --check src/services/listingProfitabilityCalculator.js
npm run hermes:agent -- listing-profitability-overlay-template --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --limit=200 --out=data/hermes-profitability-overlay-template.csv
npm run hermes:agent -- listing-profitability-overlay-validate --file=data/hermes-profitability-overlay-template.csv
git diff --stat
```
