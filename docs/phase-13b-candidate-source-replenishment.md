# Hermes Phase 13B — Candidate Source Replenishment Audit

Report timestamp: 2026-07-02T22:56:00Z

## Scope

Phase 13B diagnoses and replenishes the controlled expansion candidate source pool for future eBay `listing_quality_update` work.

Baseline:

```text
3427e30 Add Phase 13A controlled expansion candidate selector
```

Phase 13B does not redo Phase 13A and does not create a packet.

## Hard boundary

Phase 13B is read-only by default.

It does not:

- execute marketplace writes
- call `ReviseFixedPriceItem`
- call eBay write APIs
- modify eBay listings
- create packets
- create approvals
- create opportunities
- update execution state
- write DB rows by default
- change price
- change inventory/quantity
- push commits

## Pre-edit read status

Required files were read before editing:

- `git log --oneline -18`
- `docs/phase-13a-controlled-expansion-candidate-selector.md`
- `docs/phase-12-final-closeout.md`
- `src/services/hermesExecutionApproval.js`
- `src/services/skuContextBuilder.js`
- `src/engines/signalEngine.js`
- `scripts/hermes-agent.js`

Requested `src/agents/listingAgent.js` was not present in the repository. Similar existing agent files include:

- `src/agents/opportunityAgent.js`
- `src/agents/marketAgent.js`
- `src/agents/index.js`

The implementation therefore reused existing `opportunityAgent` and cached listing evidence paths.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added read-only audit service:

```js
auditEbayListingQualityCandidateSources({ limit })
```

Added read-only rescan preview service:

```js
rescanEbayListingQualityCandidates({ limit, dryRun })
```

Added CLI commands:

```bash
npm run hermes:agent -- ebay-listing-quality-candidate-source-audit --limit=50
npm run hermes:agent -- ebay-listing-quality-candidate-rescan --limit=20 --dry-run
```

Both commands return explicit safety flags showing:

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

## Candidate source audit command

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-candidate-source-audit --limit=50
```

Observed summary:

```json
{
  "read_only": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "limit": 50,
  "totals": {
    "total_active_opportunities": 5,
    "listing_quality_low_opportunities": 1,
    "archived_opportunities": 1,
    "opportunities_missing_item_id": 1,
    "opportunities_missing_title_evidence": 1,
    "opportunities_excluded_already_executed": 2,
    "opportunities_excluded_mutation_not_title_only": 0,
    "opportunities_excluded_price_inventory_present": 2
  },
  "scanned": {
    "request_count": 2,
    "opportunity_count": 6,
    "candidate_source_count": 3,
    "marketplace_execution_event_count": 1,
    "completed_marketplace_item_ids": [
      "202551129453"
    ]
  }
}
```

### Audit interpretation

The source pool does not currently contain an eligible next listing-quality candidate.

Current blockers:

1. The only `listing_quality_low` opportunity is the archived Phase 3 fixture.
2. The archived fixture lacks cached eBay item id and title evidence.
3. The active request/opportunity sources point back to the already executed Phase 12 item.
4. The Phase 12 item is correctly excluded by prior marketplace execution event and explicit item id exclusion.
5. The active request sources are dead-stock/no-recent-sales, not listing-quality-only sources.

## Candidate source rows observed

### Phase 12 item family

Request sources for SKU/item `202551129453` remain blocked:

```json
{
  "sku": "202551129453",
  "item_id": "202551129453",
  "signals": [
    "dead_stock",
    "no_recent_sales"
  ],
  "proposed_mutation_fields": [
    "title"
  ],
  "blockers": [
    "item_id_202551129453_excluded",
    "item_previous_marketplace_execution_completed_event_exists",
    "phase_12_source_opportunity_excluded",
    "listing_quality_low_signal_missing",
    "inventory_or_stock_signal_present"
  ]
}
```

For request `1`, duplicate execution blockers are also present:

```json
[
  "request_id_1_excluded",
  "request_executed_at_present",
  "request_execution_result_present",
  "request_previous_marketplace_execution_completed_event_exists",
  "request_status_executed_not_selectable"
]
```

This confirms Phase 12 artifacts are not reusable as Phase 13 candidates.

### Archived listing-quality fixture

The historical listing-quality fixture was audited but not selected:

```json
{
  "opportunity_id": 6,
  "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
  "signals": [
    "listing_quality_low"
  ],
  "opportunity_status": "archived",
  "item_id": null,
  "blockers": [
    "valid_ebay_item_id_missing",
    "title_evidence_missing",
    "opportunity_status_archived_not_active"
  ]
}
```

## Listings needing evidence refresh

The audit identified these source records as needing evidence refresh or item resolution before any future packet work:

```json
[
  {
    "sku": "202551129453",
    "item_id": "202551129453",
    "limitations": [
      "cached_description_missing",
      "cached_item_specifics_missing",
      "listing_details_cache_missing_for_sku"
    ],
    "recommended_refresh": "refresh cached listing_details/item_specifics/images/policies for this item before packet work"
  },
  {
    "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
    "item_id": null,
    "limitations": [
      "cached_item_id_missing",
      "cached_title_missing",
      "cached_description_missing",
      "cached_item_specifics_missing",
      "listing_details_cache_missing_for_sku"
    ],
    "recommended_refresh": "resolve cached eBay item_id/listing_id before packet work"
  }
]
```

The Phase 12 SKU appears in this audit only because it is present in the source pool; it remains excluded from any future execution candidate.

## Candidate rescan command

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-candidate-rescan --limit=20 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "limit": 20,
  "scanned_sku_count": 20,
  "preview_count": 0
}
```

