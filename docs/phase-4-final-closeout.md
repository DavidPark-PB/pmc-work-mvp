# Hermes Phase 4 Final Closeout — Listing Data Enrichment

Report timestamp: 2026-06-30T17:23:47Z

## Purpose

This document closes out Hermes Phase 4: Listing Data Enrichment.

Phase 4 added a read-only eBay listing detail enrichment cache, validated it in progressively larger batches, added a safe operations wrapper, verified manual operations, and hardened candidate discovery for future dry-run-first operations.

This closeout does not redo Phase 4A, 4B, 4C, 4D, 4E, 4F, 4G, or 4H.

Baseline:

```text
3ca9023 Add Phase 4H enrichment candidate selector hardening
```

## Closeout safety constraints

The Phase 4 final closeout used read-only validation only.

No execute-mode enrichment was run in this closeout.

Explicitly not performed:

- No cron installed.
- No macOS LaunchAgent installed or loaded.
- No automatic scheduler created.
- No marketplace writes.
- No price changes.
- No inventory changes.
- No listing revisions.
- No AI calls.

## Files reviewed before closeout

- `git log --oneline -15`
- `docs/phase-4-data-enrichment-plan.md`
- `docs/phase-4a-enrichment-readiness.md`
- `docs/phase-4b-migration-059-application.md`
- `docs/phase-4c-enrichment-smoke-test.md`
- `docs/phase-4d-enrichment-controlled-batch.md`
- `docs/phase-4e-enrichment-scale-impact.md`
- `docs/phase-4f-enrichment-operations.md`
- `docs/phase-4g-enrichment-manual-run-validation.md`
- `docs/phase-4h-enrichment-candidate-selector-hardening.md`
- `scripts/hermes-enrichment-ops.js`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `package.json`

## Phase 4 timeline A-H

| Phase | Commit | Summary | Outcome |
| --- | --- | --- | --- |
| Phase 4A | `14afabd Add Phase 4A enrichment readiness report` | Checked existing Phase 4 implementation and active Supabase schema readiness. Migration 059 tables were missing. | Blocked until migration 059 was applied. Code safety passed. |
| Phase 4B | `029d30c Add Phase 4B migration application report` | Verified existing migration `059_hermes_listing_enrichment.sql` was applied externally by the operator/user. | All five enrichment tables became visible. Ready for smoke test. |
| Phase 4C | `203e3c0 Add Phase 4C enrichment smoke test report` | Ran limited enrichment smoke test with 5 listings. | 5 enriched, 0 failed, error rows 0. Read path verified. |
| Phase 4D | `6550a99 Add Phase 4D enrichment controlled batch report` | Ran controlled batch of 25 listings. | 25 enriched, 0 failed, error rows 0. Read path verified. |
| Phase 4E | `87c72cb Add Phase 4E enrichment scale impact report` | Ran scale-up batch of 100 listings and measured Listing Intelligence impact. | DB `listing_details` 30 → 130, report `enrichedListings` 10 → 20, error rows 0. |
| Phase 4F | `bf907a2 Add Phase 4F enrichment operations runner` | Added safe operations wrapper commands: status, daily dry-run/execute, validate. | Dry-run-first operations path created; no scheduler installed. |
| Phase 4G | `05ab793 Add Phase 4G enrichment manual run validation` | Validated full manual workflow. | Dry-run found 100 candidates, execute enriched 100, DB `listing_details` 130 → 230, error rows 0. No scheduler installed. |
| Phase 4H | `3ca9023 Add Phase 4H enrichment candidate selector hardening` | Hardened candidate discovery with bounded scan metadata to avoid false-zero dry-runs. | Dry-run can scan older rows safely; status exposes bounded missing candidate estimate. |

## Final read-only validation commands

The closeout ran these read-only validation commands:

```bash
npm run hermes:enrich:status -- --scan-limit=5000
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
npm run hermes:enrich:validate
```

Syntax/safety checks:

```bash
node --check scripts/hermes-enrichment-ops.js
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
```

Safety grep:

