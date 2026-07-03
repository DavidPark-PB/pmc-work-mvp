# Hermes Phase 13D — Evidence Refresh Eligibility Refinement

Report timestamp: 2026-07-03T00:27:09Z

## Scope

Phase 13D refines listing evidence refresh eligibility after Phase 13C found active eBay-capable listings with cached item id/title evidence but produced zero refresh candidates because inventory/dead-stock/no-recent-sales signals dominated.

Baseline:

```text
d03d093 Add Phase 13C listing evidence refresh planner
```

Phase 13D does not redo Phase 13A, 13B, or 13C.

## Hard boundary

Evidence refresh planning is not marketplace execution candidate selection.

Phase 13D does not:

- call eBay write APIs
- call `ReviseFixedPriceItem`
- modify eBay listings
- perform live/read-only eBay fetches in this phase
- create opportunities
- create packets
- create approvals
- update execution state
- write DB rows by default
- change price
- change inventory/quantity
- push commits

## Pre-edit read status

Required context was read before editing:

- `git log --oneline -18`
- `docs/phase-13c-listing-evidence-refresh-planner.md`
- `docs/phase-13b-candidate-source-replenishment.md`
- `src/services/hermesExecutionApproval.js`
- `src/services/skuContextBuilder.js`
- `src/engines/signalEngine.js`
- `src/agents/opportunityAgent.js`
- `src/api/ebayAPI.js`
- `scripts/hermes-agent.js`

## Rule change

Phase 13C incorrectly treated evidence refresh eligibility too much like execution-candidate eligibility.

Phase 13D changes that:

- Read-only evidence refresh no longer requires a `listing_quality_low` signal.
- Read-only evidence refresh is not blocked only because `stock_risk`, `dead_stock`, or `no_recent_sales` signals exist.
- Inventory/dead-stock/no-recent-sales signals remain visible in output, but they do not block evidence collection.
- Execution candidate selection remains strict and separate.

Still excluded:

- already executed item id `202551129453`
- any item with a previous `marketplace_execution_completed` event
- invalid/missing item id
- inactive/non-eBay listing
- listings without enough identity data to prepare a read-only fetch plan

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Updated planner behavior:

```js
buildEbayListingQualityEvidenceRefreshPlan({ limit })
```

The planner now separates:

- `evidence_refresh_candidates`
- `execution_candidates`

Added sample CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample --limit=5 --dry-run
```

The sample command:

- selects up to 5 active eBay listings missing listing-quality evidence
- shows item id, title, and evidence gaps
- prepares a read-only GetItem/fetch plan using existing API/auth paths for a later phase
- does not call eBay in Phase 13D
- does not write DB
- does not create opportunities, packets, or approvals
- does not modify listings

## Planner validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-plan --limit=50
```

Observed summary:

```json
{
  "read_only": true,
  "marketplace": "ebay",
  "operation": "listing_quality_evidence_refresh_plan",
  "limit": 50,
  "totals": {
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
  },
  "completed_marketplace_item_ids": [
    "202551129453"
  ],
  "recommended_next_command": "npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample --limit=5 --dry-run"
}
```

Interpretation:

- Active eBay-capable listings exist.
- Cached item id and title evidence exist.
- Listing-quality evidence gaps remain, especially `cached_description`.
- Inventory/dead-stock/no-recent-sales signals are present on all scanned listings, but no longer block read-only evidence refresh.
- The planner found 50 evidence refresh candidates.
- The planner found 0 execution candidates.

This is intentional: evidence refresh candidates are safe for planning read-only evidence collection, while execution candidates remain unavailable until a valid listing-quality opportunity exists.

