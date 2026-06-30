# Hermes Phase 4G — Enrichment Manual Run Validation

Report timestamp: 2026-06-30T17:09:33Z

## Purpose

Phase 4G validates the full manual enrichment operations workflow before any scheduler is installed.

This phase does not redo Phase 4A, 4B, 4C, 4D, 4E, or 4F.

Baseline:

```text
bf907a2 Add Phase 4F enrichment operations runner
```

No cron, macOS LaunchAgent, or automatic scheduler was installed, loaded, created, or enabled.

## Files reviewed before editing

- `git log --oneline -10`
- `docs/phase-4e-enrichment-scale-impact.md`
- `docs/phase-4f-enrichment-operations.md`
- `scripts/hermes-enrichment-ops.js`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `package.json`

## Manual workflow executed

The Phase 4F manual workflow was run only through CLI commands:

```bash
npm run hermes:enrich:status
npm run hermes:enrich:daily -- --dry-run --limit=100
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only
npm run hermes:enrich:validate
npm run hermes:enrich:status
```

Because the dry-run returned 100 candidates, execute mode was allowed to proceed. If the dry-run had returned 0 candidates, execute would have been skipped.

## Pre-status counts

Command:

```bash
npm run hermes:enrich:status
```

Observed pre-status:

```json
{
  "listing_details": 130,
  "listing_images": 249,
  "listing_item_specifics": 654,
  "listing_policies": 130,
  "listing_enrichment_errors": 0,
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

## Dry-run result

Command:

```bash
npm run hermes:enrich:daily -- --dry-run --limit=100
```

Observed dry-run summary:

```json
{
  "mode": "daily",
  "dry_run": true,
  "executed": false,
  "requested_limit": 100,
  "missing_only": true,
  "candidate_count": 100,
  "note": "Dry-run only: no GetItem calls and no DB writes were performed."
}
```

Dry-run sample:

```json
[
  { "sku": "PMC-24068", "item_id": "206257011510", "title": "(30 Boxes) Pokémon Card Game Scarlet &amp; Violet Expansion Pack Black Bolt (20 Pack" },
  { "sku": "PMC-24052", "item_id": "206257009362", "title": "Pokémon Card Game Eevee Heroes Espeon V Special Illustration BRG 8" },
  { "sku": "PMC-24077", "item_id": "206257012033", "title": "(8 Boxes) Pokémon TCG Sword &amp; Shield Enhanced Expansion Pack Eevee Heroes Box (3" },
  { "sku": "PMC-24025", "item_id": "206256996433", "title": "(30 Boxes) Pokémon TCG Sword &amp; Shield Expansion Pack Time Gazer Box (30 Packs)" },
  { "sku": "PMC-24080", "item_id": "206257012745", "title": "(30 Boxes) Pokémon Card Game Scarlet &amp; Violet High Class Pack Terrastal Festa EX" },
  { "sku": "PMC-24035", "item_id": "206256999396", "title": "Pokémon Card Game Scarlet &amp; Violet High Class Pack Terrastal Festa EX Box (10 Pa" },
  { "sku": "PMC-24048", "item_id": "206257006626", "title": "(8 Boxes) Pokémon TCG Sword &amp; Shield Enhancement Expansion Pack Legendary Heartb" },
  { "sku": "PMC-24020", "item_id": "206256995762", "title": "(8 Boxes) Pokémon TCG Sword &amp; Shield Battle Regions Box (20 Packs)" },
  { "sku": "PMC-24031", "item_id": "206256997530", "title": "(30 Boxes) Pokémon Card Game Scarlet &amp; Violet Expansion Pack Super Breaker (30 P" },
  { "sku": "PMC-24049", "item_id": "206257007182", "title": "Pokémon TCG Sword &amp; Shield 25th Anniversary Collection Box (16 Packs)" }
]
```

Dry-run returned 100 candidates, so the candidate window was not exhausted.

## Execute result

Command:

```bash
npm run hermes:enrich:daily -- --execute --limit=100 --missing-only
```

Observed execute summary:

```json
{
  "mode": "daily",
  "dry_run": false,
  "executed": true,
  "requested_limit": 100,
  "missing_only": true,
  "requested": 100,
  "enriched": 100,
  "failed": 0,
  "stopped": false,
  "stop_reason": null,
  "failure_types": [],
  "errors": []
}
```

No eBay auth, rate limit, or API failure occurred.

## Enriched item ids

```text
206257011510
206257009362
206257012033
206256996433
206257012745
206256999396
206257006626
206256995762
206256997530
206257007182
206257008325
206257010775
206256994794
206256620987
206256993962
206256995579
206256993569
206256622505
206256620489
206256621236
206256992258
206256994060
206256992875
206256993679
206256994454
206256995170
206256620308
206256620555
206256992434
206256620619
206256993514
206256995323
206256993183
206256993376
206256994571
206256993735
206256994257
206256993015
206256993122
206256993882
206256992518
206256993327
206256623065
206256623646
206256619578
206256993412
206256995385
206256994493
206256992329
206256620687
206256992621
206256992786
206256619823
206256620399
206256621945
206256995029
206256994321
206256992372
206256994534
206256994409
206256620184
206256617410
206256619014
206256613827
206256616570
206256617557
206256612008
206256615533
206256614355
206256617164
206256618730
206256618269
206256614177
206256612312
206256618047
206256612912
206256615067
206256619221
206256613738
206256613254
206256616092
206256614061
206256616975
206256613138
206256618832
206256619400
206256613084
206256618196
206256619485
206256612972
206256619301
206256611774
206256613319
206256616250
206256617054
206256617755
206256618345
206256613372
206256613537
206256611232
```

## Post-status counts and deltas

Command:

```bash
npm run hermes:enrich:status
```

Observed post-status:

```json
{
  "listing_details": 230,
  "listing_images": 349,
  "listing_item_specifics": 1154,
  "listing_policies": 230,
  "listing_enrichment_errors": 0,
  "newest_last_enriched_at": {
    "sku": "PMC-23894",
    "item_id": "206256611232",
    "last_enriched_at": "2026-06-30T17:09:07.74+00:00"
  },
  "oldest_last_enriched_at": {
    "sku": "206371786121",
    "item_id": "206371786121",
    "last_enriched_at": "2026-06-30T16:27:31.668+00:00"
  },
  "recent_errors": []
}
```

Count deltas:

| Table | Pre | Post | Delta |
| --- | ---: | ---: | ---: |
| `listing_details` | 130 | 230 | +100 |
| `listing_images` | 249 | 349 | +100 |
| `listing_item_specifics` | 654 | 1154 | +500 |
| `listing_policies` | 130 | 230 | +100 |
| `listing_enrichment_errors` | 0 | 0 | 0 |

## Validate summary

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
  }
}
```

