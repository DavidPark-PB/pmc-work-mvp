# Hermes Phase 18C — Sold-First Listing Profitability Overlay

## Purpose

Phase 18C improves the Phase 18B listing profitability overlay workflow by prioritizing high-selling listings first and adding a local profitability result CSV export.

The operator should fill cost, weight, and dimensions for listings with higher `quantity_sold` before lower-selling listings.

This phase remains read-only. It does not write to the database, call eBay, call AI, create execution requests, create packets, mutate listings, or change price/inventory/listing state.

## Inputs

Full listing CSV:

```text
/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv
```

Overlay CSV:

```text
data/hermes-profitability-overlay-template.csv
```

Result CSV:

```text
data/hermes-profitability-results.csv
```

## Commands

Create a sold-first 200-row operator overlay:

```bash
npm run hermes:agent -- listing-profitability-overlay-template --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --limit=200 --sort=quantity_sold_desc --out=data/hermes-profitability-overlay-template.csv
```

Calculate only filled overlay rows:

```bash
npm run hermes:agent -- listing-profitability-calculate-overlay-filled --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --overlay=data/hermes-profitability-overlay-template.csv
```

Export calculated profitability results to local CSV:

```bash
npm run hermes:agent -- listing-profitability-result-export --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --overlay=data/hermes-profitability-overlay-template.csv --out=data/hermes-profitability-results.csv
```

## Sort behavior

The default overlay template sort remains stable/backward compatible when no `--sort` option is supplied.

When `--sort=quantity_sold_desc` is supplied, rows are ordered by:

1. `quantity_sold` descending;
2. tie-break by `quantity` descending;
3. tie-break by `current_price_usd` descending;
4. final stable tie-break by original listing CSV order.

Rows with blank or invalid sold counts are kept at the bottom.

## Overlay columns

The Phase 18C overlay keeps the minimal Phase 18B column set:

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

`item_id` remains the primary key. SKU is not required.

## Filled-row calculation behavior

`listing-profitability-calculate-overlay-filled` is intended for partially completed operator overlays.

It ignores rows where all operator input fields are blank:

- `product_cost_krw`
- `weight_kg`
- `length_cm`
- `width_cm`
- `height_cm`

Only rows with at least one operator input field filled are validated and considered for calculation.

Filled rows are validated with the Phase 18B overlay rules:

- `item_id` exists;
- `item_id` exists in the full listing CSV;
- `product_cost_krw > 0`;
- `weight_kg > 0`;
- `length_cm`, `width_cm`, and `height_cm >= 0`;
- duplicate `item_id` rows are flagged;
- test/sandbox rows are blocked.

Invalid filled rows do not enter calculation and are returned under `blocked_rows_detail`.

Blank rows are counted as `ignored_blank_rows`, not validation failures.

## Result export CSV columns

`listing-profitability-result-export` writes a local CSV with these columns:

- `item_id`
- `title`
- `current_price_usd`
- `quantity`
- `quantity_sold`
- `revenue_krw`
- `product_cost_krw`
- `shipping_krw`
- `ebay_fee_krw`
- `estimated_profit_krw`
- `margin_pct`
- `profitability_status`
- `recommended_shipping_carrier`
- `recommended_shipping_service`
- `weight_kg`
- `dimensions`
- `view_url`

The export writes the CSV header even when no overlay rows have been filled yet.

## Business assumptions

Inherited from Phase 18A:

```json
{
  "usd_krw": 1450,
  "ebay_fee_pct": 0.18,
  "destination_country": "미국"
}
```

## Observed validation

Sold-first overlay export returned the first five `quantity_sold` values:

```json
{
  "phase": "18C",
  "rows_scanned": 9168,
  "template_rows": 200,
  "sort": "quantity_sold_desc",
  "first_quantity_sold": ["3589", "2457", "2068", "2063", "1865"]
}
```

Blank sold-first overlay calculation correctly ignored blank operator rows:

```json
{
  "phase": "18C",
  "rows_scanned": 200,
  "filled_rows": 0,
  "ignored_blank_rows": 200,
  "rows_calculated": 0,
  "blocked_rows": 0
}
```

Blank sold-first result export created a local CSV with the required header and zero data rows:

```json
{
  "phase": "18C",
  "rows_scanned": 200,
  "filled_rows": 0,
  "ignored_blank_rows": 200,
  "rows_calculated": 0,
  "exported_rows": 0,
  "output_file": "/Users/parksungmin/pmc-work-mvp/data/hermes-profitability-results.csv"
}
```

## Safety

Phase 18C does not:

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
npm run hermes:agent -- listing-profitability-overlay-template --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --limit=200 --sort=quantity_sold_desc --out=data/hermes-profitability-overlay-template.csv
npm run hermes:agent -- listing-profitability-calculate-overlay-filled --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --overlay=data/hermes-profitability-overlay-template.csv
npm run hermes:agent -- listing-profitability-result-export --listings=/Users/parksungmin/pmc-work-mvp/logs/ebay-listings-20260705-1933.csv --overlay=data/hermes-profitability-overlay-template.csv --out=data/hermes-profitability-results.csv
git diff --stat
```