## Sample validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample --limit=5 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_evidence_refresh_sample",
  "limit": 5,
  "source_plan_summary": {
    "active_ebay_capable_listings_found": 50,
    "listings_missing_cached_item_id": 0,
    "listings_missing_cached_title_evidence": 0,
    "listings_missing_listing_quality_evidence": 50,
    "listings_with_price_inventory_signals": 50,
    "listings_excluded_price_inventory_signals_dominate": 0,
    "evidence_refresh_candidates": 50,
    "execution_candidates": 0,
    "safe_candidates_for_read_only_evidence_refresh": 50
  },
  "sample_count": 5,
  "blocker": null
}
```

Sampled listings:

```json
[
  {
    "rank": 1,
    "sku": "206284113032",
    "item_id": "206284113032",
    "title": "2025 Solo Leveling 3rd Edition Card BN SL3E-001 Promo Card Sealed",
    "current_evidence_gaps": ["cached_description"]
  },
  {
    "rank": 2,
    "sku": "206284142714",
    "item_id": "206284142714",
    "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
    "current_evidence_gaps": ["cached_description"]
  },
  {
    "rank": 3,
    "sku": "206284230187",
    "item_id": "206284230187",
    "title": "Solo Leveling Official Trading Card STORE PROMO SOLO LEVELING Mapnivers",
    "current_evidence_gaps": ["cached_description"]
  },
  {
    "rank": 4,
    "sku": "206284249404",
    "item_id": "206284249404",
    "title": "[Lotte World] MapleStory Silicone Meso Pouch Keyring",
    "current_evidence_gaps": ["cached_description"]
  },
  {
    "rank": 5,
    "sku": "206286078077",
    "item_id": "206286078077",
    "title": "Shooting Star Catch Teenieping Stackable Melamine 5 Section Kids SPlate",
    "current_evidence_gaps": ["cached_description"]
  }
]
```

Each sample includes a prepared read-only fetch plan:

```json
{
  "prepared": true,
  "max_items_for_this_command": 5,
  "existing_api_module": "src/api/ebayAPI.js",
  "existing_auth_logic_reused": true,
  "new_auth_logic_created": false,
  "read_operation": "Trading API GetItem or existing read-only listing enrichment path in a later explicitly authorized fetch/cache phase",
  "would_include": [
    "ItemID",
    "Title",
    "Description",
    "ItemSpecifics",
    "PictureDetails",
    "ListingDetails",
    "ReturnPolicy",
    "ShippingDetails",
    "PaymentMethods"
  ],
  "would_call_ebay_now": false,
  "would_write_db_now": false,
  "would_create_opportunity": false,
  "would_create_packet": false,
  "would_create_approval": false,
  "would_modify_listing": false
}
```

No read-only GetItem call was performed in Phase 13D. The command only prepares the plan.

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

## Safety validation

Safety flags from the Phase 13D commands include:

```json
{
  "read_only": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false
}
```

Safety grep was run on changed files and diff-only additions.

Diff-only code additions do not add runtime marketplace write calls, packet creation, approval creation, or DB mutation paths for Phase 13D. Documentation references to forbidden operations are safety text only.

Existing historical shared-service write helpers from earlier phases remain present, but the new Phase 13D planner/sample command paths do not invoke them.

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/services/skuContextBuilder.js
node --check src/engines/signalEngine.js
node --check src/agents/opportunityAgent.js
node --check src/api/ebayAPI.js
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-plan --limit=50
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample --limit=5 --dry-run
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

All checks completed successfully after the interrupted first sample attempt was rerun.

## Final Phase 13D state

```json
{
  "evidence_refresh_eligibility_refined": true,
  "listing_quality_low_required_for_evidence_refresh": false,
  "inventory_signals_block_evidence_refresh": false,
  "evidence_refresh_candidates": 50,
  "execution_candidates": 0,
  "selected_execution_candidate": null,
  "phase_12_item_reused": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "db_mutation_by_default": false,
  "marketplace_write_performed": false
}
```

## Recommended next action

Recommended next command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-sample --limit=5 --dry-run
```

Recommended Phase 13E entry criteria:

1. Keep read-only fetch scope limited to a small sample, max 5 items.
2. If a later phase performs read-only GetItem, document rate-limit behavior and stop gracefully on API errors.
3. If cache writes are desired, make them an explicit internal-only phase with dry-run default.
4. Do not create listing_quality_low opportunities until refreshed evidence is available and a deterministic rule identifies a listing-quality gap.
5. Do not create packets or approvals until the Phase 13A next-candidate selector returns a low-risk selected candidate.
6. Marketplace writes remain out of scope.
