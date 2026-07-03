# Hermes Phase 13C — Listing Evidence Refresh Planner

Report timestamp: 2026-07-03T00:04:31Z

## Scope

Phase 13C creates a read-only eBay listing evidence refresh planner for controlled expansion after Phase 13B found an empty candidate source pool.

Baseline:

```text
999fabb Add Phase 13B candidate source replenishment audit
```

Phase 13C does not redo Phase 13A or Phase 13B.

## Hard boundary

Phase 13C is planner/preview only.

It does not:

- call eBay write APIs
- call `ReviseFixedPriceItem`
- modify eBay listings
- create opportunities
- create packets
- create approvals
- update execution state
- write DB rows by default
- perform live/read-only eBay fetches in this phase
- fake missing evidence
- change price
- change inventory/quantity
- push commits

## Pre-edit read status

Required context was read before editing:

- `git log --oneline -18`
- `docs/phase-13b-candidate-source-replenishment.md`
- `docs/phase-13a-controlled-expansion-candidate-selector.md`
- `src/services/hermesExecutionApproval.js`
- `src/services/skuContextBuilder.js`
- `src/engines/signalEngine.js`
- `src/agents/opportunityAgent.js`
- `src/api/ebayAPI.js`
- `scripts/hermes-agent.js`

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service functions:

```js
buildEbayListingQualityEvidenceRefreshPlan({ limit })
previewEbayListingQualityEvidenceRefresh({ limit, dryRun })
```

Added CLI commands:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-plan --limit=50
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-preview --limit=20 --dry-run
```

The planner uses existing internal/cache data only:

- `ebay_products`
- `listing_details`
- `listing_item_specifics`
- `listing_images`
- `listing_policies`
- `hermes_execution_events`
- existing SKU Context / Signal Engine output in read-only DB fallback mode

The preview prepares read-only fetch plans only. It does not perform the live fetch or write refreshed evidence into cache.

## Planner output requirements

The planner reports:

- active eBay-capable SKUs/listings found from existing internal data
- listings missing cached item_id
- listings missing cached title evidence
- listings missing listing quality evidence
- listings excluded because already executed
- listings excluded because price/inventory signals dominate
- listings that are safe candidates for read-only evidence refresh
- recommended next command

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
    "listings_excluded_price_inventory_signals_dominate": 50,
    "safe_candidates_for_read_only_evidence_refresh": 0
  },
  "completed_marketplace_item_ids": [
    "202551129453"
  ],
  "safe_candidates_for_read_only_evidence_refresh": []
}
```

The planner found 50 active eBay-capable listings from internal data. All 50 have cached item id and title evidence, but all 50 are missing listing-quality evidence, primarily cached description evidence.

The planner did not mark any listing as a safe read-only evidence-refresh candidate because price/inventory-style signals dominate the current SKU Context output for all scanned listings, and none has a `listing_quality_low` signal under the current Signal Engine rules.

This is a safe result: it prevents refreshing or advancing listings as listing-quality candidates when the current signal source indicates stock/dead-stock/no-recent-sales or other non-listing-quality drivers instead.

## Example observed listing state

One representative planned listing had:

```json
{
  "active_ebay_capable": true,
  "missing_cached_item_id": false,
  "missing_cached_title_evidence": false,
  "missing_listing_quality_evidence": true,
  "missing_evidence_fields": [
    "cached_description"
  ],
  "excluded_already_executed": false,
  "excluded_price_inventory_signals_dominate": true,
  "signal_summary": {
    "listing_quality_low": false,
    "price_inventory_signals_dominate": true
  },
  "safe_candidate_for_read_only_evidence_refresh": false
}
```

## Preview validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-preview --limit=20 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_evidence_refresh_preview",
  "limit": 20,
  "source_plan_summary": {
    "active_ebay_capable_listings_found": 20,
    "listings_missing_cached_item_id": 0,
    "listings_missing_cached_title_evidence": 0,
    "listings_missing_listing_quality_evidence": 20,
    "listings_excluded_already_executed": 0,
    "listings_excluded_price_inventory_signals_dominate": 20,
    "safe_candidates_for_read_only_evidence_refresh": 0
  },
  "fetch_preview_count": 0,
  "fetch_previews": [],
  "blocker": "no_safe_read_only_evidence_refresh_candidates"
}
```

The preview stopped gracefully with a structured blocker because no safe read-only evidence refresh candidates were available.

No live/read-only eBay fetch was attempted. No rate limit was hit. No evidence was fabricated.

## Existing read-only fetch availability

`src/api/ebayAPI.js` contains existing eBay read-capable paths, including Trading API `GetItem` and Shopping/Browse read paths. Phase 13C does not create new auth logic and does not invoke those paths. It only prepares future read-only fetch planning text for a later explicitly authorized fetch/cache phase.

If a later phase enables read-only live fetches and eBay returns a rate limit or unavailable state, the correct behavior remains:

1. stop gracefully,
2. document the blocker,
3. do not fake evidence,
4. do not create opportunities, packets, approvals, or marketplace writes.

## Phase 13A selector revalidation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed result remains:

```json
{
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

The Phase 12 item remains excluded:

```json
{
  "excluded_item_ids": [
    "202551129453"
  ],
  "completed_marketplace_item_ids": [
    "202551129453"
  ]
}
```

## Recommended next command

The planner returns:

```bash
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-preview --limit=20 --dry-run
```

Because the preview currently returns no safe fetch previews, the practical next step is not packet creation. The next safe product phase should decide whether to broaden listing-quality evidence rules or perform an explicitly authorized read-only fetch/cache phase that remains internal-only.

## Recommended next action

Do not create a packet yet.

Recommended path:

1. Keep Phase 13C read-only.
2. Review whether current Signal Engine rules are too narrow for listing-quality evidence gaps such as missing description.
3. Consider a later explicit phase for internal-only read-only evidence refresh/cache writes, if desired.
4. Only after a fresh active `listing_quality_low` candidate appears should a later phase consider internal-only opportunity creation.
5. Only after a candidate is selected should any operator packet preview be built.
6. Marketplace execution remains out of scope.

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
npm run hermes:agent -- ebay-listing-quality-evidence-refresh-preview --limit=20 --dry-run
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

All commands completed successfully.

## Safety validation

Safety output from both new commands includes:

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

Safety grep was run on changed files and diff-only additions. Historical matches in the shared service still exist for earlier phases, including Phase 12 live transport and other internal write helpers, but the Phase 13C command paths do not invoke them.

Diff-only safety grep found no new runtime marketplace write path, packet creation, approval creation, or DB mutation path for Phase 13C. Documentation references to forbidden actions are safety text only.

## Final Phase 13C state

```json
{
  "evidence_refresh_planner_added": true,
  "evidence_refresh_preview_added": true,
  "active_ebay_capable_listings_found": 50,
  "safe_candidates_for_read_only_evidence_refresh": 0,
  "selected_candidate": null,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "marketplace_write_performed": false,
  "db_mutation_by_default": false,
  "phase_12_item_reused": false
}
```

Phase 13C confirms that controlled expansion still needs a safe listing-quality source signal or a later explicitly authorized read-only evidence-refresh/cache phase before any opportunity, packet, approval, or marketplace execution work can proceed.
