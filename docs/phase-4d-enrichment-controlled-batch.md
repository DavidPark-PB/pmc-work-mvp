# Hermes Phase 4D — Listing Enrichment Controlled Batch

Batch timestamp: 2026-06-30T16:35:34Z

## Purpose

Phase 4D runs a larger controlled Phase 4 Listing Data Enrichment batch after Phase 4C proved the limited smoke test path.

This phase does not redo Phase 4A~4C.

Baseline:

```text
203e3c0 Add Phase 4C enrichment smoke test report
```

Allowed writes in this phase were limited to internal enrichment cache tables:

- `listing_details`
- `listing_images`
- `listing_item_specifics`
- `listing_policies`
- `listing_enrichment_errors`

No marketplace writes, price changes, inventory changes, listing changes, or AI calls were allowed or performed.

## Files reviewed

- `docs/phase-4c-enrichment-smoke-test.md`
- `docs/phase-4-data-enrichment-plan.md`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`

## Pre-counts

Before the controlled batch, the five internal enrichment tables were counted through the active Supabase client.

```json
{
  "listing_details": { "ok": true, "count": 5 },
  "listing_images": { "ok": true, "count": 15 },
  "listing_item_specifics": { "ok": true, "count": 48 },
  "listing_policies": { "ok": true, "count": 5 },
  "listing_enrichment_errors": { "ok": true, "count": 0 }
}
```

## Controlled batch command

```bash
npm run hermes:market -- enrich-listings --limit=25 --missing-only
```

## Controlled batch result

Result summary:

```json
{
  "requested": 25,
  "enriched": 25,
  "failed": 0,
  "errors": []
}
```

Enriched item ids:

| SKU | itemId | images | specifics | return policy | shipping policy | categoryId | condition |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `206332929888` | `206332929888` | 1 | 15 | true | true | `183456` | `New/Factory Sealed` |
| `206315990948` | `206315990948` | 2 | 3 | true | true | `261068` | `New` |
| `OPK-PR-002` | `206303569272` | 3 | 4 | true | true | `183456` | `New/Factory Sealed` |
| `PMC-24149` | `206288374284` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24143` | `206288371766` | 1 | 2 | true | true | `69528` | `New` |
| `PMC-24126` | `206288365246` | 1 | 2 | true | true | `35190` | `New` |
| `PMC-24118` | `206288363993` | 1 | 2 | true | true | `177015` | `New` |
| `PMC-24139` | `206288369786` | 1 | 2 | true | true | `69528` | `New` |
| `PMC-24127` | `206288365474` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24132` | `206288366958` | 1 | 3 | true | true | `177793` | `New` |
| `PMC-24128` | `206288365710` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24133` | `206288367387` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24138` | `206288369384` | 1 | 2 | true | true | `69528` | `New` |
| `PMC-24123` | `206288364474` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24154` | `206288376701` | 1 | 2 | true | true | `261659` | `New` |
| `PMC-24135` | `206288368172` | 1 | 3 | true | true | `4098` | `New` |
| `PMC-24136` | `206288368534` | 1 | 3 | true | true | `35856` | `New` |
| `PMC-24142` | `206288371278` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24122` | `206288364418` | 1 | 2 | true | true | `69528` | `New` |
| `PMC-24146` | `206288373091` | 1 | 2 | true | true | `13843` | `New` |
| `PMC-24141` | `206288370789` | 1 | 2 | true | true | `178050` | `New` |
| `PMC-24124` | `206288364589` | 1 | 3 | true | true | `69528` | `New` |
| `PMC-24137` | `206288368890` | 1 | 3 | true | true | `1377` | `New` |
| `PMC-24129` | `206288365969` | 1 | 2 | true | true | `69528` | `New` |
| `PMC-24140` | `206288370359` | 1 | 3 | true | true | `69528` | `New` |

No error messages were returned.

Failure classification:

- API/auth failures: none observed.
- Data failures: none observed.
- Code failures: none observed.
- Acceptability: fully acceptable; the batch had zero failed items and zero enrichment error rows.

## Post-counts and deltas

After the controlled batch, the five internal enrichment tables were counted again.

```json
{
  "listing_details": { "ok": true, "count": 30 },
  "listing_images": { "ok": true, "count": 43 },
  "listing_item_specifics": { "ok": true, "count": 126 },
  "listing_policies": { "ok": true, "count": 30 },
  "listing_enrichment_errors": { "ok": true, "count": 0 }
}
```

Count deltas:

| Table | Pre | Post | Delta |
| --- | ---: | ---: | ---: |
| `listing_details` | 5 | 30 | +25 |
| `listing_images` | 15 | 43 | +28 |
| `listing_item_specifics` | 48 | 126 | +78 |
| `listing_policies` | 5 | 30 | +25 |
| `listing_enrichment_errors` | 0 | 0 | 0 |

## `listing_enrichment_errors` verification

The error table was queried directly after the run.

```json
{
  "count": 0,
  "rows": []
}
```

No enrichment errors were recorded.

## Read path verification

Listing evidence was run on one newly enriched SKU:

```bash
npm run hermes:market -- listing-evidence --sku=206332929888
```

Observed read-path result:

```json
{
  "sku": "206332929888",
  "score_breakdown": {
    "normalized": 75.3,
    "total": 64,
    "max": 85,
    "needs_data": 2,
    "scores": {
      "item_specifics_score": {
        "points": 10,
        "status": "ok",
        "reason": "15개 specifics"
      },
      "shipping_score": {
        "points": 10,
        "status": "ok",
        "reason": "shipping policy 확인, handling 3일"
      },
      "return_policy_score": {
        "points": 5,
        "status": "ok",
        "reason": "Days_30"
      },
      "category_score": {
        "points": 5,
        "status": "ok",
        "reason": "Toys & Hobbies:Collectible Card Games:CCG Sealed Packs"
      }
    }
  },
  "source": "signal_engine",
  "read_only": true,
  "raw_refs": {
    "context_source": "db_fallback",
    "connector_skipped": "read_only",
    "listing_id": "206332929888",
    "enrichment_available": true
  }
}
```

Evidence that enrichment data was used:

- `raw_refs.enrichment_available`: `true`
- `item_specifics_score`: `ok`, `15개 specifics`
- `shipping_score`: `ok`, `shipping policy 확인, handling 3일`
- `return_policy_score`: `ok`, `Days_30`
- `category_score`: `ok`, populated eBay category path

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

The controlled batch wrote only to allowed internal enrichment cache tables.

## Syntax validation

Commands run:

```bash
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js
```

All syntax checks passed.

## Readiness verdict

Phase 4D controlled batch: passed.

Batch success/failure summary:

- Requested: 25
- Enriched: 25
- Failed: 0
- Error rows: 0

Failures are acceptable: yes, because there were no failures.

Phase 4 is ready for scheduled or larger enrichment, with operational safeguards:

1. Continue using `--missing-only` for routine runs.
2. Increase gradually from 25 to larger batches.
3. Monitor `listing_enrichment_errors` after every run.
4. Continue enforcing the read-only marketplace boundary; only internal enrichment cache writes are permitted.
