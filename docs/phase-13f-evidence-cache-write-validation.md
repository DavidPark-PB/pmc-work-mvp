# Hermes Phase 13F — Listing Evidence Cache Write Validation

Report timestamp: 2026-07-03T10:52:28Z

## Scope

Phase 13F persists the Phase 13E read-only eBay `GetItem` evidence for five explicitly scoped listings into internal evidence cache tables only.

Baseline:

```text
d4aade7 Add Phase 13E read-only listing evidence fetch
```

Phase 13F does not redo Phase 13E.

## Hard boundary

Phase 13F allows only:

- read-only eBay Trading API `GetItem`
- internal evidence-cache upserts to existing listing evidence tables

Phase 13F does not:

- call `ReviseFixedPriceItem`
- call eBay write APIs
- modify eBay listings
- create opportunities
- create packets
- create approvals / execution requests
- update execution state
- mark marketplace execution
- change price, inventory, quantity, or listing content
- push commits

## Target item ids

```text
206284113032
206284142714
206284230187
206284249404
206286078077
```

Excluded from scope:

```text
202551129453
```

## Pre-edit read status

Required context was read before editing:

- `git log --oneline -18`
- `docs/phase-13e-read-only-evidence-fetch.md`
- `docs/phase-13d-evidence-refresh-eligibility.md`
- `src/services/hermesExecutionApproval.js`
- `src/api/ebayAPI.js`
- `scripts/hermes-agent.js`

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added deterministic item-id scoped support to the existing Phase 13E command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --write
```

Implementation details:

- `--item-ids` accepts a comma-separated list.
- Scope is capped to max five item ids.
- Item id `202551129453` is always excluded.
- Item-id scoped mode resolves targets from the Phase 13D evidence refresh planner listings, not only current missing-evidence candidates. This keeps the command idempotent after cache persistence, because the same item ids may no longer be evidence-refresh candidates once their evidence is written.
- Write mode upserts only internal cache rows for successful read-only `GetItem` results.

Internal cache tables written:

- `listing_details`
- `listing_item_specifics`
- `listing_images`

Evidence fields persisted or represented in cache:

- item id
- title
- description presence/length through `raw_data.Description`
- item specifics presence/count through `listing_item_specifics`
- picture count through `listing_images` and `listing_details.image_count`
- category id/name
- listing status
- fetched timestamp through `listing_details.last_enriched_at` and `raw_data.fetched_at`
- source `ebay_get_item_read_only`

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "candidate_count": 5,
  "requested_item_ids": [
    "206284113032",
    "206284142714",
    "206284230187",
    "206284249404",
    "206286078077"
  ],
  "missing_requested_item_ids": [],
  "item_id_scoped": true,
  "fetched_count": 5,
  "failed_count": 0,
  "actual_read_only_ebay_call": true,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false
}
```

All five read-only `GetItem` fetches returned `Ack=Success` and `errors=[]`.

## Write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --write
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": false,
  "candidate_count": 5,
  "fetched_count": 5,
  "failed_count": 0,
  "partial_failure": false,
  "blocker": null,
  "actual_read_only_ebay_call": true,
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

Write result counts:

```json
[
  { "item_id": "206284113032", "item_specifics_upserted": 16, "images_upserted": 2 },
  { "item_id": "206284142714", "item_specifics_upserted": 16, "images_upserted": 1 },
  { "item_id": "206284230187", "item_specifics_upserted": 16, "images_upserted": 2 },
  { "item_id": "206284249404", "item_specifics_upserted": 8, "images_upserted": 5 },
  { "item_id": "206286078077", "item_specifics_upserted": 3, "images_upserted": 5 }
]
```

## Evidence cache verification

A direct Supabase read verified all five target item ids after write.

Summary:

```json
{
  "item_count": 5,
  "all_listing_details_exist": true,
  "all_source_read_only": true,
  "all_fetched_at_present": true,
  "target_opportunities_count": 0,
  "target_packets_count": 0,
  "target_execution_requests_count": 0,
  "no_opportunity_created_for_targets": true,
  "no_packet_created_for_targets": true,
  "no_approval_or_execution_request_created_for_targets": true
}
```

