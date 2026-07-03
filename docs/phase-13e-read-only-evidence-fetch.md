# Hermes Phase 13E — Read-only Listing Evidence Fetch

Report timestamp: 2026-07-03T10:35:28Z

## Scope

Phase 13E implements a limited read-only eBay listing evidence fetch for controlled expansion.

Baseline:

```text
7c48eea Add Phase 13D evidence refresh eligibility refinement
```

Phase 13E does not redo Phase 13A, 13B, 13C, or 13D.

## Hard boundary

Phase 13E may call read-only eBay Trading API `GetItem` only.

It does not:

- call `ReviseFixedPriceItem`
- call eBay write APIs
- modify eBay listings
- change price
- change inventory/quantity
- create opportunities
- create packets
- create approvals
- update execution state
- create marketplace execution events
- reuse item `202551129453`
- push commits

## Pre-edit read status

Required context was read before editing:

- `git log --oneline -18`
- `docs/phase-13d-evidence-refresh-eligibility.md`
- `docs/phase-13c-listing-evidence-refresh-planner.md`
- `src/services/hermesExecutionApproval.js`
- `src/api/ebayAPI.js`
- `scripts/hermes-agent.js`

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=5 --dry-run
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=5 --write
```

Default behavior is dry-run unless `--write` is explicitly present.

Service added:

```js
fetchEbayListingQualityEvidence({ limit, dryRun, write })
```

The service:

1. Reuses Phase 13D `sampleEbayListingQualityEvidenceRefresh` candidates.
2. Limits scope to max 5 listings.
3. Excludes item id `202551129453`.
4. Excludes already executed listings through the Phase 13D sample/plan path.
5. Calls only existing `src/api/ebayAPI.js` Trading API `GetItem` through `callTradingAPI('GetItem', ...)`.
6. Parses only read-only evidence fields.
7. Defaults to no DB write.
8. Supports optional internal evidence-cache write mode, but no write-mode validation was run in this phase.

## Evidence collected

Each successful fetch returns:

- `item_id`
- `title`
- `description_present`
- `description_length`
- `item_specifics_present`
- `item_specifics_count`
- `picture_count`
- `category_id`
- `category_name`
- `listing_status`
- `fetched_at`
- `source = ebay_get_item_read_only`
- `raw_response_summary` without secrets

No full token, credential, or secret values are printed.

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=5 --dry-run
```

Phase 13E dry-run is explicitly designed to perform read-only `GetItem` fetches and no database writes. The output labels this as:

```json
{
  "actual_read_only_ebay_call": true,
  "actual_ebay_call": true,
  "actual_network_call": true,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false
}
```

Observed fetch scope:

```json
{
  "max_items": 5,
  "excluded_item_ids": ["202551129453"],
  "already_executed_listings_excluded": true,
  "read_operation": "Trading API GetItem"
}
```

Observed source sample summary:

```json
{
  "active_ebay_capable_listings_found": 50,
  "listings_missing_cached_item_id": 0,
  "listings_missing_cached_title_evidence": 0,
  "listings_missing_listing_quality_evidence": 50,
  "listings_excluded_already_executed": 0,
  "listings_with_price_inventory_signals": 50,
  "listings_excluded_price_inventory_signals_dominate": 0,
  "evidence_refresh_candidates": 50,
  "execution_candidates": 0,
  "safe_candidates_for_read_only_evidence_refresh": 50
}
```

Fetch result summary:

```json
{
  "candidate_count": 5,
  "fetched_count": 5,
  "failed_count": 0,
  "partial_failure": false,
  "blocker": null
}
```

Fetched listings:

```json
[
  {
    "sku": "206284113032",
    "item_id": "206284113032",
    "title": "2025 Solo Leveling 3rd Edition Card BN SL3E-001 Promo Card Sealed",
    "description_present": true,
    "description_length": 4695,
    "item_specifics_present": true,
    "item_specifics_count": 16,
    "picture_count": 2,
    "category_id": "261044",
    "category_name": "Toys & Hobbies:Collectible Card Games:CCG Sealed Boxes",
    "listing_status": "Active",
    "source": "ebay_get_item_read_only",
    "ack": "Success"
  },
  {
    "sku": "206284142714",
    "item_id": "206284142714",
    "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
    "description_present": true,
    "description_length": 4687,
    "item_specifics_present": true,
    "item_specifics_count": 16,
    "picture_count": 1,
    "category_id": "261044",
    "category_name": "Toys & Hobbies:Collectible Card Games:CCG Sealed Boxes",
    "listing_status": "Active",
    "source": "ebay_get_item_read_only",
    "ack": "Success"
  },
  {
    "sku": "206284230187",
    "item_id": "206284230187",
    "title": "Solo Leveling Official Trading Card STORE PROMO SOLO LEVELING Mapnivers",
    "description_present": true,
    "description_length": 4701,
    "item_specifics_present": true,
    "item_specifics_count": 16,
    "picture_count": 2,
    "category_id": "261044",
    "category_name": "Toys & Hobbies:Collectible Card Games:CCG Sealed Boxes",
    "listing_status": "Active",
    "source": "ebay_get_item_read_only",
    "ack": "Success"
  },
  {
    "sku": "206284249404",
    "item_id": "206284249404",
    "title": "[Lotte World] MapleStory Silicone Meso Pouch Keyring",
    "description_present": true,
    "description_length": 8437,
    "item_specifics_present": true,
    "item_specifics_count": 8,
    "picture_count": 5,
    "category_id": "38583",
    "category_name": "Video Games & Consoles:Video Game Merchandise",
    "listing_status": "Active",
    "source": "ebay_get_item_read_only",
    "ack": "Success"
  },
  {
    "sku": "206286078077",
    "item_id": "206286078077",
    "title": "Shooting Star Catch Teenieping Stackable Melamine 5 Section Kids SPlate",
    "description_present": true,
    "description_length": 11542,
    "item_specifics_present": true,
    "item_specifics_count": 3,
    "picture_count": 5,
    "category_id": "117385",
    "category_name": "Baby:Feeding:Cups, Dishes & Utensils:Utensils",
    "listing_status": "Active",
    "source": "ebay_get_item_read_only",
    "ack": "Success"
  }
]
```

All five read-only `GetItem` calls succeeded with `Ack=Success` and `errors=[]`.

No evidence was faked.

## Optional write mode

CLI exists:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=5 --write
```

Write mode is intentionally internal-only and evidence-only. It may upsert successful read-only `GetItem` evidence into existing cache tables:

- `listing_details`
- `listing_item_specifics`
- `listing_images`

It does not:

- create opportunities
- create packets
- create approvals
- update execution state
- modify marketplace listings
- call write APIs
- write marketplace execution events

Write mode was not run during Phase 13E validation because dry-run already performed the required read-only fetch and the user explicitly allowed skipping write unless the implementation clearly writes only internal evidence cache and is documented. The implementation is documented, but no internal cache write was needed to prove read-only fetch behavior.

## Graceful handling

The implementation classifies per-item failures as:

- `rate_limit`
- `invalid_token_or_auth`
- `missing_or_invalid_item`
- `fetch_failed`

Partial failures do not fabricate evidence. Successful items remain reported; failed items include error metadata and `evidence_faked=false`.

## Phase 13A selector revalidation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed result remains safe:

```json
{
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

The already executed Phase 12 item remains excluded:

```json
{
  "excluded_item_ids": ["202551129453"],
  "completed_marketplace_item_ids": ["202551129453"]
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
npm run hermes:agent -- ebay-listing-quality-evidence-fetch --limit=5 --dry-run
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Safety checks:

```bash
# changed-file and diff-only grep for write/API/packet/approval indicators
git diff --stat
```

All validation commands completed successfully.

## Safety validation

Dry-run fetch safety output:

```json
{
  "read_only": true,
  "actual_read_only_ebay_call": true,
  "actual_ebay_call": true,
  "actual_network_call": true,
  "actual_database_write": false,
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

Safety grep notes:

- The new Phase 13E runtime path adds `callTradingAPI('GetItem', ...)` only.
- Diff-only safety grep shows no new `ReviseFixedPriceItem` runtime call.
- Diff-only safety grep shows no packet creation or approval creation path.
- Diff-only safety grep shows optional internal cache `.upsert()` calls only inside the explicit `--write` evidence-cache path.
- Existing historical shared-service write helpers and Phase 12 live transport code remain present, but Phase 13E dry-run does not invoke them.

## Final Phase 13E state

```json
{
  "read_only_evidence_fetch_added": true,
  "max_fetch_items": 5,
  "dry_run_get_item_fetch_completed": true,
  "fetched_count": 5,
  "failed_count": 0,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_candidate_selected": false,
  "phase_12_item_reused": false
}
```

## Recommended next action

Phase 13F should be internal-only if continued:

1. Optionally run evidence-cache write mode for the same 5 fetched items if the operator wants the cache updated.
2. Re-run evidence refresh planner and candidate source audit after cache write.
3. Add deterministic listing-quality gap rules only after refreshed evidence exists.
4. Do not create opportunities until a rule-based listing-quality issue is detected.
5. Do not create packets or approvals until the Phase 13A selector returns a low-risk selected candidate.
6. Marketplace writes remain out of scope.
