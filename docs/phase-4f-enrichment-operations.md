# Hermes Phase 4F — Enrichment Operations Runner

Report timestamp: 2026-06-30T17:00:44Z

## Purpose

Phase 4F adds a safe operational wrapper for scheduled Listing Data Enrichment use.

This phase does not redo Phase 4A, 4B, 4C, 4D, or 4E.

Baseline:

```text
87c72cb Add Phase 4E enrichment scale impact report
```

The operational runner is intentionally conservative:

- `status` is read-only.
- `daily` defaults to dry-run.
- actual cache writes require `--execute`.
- execute mode defaults to `missing_only: true`.
- `validate` is read-only and uses `buildListingIntelligenceReport({ days: 30, save: false })`.
- no scheduler is installed or enabled automatically.

## Files reviewed before editing

- `git log --oneline -10`
- `docs/phase-4-data-enrichment-plan.md`
- `docs/phase-4d-enrichment-controlled-batch.md`
- `docs/phase-4e-enrichment-scale-impact.md`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`
- `package.json`

## Implementation summary

Created:

```text
scripts/hermes-enrichment-ops.js
```

Updated package scripts:

```json
{
  "hermes:enrich:status": "node scripts/hermes-enrichment-ops.js status",
  "hermes:enrich:daily": "node scripts/hermes-enrichment-ops.js daily",
  "hermes:enrich:validate": "node scripts/hermes-enrichment-ops.js validate"
}
```

Updated `src/services/hermesListingEnrichment.js` only to support the operations wrapper safely:

- exported the existing `getCandidateListings()` helper so dry-run mode can use the same candidate selection path as enrichment.
- added optional `stopOnFailure` support to `enrichListings()` so the operations wrapper can stop a controlled run after the first failure and report it clearly.

No GetItem parsing/fetching logic was duplicated.

## Commands

### Status

```bash
npm run hermes:enrich:status
```

Behavior:

- read-only
- reports cache table counts
- reports newest/oldest `last_enriched_at`
- reports recent enrichment errors sample
- performs no eBay API calls
- performs no DB writes

### Daily dry-run

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100
```

Behavior:

- dry-run is the default even if `--dry-run` is omitted
- candidate discovery only
- no `GetItem` calls
- no DB writes
- returns candidate count and sample

### Daily execute

```bash
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only
```

Behavior:

- actual cache writes require `--execute`
- `missing_only` defaults to true for execute mode
- uses the existing `listingEnrichment.enrichListings()` implementation
- stops after the first item failure through `stopOnFailure: true`
- reports eBay auth/rate/API failures clearly in structured JSON

Allowed writes during execute mode are limited to:

- `listing_details`
- `listing_images`
- `listing_item_specifics`
- `listing_policies`
- `listing_enrichment_errors`

### Validate

```bash
npm run hermes:enrich:validate
```

Behavior:

- read-only
- uses `buildListingIntelligenceReport({ days: 30, save: false })`
- does not write `daily_reports`
- reports total Listing Intelligence rows, enriched listing count, needs-data distribution, and enrichment-sensitive score status distribution

## Recommended daily workflow

Recommended manual workflow before enabling any scheduler:

```bash
npm run hermes:enrich:status
npm run hermes:enrich:daily -- --dry-run --limit=100
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only
npm run hermes:enrich:validate
npm run hermes:enrich:status
```

Recommended operational principle:

1. Run dry-run first.
2. Confirm candidates look expected.
3. Execute a bounded missing-only batch.
4. Check `listing_enrichment_errors` immediately after execution.
5. Run validate in read-only mode to confirm Listing Intelligence still reads cache safely.

## Suggested scheduler guidance

A scheduler can be added later, but Phase 4F did not install or enable one.

Suggested cron-style command after manual validation:

```bash
cd /Users/parksungmin/pmc-work-mvp && npm run hermes:enrich:daily -- --execute --limit=100 --missing-only
```