The rescan used existing cached listing/context data from current DB mirrors. It produced candidate previews only and did not write opportunities.

The 20 scanned SKUs had cached eBay item ids and title evidence, but no `listing_quality_low` preview was produced under the current Signal Engine rules. Most had cached listing evidence limitations such as `cached_description_missing`; however, those limitations alone did not produce a listing-quality candidate because the current Signal Engine low-quality rule is focused on missing listing id, missing/short title, zero price, or ended listing.

## Rescan behavior

The rescan command:

- reads recent cached `ebay_products` rows
- runs existing `opportunityAgent` in read-only mode
- filters to `listing_quality_review` candidates
- reports candidate previews only
- does not call eBay write APIs
- does not create opportunities
- does not create packets
- does not create approvals
- does not update execution state

## Recommended safe replenishment action

Current recommendation:

```text
Run read-only SKU/listing context rescan to identify listing_quality_low previews, then consider a later explicit internal-only opportunity replenishment phase; do not create packets or approvals in Phase 13B.
```

More specifically:

1. Keep Phase 13B read-only.
2. Improve or refresh cached listing evidence for active listings, especially `listing_details`, item specifics, images, and policies.
3. Consider whether the Signal Engine should treat missing description/item-specifics evidence as listing quality risk in a later explicit phase.
4. Only after a fresh active `listing_quality_low` preview appears should a later phase consider internal-only opportunity creation.
5. Do not create a packet or approval until the Phase 13A selector returns a low-risk selected candidate.

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

## Syntax validation

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/services/skuContextBuilder.js
node --check src/engines/signalEngine.js
node --check src/agents/opportunityAgent.js
```

All checks passed.

## Safety validation

Safety grep was run on changed files and diff-only additions.

Diff-only safety grep for tracked code additions returned no marketplace/API/write-path matches. Documentation references in this report explicitly describe forbidden operations and safety boundaries only.

No Phase 13B selector/audit/rescan code added:

- `ReviseFixedPriceItem` runtime calls
- `callTradingAPI` calls
- `axios` or `fetch` network calls
- DB `.insert()` / `.update()` / `.upsert()` / `.delete()` calls in the new Phase 13B paths
- packet creation calls
- approval creation calls
- marketplace write flags
- live transport write command paths

Historical matches still exist elsewhere in the shared service for prior phases, including Phase 12 live transport and earlier internal write flows, but the Phase 13B command paths do not invoke them.

## Final Phase 13B state

```json
{
  "candidate_source_audit_added": true,
  "candidate_rescan_preview_added": true,
  "selected_candidate": null,
  "packet_created": false,
  "approval_created": false,
  "opportunity_created": false,
  "marketplace_write_performed": false,
  "db_mutation_by_default": false,
  "phase_12_item_reused": false
}
```

Phase 13B confirms the candidate pool needs replenishment before any next single-SKU eBay listing-quality update can proceed.
