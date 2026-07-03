# Hermes Phase 13J — Borderline Improvement Preview

## Scope

Phase 13J adds a cached-evidence-only preview for borderline listing-quality improvements.

Baseline:

```text
072c369 Add Phase 13I evidence cache batch expansion
```

Phase 13J does not redo Phase 13I and does not create live execution candidates.

## Hard boundary

Phase 13J is read-only and preview-only.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- write DB rows
- create opportunities
- create packets
- create approvals / execution requests
- update execution state
- mark marketplace execution
- modify marketplace listings
- change price, inventory, quantity, or listing content
- push commits

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-preview --limit=20 --dry-run
```

Added service helper:

```js
previewEbayListingQualityBorderlineImprovements({ limit, dryRun })
```

The helper uses only cached evidence from internal tables through existing cached-evidence scoring helpers.

No eBay API module is instantiated, no `callTradingAPI` call is made, and no DB write helper is called.

## Borderline selection policy

A listing can appear in the borderline preview only when all of the following are true:

- listing-quality score is `>= 70` and `< 90`
- listing has at least one minor deterministic gap, including:
  - `pictures_below_2`
  - `item_specifics_below_5`
  - `description_under_800_chars`
  - minor title clarity gaps such as short title, long title, extra whitespace, all-caps style, or non-alphanumeric title
- cached listing status is active
- item id is not `202551129453`
- item id is not present in previous `marketplace_execution_completed` events
- no forbidden marketplace mutation fields are present
- no price / inventory / quantity change is proposed
- proposed mutation fields are limited to:
  - `title`
  - `description`
  - `item_specifics`

Borderline preview is intentionally separate from `listing_quality_low` opportunity preview. It does not imply an active opportunity exists.

## Output shape

The CLI returns:

- `ranked_borderline_candidates`
- `item_id`
- `sku`
- `title`
- `score`
- `detected_gaps`
- `borderline_gaps`
- `gap_reasons`
- `proposed_mutation_fields`
- `risk_level`
- `eligible_for_human_review`
- `why_not_listing_quality_low`
- `recommended_next_action`
- cached evidence metrics
- exclusions and safety flags

## Borderline preview validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-preview --limit=20 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "operation": "listing_quality_borderline_improvement_preview",
  "limit": 20,
  "scanned_count": 20,
  "borderline_candidate_count": 6,
  "recommended_next_action": "Borderline improvement candidates found for preview only. Do not create opportunities, packets, approvals, execution-state changes, or marketplace writes in Phase 13J."
}
```

Ranked borderline candidates:

```json
[
  {
    "rank": 1,
    "item_id": "206284142714",
    "score": 85,
    "detected_gaps": ["pictures_below_2"],
    "proposed_mutation_fields": [],
    "risk_level": "info",
    "eligible_for_human_review": true,
    "why_not_listing_quality_low": "score 85 is at or above listing_quality_low threshold and required low-quality triggers are absent"
  },
  {
    "rank": 2,
    "item_id": "206286078077",
    "score": 85,
    "detected_gaps": ["item_specifics_below_5"],
    "proposed_mutation_fields": ["item_specifics"],
    "risk_level": "info",
    "eligible_for_human_review": true,
    "why_not_listing_quality_low": "score 85 is at or above listing_quality_low threshold and required low-quality triggers are absent"
  },
  {
    "rank": 3,
    "item_id": "206315990948",
    "score": 85,
    "detected_gaps": ["item_specifics_below_5"],
    "proposed_mutation_fields": ["item_specifics"],
    "risk_level": "info",
    "eligible_for_human_review": true,
    "why_not_listing_quality_low": "score 85 is at or above listing_quality_low threshold and required low-quality triggers are absent"
  },
  {
    "rank": 4,
    "item_id": "206332929888",
    "score": 85,
    "detected_gaps": ["pictures_below_2"],
    "proposed_mutation_fields": [],
    "risk_level": "info",
    "eligible_for_human_review": true,
    "why_not_listing_quality_low": "score 85 is at or above listing_quality_low threshold and required low-quality triggers are absent"
  },
  {
    "rank": 5,
    "item_id": "206371786121",
    "score": 85,
    "detected_gaps": ["pictures_below_2"],
    "proposed_mutation_fields": [],
    "risk_level": "info",
    "eligible_for_human_review": true,
    "why_not_listing_quality_low": "score 85 is at or above listing_quality_low threshold and required low-quality triggers are absent"
  },
  {
    "rank": 6,
    "item_id": "206387679082",
    "score": 85,
    "detected_gaps": ["pictures_below_2"],
    "proposed_mutation_fields": [],
    "risk_level": "info",
    "eligible_for_human_review": true,
    "why_not_listing_quality_low": "score 85 is at or above listing_quality_low threshold and required low-quality triggers are absent"
  }
]
```

The candidates are preview-only. No opportunity was created.

## Listing-quality-low preview validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=20 --dry-run
```

Observed result:

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

No `listing_quality_low` opportunity exists after Phase 13J.

## Next-candidate selector validation

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
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-borderline-preview --limit=20 --dry-run
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=20 --dry-run
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Safety validation

Borderline preview safety output:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "listing_changed": false
}
```

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- DB write methods
- opportunity creation
- packet creation
- approval creation
- execution-state mutation

The Phase 13J diff adds no eBay call, marketplace write, DB write, opportunity creation, packet creation, approval creation, or execution-state mutation path. Historical shared-service write helpers remain present from previous phases, but Phase 13J does not invoke them.

## Final Phase 13J state

```json
{
  "borderline_preview_added": true,
  "borderline_candidate_count": 6,
  "listing_quality_low_count": 0,
  "selected_candidate": null,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "phase_12_item_reused": false
}
```