```bash
grep -RInE 'ReviseFixedPriceItem|ReviseInventoryStatus|AddFixedPriceItem|EndFixedPriceItem|VerifyAddFixedPriceItem|RelistFixedPriceItem|AddItem|ReviseItem|EndItem|updateItem\(.*price|runAutoRepricer\(false\)|pipeline:run_live|reprice:approve' \
  scripts/hermes-enrichment-ops.js src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js || true

grep -RIn 'callTradingAPI' \
  scripts/hermes-enrichment-ops.js src/services/hermesListingEnrichment.js src/services/hermesListingIntelligence.js scripts/hermes-market-intelligence.js || true
```

## Final cache table counts

Command:

```bash
npm run hermes:enrich:status -- --scan-limit=5000
```

Observed final cache counts:

```json
{
  "listing_details": { "ok": true, "count": 230 },
  "listing_images": { "ok": true, "count": 349 },
  "listing_item_specifics": { "ok": true, "count": 1154 },
  "listing_policies": { "ok": true, "count": 230 },
  "listing_enrichment_errors": { "ok": true, "count": 0 }
}
```

Newest enriched row:

```json
{
  "sku": "PMC-23894",
  "item_id": "206256611232",
  "last_enriched_at": "2026-06-30T17:09:07.74+00:00"
}
```

Oldest enriched row:

```json
{
  "sku": "206371786121",
  "item_id": "206371786121",
  "last_enriched_at": "2026-06-30T16:27:31.668+00:00"
}
```

Recent enrichment errors:

```json
[]
```

## Final bounded missing-candidate visibility

Status mode now includes a bounded, read-only missing enrichment estimate.

Observed result:

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

Interpretation:

- At least 100 missing enrichment candidates were found inside a 500-row scan.
- The configured scan boundary was 5000 rows.
- The scan was not exhausted.
- This is not an unbounded total; it is an operational estimate for dry-run-first decisions.

## Final dry-run candidate metadata

Command:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
```

Observed dry-run output:

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

Sample candidates from the final dry-run:

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

The final dry-run made no eBay API calls and no database writes.

## Final validate summary

Command:

```bash
npm run hermes:enrich:validate
```

Observed validate result:

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
    "image_count_score": {
      "needs_data": 978,
      "ok": 3,
      "partial": 955,
      "watch": 27
    },
    "item_specifics_score": {
      "needs_data": 1936,
      "ok": 13,
      "watch": 14
    },
    "shipping_score": {
      "needs_data": 964,
      "ok": 998,
      "watch": 1
    },
    "return_policy_score": {
      "needs_data": 1933,
      "ok": 30
    },
    "category_score": {
      "needs_data": 1933,
      "ok": 30
    }
  },
  "summary": {
    "total": 1963,
    "enrichedListings": 30,
    "improvementCandidates": 1333,
    "titleNeeds": 70,
    "itemSpecificsNeeds": 1333,
    "imageNeeds": 1333,
    "categoryNeeds": 1333,
    "shippingReturnNeeds": 1333,
    "cheaperNoSales": 180,
    "expensiveButSelling": 0,
    "deadStockPriority": 305,
    "dataPoor": 964,
    "productSummary": {
      "listingQualityCandidates": 58,
      "deadStockCandidates": 305,
      "dataGaps": 964,
      "priceOrMarginReviews": 6
    }
  }
}
```

Validate used `buildListingIntelligenceReport({ days: 30, save: false })` through the operations wrapper and confirmed `daily_reports_write: false`.

## Syntax and safety check results

Syntax checks passed:

```bash
node --check scripts/hermes-enrichment-ops.js
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
```

Safety grep result:

```text
Prohibited marketplace write APIs: none
Trading API calls:
src/services/hermesListingEnrichment.js:267: ebay.callTradingAPI('GetItem', requestBody)
```

`GetItem` is the only audited Trading API call and is read-only.

## Operational commands

Read-only status with bounded missing-candidate visibility:

```bash
npm run hermes:enrich:status -- --scan-limit=5000
```

