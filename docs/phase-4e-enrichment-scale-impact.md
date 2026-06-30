# Hermes Phase 4E — Enrichment Scale Impact Report

Report timestamp: 2026-06-30T16:50:44Z

## Purpose

Phase 4E runs a larger controlled Listing Data Enrichment scale-up and verifies that enrichment data improves Listing Intelligence output.

This phase does not redo Phase 4A, 4B, 4C, or 4D.

Baseline:

```text
6550a99 Add Phase 4D enrichment controlled batch report
```

Allowed writes in this phase were limited to internal enrichment cache tables:

- `listing_details`
- `listing_images`
- `listing_item_specifics`
- `listing_policies`
- `listing_enrichment_errors`

No marketplace writes, price changes, inventory changes, listing changes, daily report writes, or AI calls were allowed or performed.

## Files reviewed before editing

- `git log --oneline -10`
- `docs/phase-4-data-enrichment-plan.md`
- `docs/phase-4c-enrichment-smoke-test.md`
- `docs/phase-4d-enrichment-controlled-batch.md`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`
- `package.json`

## Pre-check counts

Before the scale-up run, the active Supabase enrichment tables were counted.

```json
{
  "listing_details": { "ok": true, "count": 30 },
  "listing_images": { "ok": true, "count": 43 },
  "listing_item_specifics": { "ok": true, "count": 126 },
  "listing_policies": { "ok": true, "count": 30 },
  "listing_enrichment_errors": { "ok": true, "count": 0 }
}
```

Current DB-enriched listing count before scale-up: `30` rows in `listing_details`.

Read-only Listing Intelligence pre-impact snapshot was also generated through:

```js
buildListingIntelligenceReport({ days: 30, save: false })
```

No `daily_reports` write was performed.

Pre-impact snapshot:

```json
{
  "total": 1963,
  "enrichedListings": 10,
  "improvementCandidates": 1333,
  "titleNeeds": 70,
  "itemSpecificsNeeds": 1333,
  "imageNeeds": 1333,
  "categoryNeeds": 1333,
  "shippingReturnNeeds": 1333,
  "needsDataDistribution": {
    "2": 10,
    "3": 59,
    "4": 5,
    "5": 914,
    "6": 11,
    "7": 208,
    "9": 756
  }
}
```

Pre-impact score status distribution for enrichment-sensitive fields:

```json
{
  "image_count_score": { "needs_data": 980, "partial": 973, "watch": 10 },
  "item_specifics_score": { "needs_data": 1953, "ok": 2, "watch": 8 },
  "shipping_score": { "needs_data": 964, "ok": 998, "watch": 1 },
  "return_policy_score": { "needs_data": 1953, "ok": 10 },
  "category_score": { "needs_data": 1953, "ok": 10 }
}
```

## Scale-up command

```bash
npm run hermes:market -- enrich-listings --limit=100 --missing-only
```

## Scale-up result

Result summary:

```json
{
  "requested": 100,
  "enriched": 100,
  "failed": 0,
  "errors": []
}
```

No eBay auth, rate limit, or API failure occurred.

Failure classification:

- eBay auth failure: none observed.
- eBay rate limit failure: none observed.
- eBay API/data failure: none observed.
- Code failure: none observed.

## Enriched item ids

The scale-up enriched these 100 item ids:

```text
206288364217
206288364166
206288366290
206288372330
206288375702
206288364253
206288364889
206288363715
206288363659
206288363606
206286785601
206286047232
206286078077
206286149904
206284249404
206284230187
206284142714
206284113032
206283722747
206282784631
206282775730
206283694979
206280518940
206278869562
206278858181
206275626659
206275579643
206275621960
206273551911
206273432818
206273477271
206273508304
206273500196
206273483598
206273370214
206273302973
206273369896
206273369517
206273302295
206273370080
206273369430
206273368923
206273369625
206273369355
206273369006
206273302162
206270913055
206270930010
206268979433
206268984768
206268965884
206268825338
206268750918
206266807442
206257266261
206257013652
206257013455
206257013572
206257013411
206257013233
206257013021
206257013517
206257011797
206256995912
206257005988
206256999009
206257011683
206257012828
206257004737
206257010932
206256996607
206256996781
206257010876
206256996338
206257011841
206256996171
206257011157
206256998101
206257012095
206257011907
206257000970
206257005355
206257001611
206257011353
206257012381
206257011741
206257011451
206256999942
206257011400
206257010719
206257011109
206257011572
206257011965
206257004089
206257000396
206257011300
206256997195
206256998584
206257011033
206257011196
```

## Post-counts and deltas

After the scale-up run, the active Supabase enrichment tables were counted again.

```json
{
  "listing_details": { "ok": true, "count": 130 },
  "listing_images": { "ok": true, "count": 249 },
  "listing_item_specifics": { "ok": true, "count": 654 },
  "listing_policies": { "ok": true, "count": 130 },
  "listing_enrichment_errors": { "ok": true, "count": 0 }
}
```

Count deltas:

| Table | Pre | Post | Delta |
| --- | ---: | ---: | ---: |
| `listing_details` | 30 | 130 | +100 |
| `listing_images` | 43 | 249 | +206 |
| `listing_item_specifics` | 126 | 654 | +528 |
| `listing_policies` | 30 | 130 | +100 |
| `listing_enrichment_errors` | 0 | 0 | 0 |

The DB-enriched listing count after scale-up is `130` rows in `listing_details`.

## `listing_enrichment_errors` verification

The error table was queried directly after the scale-up run.

```json
{
  "count": 0,
  "sample": []
}
```

No enrichment errors were recorded, so there are no sample error rows to include.

## Read-only Listing Intelligence impact snapshot

A post-scale read-only impact snapshot was generated through:

```js
buildListingIntelligenceReport({ days: 30, save: false })
```

No `daily_reports` write was performed.

Post-impact snapshot:

```json
{
  "total": 1963,
  "enrichedListings": 20,
  "improvementCandidates": 1333,
  "titleNeeds": 70,
  "itemSpecificsNeeds": 1333,
  "imageNeeds": 1333,
  "categoryNeeds": 1333,
  "shippingReturnNeeds": 1333,
  "needsDataDistribution": {
    "2": 20,
    "3": 59,
    "4": 5,
    "5": 906,
    "6": 9,
    "7": 208,
    "9": 756
  }
}
```

Impact deltas from the read-only Listing Intelligence report:

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Total listing rows analyzed | 1963 | 1963 | 0 |
| Report `enrichedListings` | 10 | 20 | +10 |
| DB `listing_details` rows | 30 | 130 | +100 |
| Needs-data bucket `2` | 10 | 20 | +10 |
| Needs-data bucket `5` | 914 | 906 | -8 |
| Needs-data bucket `6` | 11 | 9 | -2 |

Why DB enrichment grew by +100 but report `enrichedListings` grew by +10:

- `listing_details` records all enriched eBay item ids.
- The Listing Intelligence report analyzes Product Intelligence rows and matches enrichment by the item id that appears in those rows.
- Some enriched eBay listing rows do not currently match the 30-day Product Intelligence report row set or are duplicate SKU/item variants, so they improve the cache but are not all counted in `report.data.summary.enrichedListings` for this read-only snapshot.

Post-impact score status distribution for enrichment-sensitive fields:

```json
{
  "image_count_score": { "needs_data": 978, "ok": 3, "partial": 965, "watch": 17 },
  "item_specifics_score": { "needs_data": 1943, "ok": 7, "watch": 13 },
  "shipping_score": { "needs_data": 964, "ok": 998, "watch": 1 },
  "return_policy_score": { "needs_data": 1943, "ok": 20 },
  "category_score": { "needs_data": 1943, "ok": 20 }
}
```

Observed improvements:

- `return_policy_score.ok`: 10 → 20.
- `category_score.ok`: 10 → 20.
- `item_specifics_score.needs_data`: 1953 → 1943.
- `image_count_score.needs_data`: 980 → 978.
- `image_count_score.ok`: 0 → 3.
- Report rows with only 2 needs-data fields: 10 → 20.

Remaining data gaps:

- `price_position_score` and `competitor_gap_score` still show `needs_data` for 1772 rows because competitor mapping/price comparison remains unavailable for many SKUs.
- Many Product Intelligence rows still do not have a matching enriched listing item id in the 30-day Listing Intelligence row set.
- Image count remains weak for many listings because many active listings genuinely have only 1 image even after enrichment.
- Item specifics remain weak for listings where eBay returned only 0~2 specifics.

## Listing evidence verification for newly enriched SKUs

Listing evidence was run for three newly enriched SKUs.

### SKU `206270913055`

Command:

```bash
npm run hermes:market -- listing-evidence --sku=206270913055
```

Verification:

```json
{
  "raw_refs.enrichment_available": true,
  "image_count_score": { "status": "ok", "reason": "9장" },
  "item_specifics_score": { "status": "ok", "reason": "12개 specifics" },
  "shipping_score": { "status": "ok", "reason": "shipping policy 확인, handling 3일" },
  "return_policy_score": { "status": "ok", "reason": "Days_30" },
  "category_score": { "status": "ok", "reason": "Toys & Hobbies:Action Figures & Accessories:Action Figures" },
  "normalized": 80,
  "needs_data": 2
}
```

### SKU `206257266261`

Command:

```bash
npm run hermes:market -- listing-evidence --sku=206257266261
```

Verification:

```json
{
  "raw_refs.enrichment_available": true,
  "image_count_score": { "status": "ok", "reason": "6장" },
  "item_specifics_score": { "status": "ok", "reason": "31개 specifics" },
  "shipping_score": { "status": "ok", "reason": "무료배송" },
  "return_policy_score": { "status": "ok", "reason": "Days_30" },
  "category_score": { "status": "ok", "reason": "Toys & Hobbies:Action Figures & Accessories:Action Figures" },
  "normalized": 81.2,
  "needs_data": 2
}
```

### SKU `PMC-24120`

Command:

```bash
npm run hermes:market -- listing-evidence --sku=PMC-24120
```

Verification:

```json
{
  "raw_refs.enrichment_available": true,
  "image_count_score": { "status": "watch", "reason": "1장" },
  "item_specifics_score": { "status": "watch", "reason": "2개 specifics" },
  "shipping_score": { "status": "ok", "reason": "shipping policy 확인, handling 3일" },
  "return_policy_score": { "status": "ok", "reason": "Days_30" },
  "category_score": { "status": "ok", "reason": "Collectibles:Animation Art & Merchandise:Animation Merchandise:Other Animation Merchandise" },
  "normalized": 55.3,
  "needs_data": 2
}
```

This confirms Listing Intelligence reads enriched image counts, item specifics, shipping policies, return policies, and categories where available. Some enriched data correctly remains a `watch` signal when the real listing has only one image or very few item specifics.

## Safety audit

Validation commands:

```bash
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js
```

All syntax checks passed.

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
updateItem(...price): none
runAutoRepricer(false): none
pipeline:run_live: none
reprice:approve: none
```

The only audited Trading API call remains:

```text
src/services/hermesListingEnrichment.js:174: ebay.callTradingAPI('GetItem', requestBody)
```

`GetItem` is read-only.

Phase 4E wrote only to the allowed internal enrichment cache tables. It did not perform marketplace writes, price changes, inventory changes, listing changes, daily report writes, or AI calls.

## Readiness verdict

Phase 4E scale-up passed.

Batch summary:

- Requested: 100
- Enriched: 100
- Failed: 0
- Error rows: 0
- DB listing_details rows: 30 → 130
- Read-only report enrichedListings: 10 → 20

Failures are acceptable: yes, because there were no failures.

Phase 4 is ready for scheduled/larger enrichment with safeguards:

1. Continue using `--missing-only` for scheduled runs.
2. Keep batch size controlled and scale gradually.
3. Monitor `listing_enrichment_errors` after each run.
4. Use read-only report generation with `save: false` for validation snapshots unless a phase explicitly allows daily report writes.
5. Preserve the marketplace boundary: `GetItem` read-only only, no price/inventory/listing writes.
