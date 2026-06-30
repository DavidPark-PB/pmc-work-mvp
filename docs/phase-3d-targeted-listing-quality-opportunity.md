# Hermes Phase 3D — Targeted Listing Quality Opportunity Filter

## Purpose

Phase 3D enables safe targeted creation/validation of `listing_quality_review` opportunities so the Phase 3C Listing Evidence UI can be tested without writing unrelated opportunity types.

This phase does not redo Phase 2, Phase 3A, Phase 3B, or Phase 3C.

Baseline:

```text
716cf04 Add listing evidence to Hermes review UI
```

## What changed

Files changed:

- `src/agents/opportunityAgent.js`
- `scripts/hermes-agent.js`

No UI behavior changed. No review status logic changed.

## New CLI usage

Read-only targeted candidate generation:

```bash
npm run hermes:agent -- opportunity --sku=<SKU> --type=listing_quality_review
```

Dry-run targeted opportunity writer:

```bash
npm run hermes:agent -- opportunity-write --sku=<SKU> --type=listing_quality_review --dry-run
```

`--opportunity_type=<TYPE>` is accepted as an alias for `--type=<TYPE>`.

## Default behavior remains unchanged

When `--type` is omitted, Opportunity Agent behavior is unchanged and all generated candidate types are returned.

Validated with:

```bash
npm run hermes:agent -- opportunity --sku=PHASE3B-LISTING-QUALITY-FIXTURE
```

Observed candidate types:

```json
[
  "inventory_restock_review",
  "cost_data_completion",
  "listing_quality_review",
  "price_or_margin_review",
  "dead_stock_review"
]
```

## Type filtering behavior

The Opportunity Agent now supports an optional type filter in its options:

```js
runOpportunityAgent({ sku }, { type: 'listing_quality_review' })
runOpportunityWriteAgent({ sku, dryRun: true }, { type: 'listing_quality_review' })
```

Filtering happens after candidate generation and before output/write-preview.

Allowed filters are the known Hermes opportunity candidate types mapped from `RECOMMENDATION_TO_OPPORTUNITY`:

- `inventory_restock_review`
- `dead_stock_review`
- `listing_quality_review`
- `price_or_margin_review`
- `cost_data_completion`
- `competition_watch`
- `urgent_price_attack_review`

Unsupported filter values fail fast with an error.

## Writer safety

Writer behavior remains dry-run by default:

```js
const dryRun = hasFlag('dry-run') || !hasFlag('write');
```

Therefore:

- no flags -> dry-run
- `--dry-run` -> dry-run
- `--write` -> write mode
- `--dry-run --write` -> dry-run wins

Phase 3D validated that `--dry-run --write` still returns `dry_run: true`.

## Validation

Syntax checks:

```bash
node --check src/agents/opportunityAgent.js
node --check scripts/hermes-agent.js
```

Both passed.

Targeted candidate generation:

```bash
npm run hermes:agent -- opportunity --sku=PHASE3B-LISTING-QUALITY-FIXTURE --type=listing_quality_review
```

Observed summary:

```json
{
  "count": 1,
  "type_filter": "listing_quality_review",
  "types": [
    "listing_quality_review"
  ]
}
```

Targeted writer dry-run:

```bash
npm run hermes:agent -- opportunity-write --sku=PHASE3B-LISTING-QUALITY-FIXTURE --type=listing_quality_review --dry-run
```

Observed summary:

```json
{
  "dry_run": true,
  "type_filter": "listing_quality_review",
  "created": 1,
  "skipped": 0,
  "types": [
    "listing_quality_review"
  ],
  "errors": 0
}
```

Dry-run wins over write:

```bash
npm run hermes:agent -- opportunity-write --sku=PHASE3B-LISTING-QUALITY-FIXTURE --type=listing_quality_review --dry-run --write
```

Observed:

```json
{
  "dry_run": true,
  "type_filter": "listing_quality_review"
}
```

## Safety constraints

Phase 3D does not add or change any path that performs:

- marketplace writes
- price changes
- inventory changes
- listing changes
- AI calls
- review status changes
- Listing Evidence UI changes

The writer still only uses the existing Opportunity Inbox writer and remains dry-run unless explicitly run with `--write` and without `--dry-run`.
