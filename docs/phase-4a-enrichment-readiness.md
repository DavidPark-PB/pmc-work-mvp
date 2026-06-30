# Hermes Phase 4A — Listing Enrichment Readiness

Readiness timestamp: 2026-06-30T16:16:23Z

## Purpose

Phase 4A verifies whether the existing Phase 4 Listing Data Enrichment implementation is ready to run against the active Supabase database.

This phase does not redo Phase 2 or Phase 3A~3G.

Baseline:

```text
5c07f9c Add Phase 3 final closeout report
```

Existing Phase 4 files reviewed:

- `docs/phase-4-data-enrichment-plan.md`
- `supabase/migrations/059_hermes_listing_enrichment.sql`
- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`

## Migration 059 readiness check

Migration 059 defines the Phase 4 enrichment cache tables:

- `listing_details`
- `listing_images`
- `listing_item_specifics`
- `listing_policies`
- `listing_enrichment_errors`

The active Supabase DB was checked through the existing Supabase client by selecting from each expected table.

Observed result:

```json
{
  "all_applied": false,
  "tables": {
    "listing_details": {
      "applied": false,
      "error": "Could not find the table 'public.listing_details' in the schema cache",
      "code": "PGRST205"
    },
    "listing_images": {
      "applied": false,
      "error": "Could not find the table 'public.listing_images' in the schema cache",
      "code": "PGRST205"
    },
    "listing_item_specifics": {
      "applied": false,
      "error": "Could not find the table 'public.listing_item_specifics' in the schema cache",
      "code": "PGRST205"
    },
    "listing_policies": {
      "applied": false,
      "error": "Could not find the table 'public.listing_policies' in the schema cache",
      "code": "PGRST205"
    },
    "listing_enrichment_errors": {
      "applied": false,
      "error": "Could not find the table 'public.listing_enrichment_errors' in the schema cache",
      "code": "PGRST205"
    }
  }
}
```

Conclusion: migration `059_hermes_listing_enrichment.sql` is not applied in the active Supabase schema cache.

## Can enrichment run now?

No.

Phase 4 enrichment should not be run yet because all required enrichment cache tables are missing from the active database schema cache.

Exact blocker:

```text
PGRST205: Could not find the table 'public.<listing_enrichment_table>' in the schema cache
```

Affected tables:

- `public.listing_details`
- `public.listing_images`
- `public.listing_item_specifics`
- `public.listing_policies`
- `public.listing_enrichment_errors`

If `npm run hermes:market -- enrich-listings ...` runs before migration 059 is applied, it can fetch read-only eBay data but will fail when writing internal enrichment cache rows.

## Safety audit

Files audited:

- `src/services/hermesListingEnrichment.js`
- `src/services/hermesListingIntelligence.js`
- `scripts/hermes-market-intelligence.js`

### Marketplace API usage

The enrichment implementation uses a single eBay Trading API call:

```text
src/services/hermesListingEnrichment.js:174: ebay.callTradingAPI('GetItem', requestBody)
```

`GetItem` is read-only and matches the Phase 4 plan.

### Prohibited marketplace write APIs

Search result for prohibited eBay marketplace write API names:

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

No price/inventory/listing marketplace write workflow names were found in the audited Phase 4 files.

### Internal database writes

The enrichment service does contain internal Supabase writes, but only for the enrichment cache tables defined by migration 059:

- `listing_details` upsert
- `listing_images` delete/insert refresh
- `listing_item_specifics` delete/insert refresh
- `listing_policies` upsert
- `listing_enrichment_errors` insert

These are internal cache writes, not marketplace writes.

`src/services/hermesListingIntelligence.js` also contains an existing `daily_reports` upsert for saved reports. That is outside marketplace execution and is not a price/inventory/listing marketplace write.

## Syntax validation

Commands run:

```bash
node --check src/services/hermesListingEnrichment.js
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js
```

All syntax checks passed.

## Recommended next action

Apply the existing migration before running enrichment:

```text
supabase/migrations/059_hermes_listing_enrichment.sql
```

Do not create a new migration for this blocker. The required migration file already exists.

After migration 059 is applied and Supabase/PostgREST schema cache has refreshed, re-run a Phase 4 readiness check for the five tables. If all tables are present, proceed with a limited enrichment validation such as:

```bash
npm run hermes:market -- enrich-listings --limit=5 --missing-only
```

Only after the limited run succeeds should larger enrichment batches be considered.

## Final readiness verdict

Phase 4 code safety: passed.

Phase 4 DB readiness: blocked.

Enrichment can run now: no.

Required blocker resolution: apply existing migration `059_hermes_listing_enrichment.sql` to the active Supabase database, then re-check table availability before running enrichment.