Validate mode used `buildListingIntelligenceReport({ days: 30, save: false })` through the operations runner and explicitly reported `daily_reports_write: false`.

## Safety validation

Syntax checks run:

```bash
node --check scripts/hermes-enrichment-ops.js
node --check src/services/hermesListingEnrichment.js
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
src/services/hermesListingEnrichment.js:174: ebay.callTradingAPI('GetItem', requestBody)
```

Safety confirmation:

- No cron installed.
- No macOS LaunchAgent installed or loaded.
- No automatic scheduler created.
- No marketplace writes.
- No price changes.
- No inventory changes.
- No listing revisions.
- No AI calls.
- Internal enrichment cache writes only during execute.
- Validate did not write `daily_reports`.

## Readiness verdict

The full manual enrichment operations workflow passed.

Manual workflow summary:

- Pre-status succeeded.
- Dry-run found 100 candidates and made no writes.
- Execute enriched 100 listings.
- Execute had 0 failures and 0 errors.
- Validate remained read-only and reported `daily_reports_write: false`.
- Post-status confirmed enrichment cache deltas and no error rows.

Recommended next safe adjustment:

- Continue using the same dry-run-first workflow before every manual or scheduled run.
- If a future dry-run returns 0 candidates, skip execute, inspect whether the top candidate window is exhausted, and consider an explicit safe enhancement to the candidate selector/pagination before running larger or all-window operations.
- Scheduler installation should remain a separate phase after manual workflow confidence is sufficient.