Read-only dry-run before any execute:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
```

Explicit manual execute, only after reviewing dry-run output:

```bash
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only --scan-limit=5000
```

Read-only validation snapshot:

```bash
npm run hermes:enrich:validate
```

Recommended manual workflow:

```bash
npm run hermes:enrich:status -- --scan-limit=5000
npm run hermes:enrich:daily -- --dry-run --limit=100 --scan-limit=5000
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only --scan-limit=5000
npm run hermes:enrich:validate
npm run hermes:enrich:status -- --scan-limit=5000
```

## Scheduler recommendation

A scheduler was not installed in Phase 4.

No cron job was created.

No macOS LaunchAgent was created, loaded, or installed.

If scheduling is added in a future phase, it should be explicitly approval-gated by the operator and should retain the Phase 4 dry-run-first pattern:

1. Run read-only status.
2. Run read-only dry-run with `--scan-limit=5000`.
3. Execute only a bounded missing-only batch if the dry-run output is expected.
4. Validate with `save:false`.
5. Monitor `listing_enrichment_errors` immediately after each run.

A future scheduler command, if explicitly approved later, should use the same safe manual execute shape:

```bash
cd /Users/parksungmin/pmc-work-mvp && npm run hermes:enrich:daily -- --execute --limit=100 --missing-only --scan-limit=5000
```

But this closeout did not install or enable that scheduler.

## Exact safety boundary

Allowed:

- eBay Trading API `GetItem` for read-only listing detail collection.
- Internal enrichment cache writes only through explicit execute mode.
- Internal cache/error tables:
  - `listing_details`
  - `listing_images`
  - `listing_item_specifics`
  - `listing_policies`
  - `listing_enrichment_errors`
- Read-only validation via `npm run hermes:enrich:validate`, which must use `save:false`.

Forbidden:

- eBay marketplace write APIs.
- Price changes.
- Inventory changes.
- Listing revisions.
- Automatic marketplace execution.
- AI calls inside enrichment operations.
- Automatic scheduler installation without a separate explicit phase.

No prohibited marketplace write APIs were found in the audited Phase 4 files.

## Remaining risks and known limits

1. Remaining enrichment backlog exists: the final dry-run found 100 more missing candidates inside a bounded 500-row scan.
2. `scanLimit` is bounded intentionally and is not a total-count query. A larger read-only scan may find additional missing rows, but it should be chosen deliberately.
3. Many listings genuinely have sparse source data. Some enriched rows still score as `watch` when eBay returns one image or few item specifics.
4. Listing Intelligence report `enrichedListings` can differ from DB `listing_details` count because the report analyzes the Product Intelligence row set and matches by item id. The DB cache may contain enriched item ids outside the current 30-day report set.
5. Competitor mapping remains a major data gap. Price position and competitor gap scores still show many `needs_data` rows.
6. `GetItem` depends on eBay credentials and Trading API availability. Auth/rate/API failures should stop bounded operations and be documented rather than retried with larger batches.
7. Scheduler operation has not been validated because no scheduler was installed; only manual operations were validated.

## Phase 5 readiness

Phase 4 is ready to close.

Readiness evidence:

- Migration 059 is applied and all five cache tables are visible.
- Smoke, controlled, scale, and manual operations runs succeeded with 0 enrichment error rows.
- Final cache state is healthy: 230 listing detail cache rows and 0 error rows.
- Listing Intelligence reads enrichment cache and reports `enrichedListings: 30` in the current 30-day report set.
- Operations wrapper supports read-only status, dry-run, validate, and explicit execute.
- Candidate selection no longer falsely stops at the newest enriched window.
- Safety checks passed and no prohibited marketplace write APIs were found.

## Phase 5 recommendation

Phase 5 should implement approval-gated execution only.

Phase 5 must not introduce direct automatic marketplace writes.

Recommended Phase 5 direction:

- Keep Hermes as analysis/recommendation-first.
- Generate execution plans in code where possible.
- Require explicit human approval before any external write.
- Separate approval state from execution state.
- Keep marketplace execution behind a narrow, auditable command path.
- Start with dry-run/plan output before any real action.
- Preserve the established boundary: no automatic price, inventory, or listing changes.

## Final closeout verdict

Phase 4 Listing Data Enrichment is complete.

The system is ready for Phase 5 planning under an approval-gated execution model.
