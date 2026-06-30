# Hermes Phase 4H — Enrichment Candidate Selector Hardening

Report timestamp: 2026-06-30T17:20:13Z

## Purpose

Phase 4H hardens Listing Data Enrichment candidate selection so dry-run does not falsely return `0` when the newest `ebay_products` candidate window is already enriched.

This phase does not redo Phase 4A, 4B, 4C, 4D, 4E, 4F, or 4G.

Baseline:

```text
05ab793 Add Phase 4G enrichment manual run validation
```

No execute-mode enrichment run was performed in Phase 4H. Validation stayed read-only.

## Files reviewed before editing

- `git log --oneline -10`
- `docs/phase-4f-enrichment-operations.md`
- `docs/phase-4g-enrichment-manual-run-validation.md`
- `scripts/hermes-enrichment-ops.js`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `package.json`

## Problem

Before Phase 4H, `getCandidateListings()` queried a limited recent window from `ebay_products` and then applied the `missingOnly` enrichment filter inside that already-limited window.

That made this false-zero scenario possible:

1. The newest N `ebay_products` rows are already present in `listing_details`.
2. Older `ebay_products` rows are still missing enrichment.
3. Dry-run filters the newest N rows and returns `0` candidates.
4. Operators could incorrectly conclude there is no remaining enrichment work.

This was especially risky for operations because Phase 4F/4G require dry-run-first behavior before any scheduled or manual execute run.

## Fix

Updated `src/services/hermesListingEnrichment.js` to add bounded scan-based candidate discovery.

New discovery path:

```js
discoverCandidateListings({
  limit,
  sku,
  missingOnly,
  scanLimit,
})
```

Behavior:

- `missingOnly: true` scans `ebay_products` in bounded batches.
- Each batch checks existing `listing_details` rows for enriched item ids.
- Scanning continues until either:
  - `limit` missing candidates are found, or
  - `scanLimit` rows have been scanned, or
  - the source row set is exhausted.
- It does not fetch unlimited rows by default.
- Default `scanLimit` is conservative: `5000`.
- `scanLimit` is capped in code to avoid accidental unbounded scans.
- Existing `getCandidateListings()` remains available as a compatibility wrapper returning just the candidate array.
- `enrichListings()` now uses the same scan-aware discovery path and carries the metadata in `candidate_metadata`.

Structured metadata returned:

```json
{
  "scanned_count": 500,
  "candidate_count": 100,
  "returned_count": 100,
  "scan_limit": 5000,
  "exhausted_scan": false,
  "missing_only": true
}
```

Field meanings:

- `scanned_count`: number of `ebay_products` rows inspected.
- `candidate_count`: missing enrichment candidates found within the bounded scan before return slicing.
- `returned_count`: number of candidates returned to the caller.
- `scan_limit`: maximum bounded source rows allowed for this discovery run.
- `exhausted_scan`: true when the scan hit the scan boundary or source exhaustion before finding enough candidates.
- `missing_only`: whether already-enriched listings were filtered out.

## Operations wrapper changes

Updated `scripts/hermes-enrichment-ops.js`:

- Added `--scan-limit=<N>` support for daily mode.
- Dry-run output now includes:
  - `scanned_count`
  - `candidate_count`
  - `returned_count`
  - `scan_limit`
  - `exhausted_scan`
  - `sample`
- Execute mode passes `scanLimit` to enrichment as well, but execute mode was not run in this phase.
- Status output now includes a read-only bounded estimate:
  - `missing_enrichment_candidate_estimate`
- Validate mode remains unchanged and continues using `buildListingIntelligenceReport({ days: 30, save: false })`.

## scanLimit behavior

Default:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100
```

Equivalent bounded scan default:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
```

Recommended manual check:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
```

If `returned_count` is `0` and `exhausted_scan` is `true`, the bounded scan did not find missing candidates. Before execute, inspect whether the candidate pool is truly exhausted or whether the operator should intentionally increase `--scan-limit` in a separate safe read-only run.

If `returned_count` is less than `limit` and `exhausted_scan` is true, there may be fewer remaining missing candidates in the bounded scan window.

If `returned_count` equals `limit` and `exhausted_scan` is false, the selector found enough candidates before exhausting the scan window.

## Dry-run validation

Command:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
```

Observed result:

```json
{
  "mode": "daily",
  "dry_run": true,
  "executed": false,
  "requested_limit": 100,
  "scanned_count": 500,
  "candidate_count": 100,
  "returned_count": 100,
  "scan_limit": 5000,
  "exhausted_scan": false,
  "missing_only": true,
  "note": "Dry-run only: no GetItem calls and no DB writes were performed."
}
```

Sample candidates:

```json
[
  { "sku": "PMC-23961", "item_id": "206256619150", "title": "Pokémon Card Game Sword &amp; Shield Family Pokémon Card Game" },
  { "sku": "PMC-23907", "item_id": "206256612497", "title": "(5 Boxes) Pokémon TCG Mega Expansion Pack Inferno X Box (30 Packs/Korean Version" },
  { "sku": "PMC-23933", "item_id": "206256616476", "title": "Pokémon TCG XY BREAK Expansion Pack Premium Champion Box (20 Packs)" },
  { "sku": "PMC-23908", "item_id": "206256612579", "title": "Pokémon Card Game V-Max Climax Black Horse Budrex V-Max 2022 UR BRG 8" },
  { "sku": "PMC-23957", "item_id": "206256618633", "title": "(10 Boxes) Pokémon Card Game Scarlet &amp; Violet Expansion Pack Ruler of Dark Flame" },
  { "sku": "PMC-23949", "item_id": "206256617955", "title": "Pokémon TCG Sword &amp; Shield Expansion Pack Rapid Master Box (30 Packs)" },
  { "sku": "PMC-23946", "item_id": "206256617641", "title": "Pokémon TCG Sword &amp; Shield Expansion Paradigm Trigger Box (30 Packs) (Includes P" },
  { "sku": "PMC-23906", "item_id": "206256612415", "title": "(10 Boxes) Pokémon TCG Mega Expansion Pack Inferno X Box (30 Packs/Korean Versio" },
  { "sku": "PMC-23935", "item_id": "206256616666", "title": "Pokémon Card Game 25th Anniversary Promo Mew EX BRG 8" },
  { "sku": "PMC-23942", "item_id": "206256617234", "title": "(30 Boxes) Pokémon TCG Sword &amp; Shield Expansion Pack Perfect Box (30 Packs)" }
]
```

This confirms the selector can skip already-enriched newer rows and still find older missing enrichment candidates inside the bounded scan.

## Status validation

Command:

```bash
npm run hermes:enrich:status
```

Observed status counts:

```json
{
  "listing_details": 230,
  "listing_images": 349,
  "listing_item_specifics": 1154,
  "listing_policies": 230,
  "listing_enrichment_errors": 0
}
```

Observed bounded missing estimate:

```json
{
  "scanned_count": 500,
  "candidate_count": 100,
  "returned_count": 100,
  "scan_limit": 5000,
  "exhausted_scan": false,
  "missing_only": true,
  "note": "Read-only bounded estimate from ebay_products using --scan-limit; values are not an unbounded total."
}
```

Status mode remained read-only and did not call eBay APIs or write to the database.

## Validate result

Command:

```bash
npm run hermes:enrich:validate
```

Observed result:

```json
{
  "mode": "validate",
  "read_only": true,
  "daily_reports_write": false,
  "total_rows": 1963,
  "enrichedListings": 30,
  "needs_data_distribution": {
    "2": 27,
    "3": 62,
    "4": 5,
    "5": 896,
    "6": 9,
    "7": 208,
    "9": 756
  },
  "enrichment_sensitive_score_status_distribution": {
    "image_count_score": { "needs_data": 978, "ok": 3, "partial": 955, "watch": 27 },
    "item_specifics_score": { "needs_data": 1936, "ok": 13, "watch": 14 },
    "shipping_score": { "needs_data": 964, "ok": 998, "watch": 1 },
    "return_policy_score": { "needs_data": 1933, "ok": 30 },
    "category_score": { "needs_data": 1933, "ok": 30 }
  }
}
```

Validate mode confirmed `daily_reports_write: false`.

## Safety validation

Syntax checks run:

```bash
node --check src/services/hermesListingEnrichment.js
node --check scripts/hermes-enrichment-ops.js
node --check src/services/hermesListingIntelligence.js
```

All syntax checks passed.

Safety grep run:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  scripts/hermes-enrichment-ops.js src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js || true

grep -RIn 'callTradingAPI' \
  scripts/hermes-enrichment-ops.js src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js || true
```

Safety grep result:

```text
Prohibited marketplace write APIs: none
Trading API calls:
src/services/hermesListingEnrichment.js:267: ebay.callTradingAPI('GetItem', requestBody)
```

The only Trading API call remains `GetItem`, used only by execute-mode enrichment detail fetches. Phase 4H did not run execute mode.

## git diff stat before commit

```text
scripts/hermes-enrichment-ops.js        |  25 +++--
src/services/hermesListingEnrichment.js | 156 ++++++++++++++++++++++++++------
2 files changed, 149 insertions(+), 32 deletions(-)
```

The final committed diff also includes this documentation file.

## Operational recommendation

Use this read-only check before any execute run:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
```

Proceed to execute only when the dry-run returns expected candidates:

```bash
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only --scan-limit=5000
```

If a future dry-run returns zero:

1. Do not execute blindly.
2. Check `scanned_count`, `scan_limit`, and `exhausted_scan`.
3. If `exhausted_scan` is true, the bounded scan window may be exhausted.
4. Run another read-only dry-run with a deliberately larger scan limit only if operationally justified.
5. Keep scheduler installation as a separate phase; Phase 4H created no scheduler.

## Readiness verdict

Phase 4H passed.

Candidate selection now scans a bounded source window to find missing enrichment rows rather than filtering only the newest limited candidate window. Dry-run and status now expose structured scan metadata so operators can distinguish true exhaustion from a too-small candidate window.