Suggested macOS LaunchAgent approach:

- create a user LaunchAgent plist outside this phase
- set `WorkingDirectory` to `/Users/parksungmin/pmc-work-mvp`
- run `npm run hermes:enrich:daily -- --execute --limit=100 --missing-only`
- capture stdout/stderr to a log file
- run once manually with `--dry-run` before enabling the agent

Phase 4F intentionally did not create or load a LaunchAgent.

## Safety boundaries

The runner preserves the Phase 4 safety boundary:

- no marketplace write APIs
- no price changes
- no inventory changes
- no listing revisions
- no AI calls
- no `daily_reports` write during validate mode
- execute mode writes only to internal enrichment cache/error tables

The only eBay Trading API method used by the underlying enrichment implementation remains `GetItem`, which is read-only.

## Validation results

### Syntax checks

Commands run:

```bash
node --check scripts/hermes-enrichment-ops.js
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
```

All syntax checks passed.

### Status command

Command:

```bash
npm run hermes:enrich:status
```

Observed result:

```json
{
  "mode": "status",
  "read_only": true,
  "counts": {
    "listing_details": { "ok": true, "count": 130 },
    "listing_images": { "ok": true, "count": 249 },
    "listing_item_specifics": { "ok": true, "count": 654 },
    "listing_policies": { "ok": true, "count": 130 },
    "listing_enrichment_errors": { "ok": true, "count": 0 }
  },
  "newest_last_enriched_at": {
    "sku": "PMC-24062",
    "item_id": "206257011196",
    "last_enriched_at": "2026-06-30T16:50:01.814+00:00"
  },
  "oldest_last_enriched_at": {
    "sku": "206371786121",
    "item_id": "206371786121",
    "last_enriched_at": "2026-06-30T16:27:31.668+00:00"
  },
  "recent_errors": []
}
```

### Daily dry-run command

Command:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=10
```

Observed result:

```json
{
  "mode": "daily",
  "dry_run": true,
  "executed": false,
  "requested_limit": 10,
  "missing_only": true,
  "candidate_count": 0,
  "sample": [],
  "note": "Dry-run only: no GetItem calls and no DB writes were performed."
}
```

The `limit=10` dry-run returned zero candidates because the current top candidate window is already enriched after Phase 4C~4E. This is safe behavior and performed no writes.

### Validate command

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
  "enrichedListings": 20,
  "needs_data_distribution": {
    "2": 20,
    "3": 59,
    "4": 5,
    "5": 906,
    "6": 9,
    "7": 208,
    "9": 756
  },
  "enrichment_sensitive_score_status_distribution": {
    "image_count_score": {
      "needs_data": 978,
      "ok": 3,
      "partial": 965,
      "watch": 17
    },
    "item_specifics_score": {
      "needs_data": 1943,
      "ok": 7,
      "watch": 13
    },
    "shipping_score": {
      "needs_data": 964,
      "ok": 998,
      "watch": 1
    },
    "return_policy_score": {
      "needs_data": 1943,
      "ok": 20
    },
    "category_score": {
      "needs_data": 1943,
      "ok": 20
    }
  }
}
```

Validate mode confirmed `daily_reports_write: false`.

### Safety grep

Command pattern:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  scripts/hermes-enrichment-ops.js src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js || true

grep -RIn 'callTradingAPI' \
  scripts/hermes-enrichment-ops.js src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js || true
```

Result:

```text
Prohibited marketplace write APIs: none
Trading API calls:
src/services/hermesListingEnrichment.js:174: ebay.callTradingAPI('GetItem', requestBody)
```

## Phase 4F readiness verdict

Phase 4F passed.

The project now has a safe operational enrichment wrapper for scheduled use, but no scheduler has been installed or enabled. The recommended next step is to run the manual dry-run-first workflow a few times before installing a cron job or macOS LaunchAgent.
