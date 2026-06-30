# Hermes Phase 4C — Listing Enrichment Smoke Test

Smoke test timestamp: 2026-06-30T16:28:24Z

## Purpose

Phase 4C runs a limited Phase 4 Listing Data Enrichment smoke test after Phase 4B confirmed migration 059 is visible in the active Supabase database.

This phase does not redo Phase 4A or Phase 4B.

Baseline:

```text
029d30c Add Phase 4B migration application report
```

Allowed writes in this phase were limited to internal enrichment cache tables:

- `listing_details`
- `listing_images`
- `listing_item_specifics`
- `listing_policies`
- `listing_enrichment_errors`

No marketplace writes, price changes, inventory changes, listing changes, or AI calls were allowed or performed.

## Files reviewed

- `docs/phase-4b-migration-059-application.md`
- `docs/phase-4-data-enrichment-plan.md`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`

## Pre-counts

Before running enrichment, the five internal enrichment tables were counted through the active Supabase client.

```json
{
  "listing_details": {
    "ok": true,
    "count": 0
  },
  "listing_images": {
    "ok": true,
    "count": 0
  },
  "listing_item_specifics": {
    "ok": true,
    "count": 0
  },
  "listing_policies": {
    "ok": true,
    "count": 0
  },
  "listing_enrichment_errors": {
    "ok": true,
    "count": 0
  }
}
```

## Smoke test command

The limited smoke test command was run exactly as planned:

```bash
npm run hermes:market -- enrich-listings --limit=5 --missing-only
```

## Smoke test result

Result summary:

```json
{
  "requested": 5,
  "enriched": 5,
  "failed": 0,
  "errors": []
}
```

Enriched item ids:

| SKU | itemId | images | item specifics | return policy | shipping policy | categoryId | condition |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `206371786121` | `206371786121` | 1 | 8 | true | true | `261035` | `New/Factory Sealed` |
| `206371776211` | `206371776211` | 2 | 8 | true | true | `261035` | `New/Factory Sealed` |
| `206366929426` | `206366929426` | 4 | 15 | true | true | `183456` | `New/Factory Sealed` |
| `206339123201` | `206339123201` | 6 | 12 | true | true | `261068` | `New` |
| `206339128977` | `206339128977` | 2 | 5 | true | true | `69528` | `New` |

No error messages were returned.

Failure classification:

- API/auth failures: none observed.
- Data failures: none observed.
- Code failures: none observed.

## Post-counts

After the smoke test, the five internal enrichment tables were counted again.

```json
{
  "listing_details": {
    "ok": true,
    "count": 5
  },
  "listing_images": {
    "ok": true,
    "count": 15
  },
  "listing_item_specifics": {
    "ok": true,
    "count": 48
  },
  "listing_policies": {
    "ok": true,
    "count": 5
  },
  "listing_enrichment_errors": {
    "ok": true,
    "count": 0
  }
}
```

Count deltas:

| Table | Pre | Post | Delta |
| --- | ---: | ---: | ---: |
| `listing_details` | 0 | 5 | +5 |
| `listing_images` | 0 | 15 | +15 |
| `listing_item_specifics` | 0 | 48 | +48 |
| `listing_policies` | 0 | 5 | +5 |
| `listing_enrichment_errors` | 0 | 0 | 0 |

Latest `listing_details` rows confirmed the five smoke-test items were written with `last_enriched_at` timestamps.

## Read path verification

A listing evidence read path was run against one enriched SKU to confirm the enrichment cache is readable by Listing Intelligence:

```bash
npm run hermes:market -- listing-evidence --sku=206371786121
```

Observed read-path result:

```json
{
  "sku": "206371786121",
  "score_breakdown": {
    "normalized": 75.3,
    "total": 64,
    "max": 85,
    "needs_data": 2
  },
  "source": "signal_engine",
  "read_only": true,
  "raw_refs": {
    "context_source": "db_fallback",
    "connector_skipped": "read_only",
    "listing_id": "206371786121",
    "enrichment_available": true
  }
}
```

Evidence that enrichment data was used:

- `raw_refs.enrichment_available`: `true`
- item specifics score: `ok`, `8개 specifics`
- shipping score: `ok`, `shipping policy 확인, handling 3일`
- return policy score: `ok`, `Days_30`
- category score: `ok`, populated category name

## Safety audit

Marketplace write API grep was re-run against:

- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`

Prohibited marketplace write API search result:

```text
ReviseFixedPriceItem: none
ReviseInventoryStatus: none
AddFixedPriceItem: none
EndFixedPriceItem: none
VerifyAddFixedPriceItem: none
RelistFixedPriceItem: none
AddItem: none
ReviseItem: none
EndItem: none
```

The only audited Trading API call remains:

```text
src/services/hermesListingEnrichment.js:174: ebay.callTradingAPI('GetItem', requestBody)
```

`GetItem` is read-only.

The smoke test wrote only to the allowed internal enrichment cache tables.

## Syntax validation

Commands run:

```bash
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js
```

All syntax checks passed.

## Readiness verdict

Phase 4 enrichment limited smoke test: passed.

Migration/table readiness: passed.

API/auth readiness for the sampled items: passed.

Code readiness: passed.

Safety constraints: preserved.

Phase 4 enrichment is ready for a larger controlled batch, with the recommended next step being a moderate batch using the same missing-only guard, for example:

```bash
npm run hermes:market -- enrich-listings --limit=25 --missing-only
```

A larger run should continue to monitor `listing_enrichment_errors` and table deltas after completion.
