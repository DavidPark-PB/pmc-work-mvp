# Hermes Phase 13I — Evidence Cache Batch Expansion

## Scope

Phase 13I expands cached read-only eBay listing evidence beyond the first five Phase 13F items.

Baseline:

```text
c19166e Add Phase 13H listing quality scoring calibration audit
```

Phase 13I does not redo Phase 13H.

## Hard boundary

Allowed in this phase:

- read-only eBay Trading API `GetItem`
- internal evidence-cache writes only in explicit `--write` mode

Internal evidence cache tables written by explicit write mode:

- `listing_details`
- `listing_item_specifics`
- `listing_images`

Disallowed:

- `ReviseFixedPriceItem`
- marketplace write APIs
- marketplace listing modification
- price / inventory / quantity changes
- opportunity creation
- packet creation
- approval / execution request creation
- execution-state mutation
- push

## Exclusion policy

The batch selector excludes:

- `item_id=202551129453`
- already executed listings through the evidence refresh planner path
- previous `marketplace_execution_completed` items through the existing selector/guard policy
- the five Phase 13F cached evidence rows because the evidence refresh planner no longer reports them as missing cached listing-quality evidence

Phase 13F cached item ids excluded by missing-evidence state:

```text
206284113032
206284142714
206284230187
206284249404
206286078077
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
```

Changes:

- Raised unscoped evidence-fetch batch cap from 5 to 10.
- Raised item-id normalization cap from 5 to 10.
- Updated fetch scope metadata to report `max_items: 10`.
- Added fetch scope flags for already-cached/missing-evidence-plan exclusion and previous marketplace execution exclusion.
- Marked `get_item_called=true` when the read-only `GetItem` call is actually made.
- Kept write mode limited to existing evidence-cache upserts.
- Increased scorer capacity so opportunity preview can score more than ten cached item ids when requested.

## Dry-run evidence fetch

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=10 --dry-run
```

Observed source summary before write:

```json
{
  "active_ebay_capable_listings_found": 50,
  "listings_missing_cached_item_id": 0,
  "listings_missing_cached_title_evidence": 0,
  "listings_missing_listing_quality_evidence": 45,
  "evidence_refresh_candidates": 45,
  "execution_candidates": 0,
  "safe_candidates_for_read_only_evidence_refresh": 45
}
```

Selected next 10 items:

```text
206315990948
206332929888
206339123201
206339128977
206366929426
206371776211
206371786121
206387679082
206286149904
206283722747
```

Dry-run fetch result:

```json
{
  "candidate_count": 10,
  "fetched_count": 10,
  "failed_count": 0,
  "partial_failure": false,
  "blocker": null,
  "actual_read_only_ebay_call": true,
  "get_item_called": true,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false
}
```

Note: the first dry-run detected an expired/invalid eBay token and the existing `EbayAPI` token maintenance path refreshed and saved the token through `tokenStore`. No evidence cache write, opportunity write, packet write, approval write, execution-state write, or marketplace write occurred in dry-run.

## Write evidence fetch

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=10 --write
```

Observed summary:

```json
{
  "candidate_count": 10,
  "fetched_count": 10,
  "failed_count": 0,
  "partial_failure": false,
  "blocker": null,
  "actual_read_only_ebay_call": true,
  "get_item_called": true,
  "actual_database_write": true,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "ebay_write_api_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false
}
```

Write results:

```json
[
  { "item_id": "206315990948", "listing_details_written": true, "item_specifics_upserted": 3, "images_upserted": 2 },
  { "item_id": "206332929888", "listing_details_written": true, "item_specifics_upserted": 15, "images_upserted": 1 },
  { "item_id": "206339123201", "listing_details_written": true, "item_specifics_upserted": 12, "images_upserted": 6 },
  { "item_id": "206339128977", "listing_details_written": true, "item_specifics_upserted": 5, "images_upserted": 2 },
  { "item_id": "206366929426", "listing_details_written": true, "item_specifics_upserted": 15, "images_upserted": 4 },
  { "item_id": "206371776211", "listing_details_written": true, "item_specifics_upserted": 8, "images_upserted": 2 },
  { "item_id": "206371786121", "listing_details_written": true, "item_specifics_upserted": 8, "images_upserted": 1 },
  { "item_id": "206387679082", "listing_details_written": true, "item_specifics_upserted": 20, "images_upserted": 1 },
  { "item_id": "206286149904", "listing_details_written": true, "item_specifics_upserted": 5, "images_upserted": 14 },
  { "item_id": "206283722747", "listing_details_written": true, "item_specifics_upserted": 4, "images_upserted": 3 }
]
```

All write rows use source `ebay_get_item_read_only` in cache records and were produced from successful read-only `GetItem` results.

## Opportunity preview after write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=20 --dry-run
```

Observed output:

```json
{
  "read_only": true,
  "dry_run": true,
  "operation": "listing_quality_opportunity_preview",
  "limit": 20,
  "scanned_count": 10,
  "low_quality_count": 0,
  "opportunities": [],
  "eligible_opportunity": null,
  "recommendation": "No eligible listing_quality_low opportunity found from cached evidence. Do not force a candidate."
}
```

No low-quality listing was previewed from the newly cached batch. Combined with the Phase 13H result for the first five cached evidence rows, no candidate emerged from the 15 total Phase 13F + Phase 13I cached evidence items.

## Next-candidate selector after write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed result remains safe:

```json
{
  "ranked_candidates": [],
  "selected_candidate": null,
  "completed_marketplace_item_ids": ["202551129453"],
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/api/ebayAPI.js
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=10 --dry-run
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=10 --write
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=20 --dry-run
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Safety validation

Evidence write mode safety output confirmed:

```json
{
  "actual_read_only_ebay_call": true,
  "get_item_called": true,
  "actual_database_write": true,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "ebay_write_api_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false
}
```

The database write in write mode was limited to the internal evidence-cache tables:

- `listing_details`
- `listing_item_specifics`
- `listing_images`

Opportunity preview and next-candidate selector reported:

```json
{
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false
}
```

Safety grep was run on changed files and diff-only additions. Diff-only grep showed no new `ReviseFixedPriceItem`, marketplace write API, opportunity creation, packet creation, approval creation, or execution-state mutation path. Existing historical shared-service references remain from earlier phases. The only intended Phase 13I read call remains `callTradingAPI('GetItem', ...)`, inherited from Phase 13E evidence fetch.

## Final Phase 13I state

```json
{
  "batch_fetch_limit": 10,
  "new_items_fetched": 10,
  "new_items_written_to_internal_evidence_cache": 10,
  "total_phase_13_cached_evidence_items_considered": 15,
  "low_quality_count_after_new_batch": 0,
  "eligible_opportunity": null,
  "selected_candidate": null,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "phase_12_item_reused": false
}
```