Per-item cache verification:

```json
[
  {
    "item_id": "206284113032",
    "source_api": "ebay_get_item_read_only",
    "description_present": true,
    "description_length": 4695,
    "item_specifics_count": 16,
    "picture_count": 2,
    "category_id": "261044",
    "listing_status": "Active"
  },
  {
    "item_id": "206284142714",
    "source_api": "ebay_get_item_read_only",
    "description_present": true,
    "description_length": 4687,
    "item_specifics_count": 16,
    "picture_count": 1,
    "category_id": "261044",
    "listing_status": "Active"
  },
  {
    "item_id": "206284230187",
    "source_api": "ebay_get_item_read_only",
    "description_present": true,
    "description_length": 4701,
    "item_specifics_count": 16,
    "picture_count": 2,
    "category_id": "261044",
    "listing_status": "Active"
  },
  {
    "item_id": "206284249404",
    "source_api": "ebay_get_item_read_only",
    "description_present": true,
    "description_length": 8437,
    "item_specifics_count": 8,
    "picture_count": 5,
    "category_id": "38583",
    "listing_status": "Active"
  },
  {
    "item_id": "206286078077",
    "source_api": "ebay_get_item_read_only",
    "description_present": true,
    "description_length": 11542,
    "item_specifics_count": 3,
    "picture_count": 5,
    "category_id": "117385",
    "listing_status": "Active"
  }
]
```

## Packet id 1 duplicate guard verification

Direct read verified the previously executed Phase 12 artifact remains executed and blocked from reuse:

```json
{
  "packet_id_1": {
    "id": 1,
    "request_id": 1,
    "item_id": "202551129453",
    "status": "packet_recorded",
    "confirmation_status": "confirmed"
  },
  "request_id_1": {
    "id": 1,
    "status": "executed",
    "executed_at": "2026-07-02T14:58:01.356",
    "execution_result_present": true
  },
  "packet_1_remains_executed_and_blocked_from_reuse": true
}
```

## Evidence refresh planner after write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-plan --limit=50
```

Observed totals:

```json
{
  "active_ebay_capable_listings_found": 50,
  "listings_missing_cached_item_id": 0,
  "listings_missing_cached_title_evidence": 0,
  "listings_missing_listing_quality_evidence": 45,
  "listings_excluded_already_executed": 0,
  "listings_with_price_inventory_signals": 50,
  "listings_excluded_price_inventory_signals_dominate": 0,
  "evidence_refresh_candidates": 45,
  "execution_candidates": 0,
  "safe_candidates_for_read_only_evidence_refresh": 45
}
```

The missing listing-quality evidence count dropped from 50 to 45 after persisting the five fetched listings.

Execution candidates remained 0. This is acceptable and was not forced.

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
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --write
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-plan --limit=50
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Evidence cache verification was performed with direct Supabase reads of `listing_details`, `listing_item_specifics`, `listing_images`, `opportunity_inbox`, `hermes_ebay_listing_quality_packets`, and `hermes_execution_requests`.

## Safety grep notes

Changed-file and diff-only safety grep were run for:

- marketplace write API names
- `ReviseFixedPriceItem`
- packet creation paths
- approval / execution request creation paths
- execution-state mutation indicators
- DB write indicators

The only new Phase 13F DB write indicators are the existing Phase 13E internal evidence-cache `.upsert()` calls, used only by explicit `--write` mode for `listing_details`, `listing_item_specifics`, and `listing_images`.

The only eBay API call used by the Phase 13F path is:

```js
callTradingAPI('GetItem', ...)
```

Historical `ReviseFixedPriceItem` references remain in earlier Phase 12 code and historical execution result data, but Phase 13F did not call them.

## Final Phase 13F state

```json
{
  "item_id_scoped_fetch_supported": true,
  "target_item_ids_written": 5,
  "all_cache_rows_exist": true,
  "all_sources_read_only": true,
  "all_fetched_at_present": true,
  "evidence_refresh_candidates_remaining": 45,
  "execution_candidates": 0,
  "selected_candidate": null,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "phase_12_item_reused": false
}
```
