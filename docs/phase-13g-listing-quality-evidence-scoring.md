# Hermes Phase 13G — Listing Quality Evidence Scoring

Report timestamp: 2026-07-03T11:00:53Z

## Scope

Phase 13G adds deterministic listing-quality scoring and opportunity preview using cached evidence only.

Baseline:

```text
a300735 Add Phase 13F listing evidence cache write validation
```

Phase 13G does not redo Phase 13F.

## Hard boundary

Phase 13G is read-only and preview-only.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- modify eBay listings
- write DB rows
- create opportunities
- create packets
- create approvals / execution requests
- update execution state
- mark marketplace execution
- change price, inventory, quantity, or listing content
- call AI
- push commits

## Target item ids

```text
206284113032
206284142714
206284230187
206284249404
206286078077
```

## Pre-edit read status

Required context was read before editing:

- `git log --oneline -18`
- `docs/phase-13f-evidence-cache-write-validation.md`
- `docs/phase-13e-read-only-evidence-fetch.md`
- `src/services/hermesExecutionApproval.js`
- `src/engines/signalEngine.js`
- `src/agents/opportunityAgent.js`
- `scripts/hermes-agent.js`

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added deterministic cached-evidence scorer:

```js
scoreEbayListingQualityEvidence({ itemIds, limit, dryRun })
```

Added opportunity preview:

```js
previewEbayListingQualityOpportunities({ limit, dryRun })
```

Added CLIs:

```bash
npm run hermes:agent -- ebay-listing-quality-score-evidence --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=10 --dry-run
```

## Scoring model

The scorer is deterministic and uses cached evidence only.

Factors:

- title length / clarity: 20 points
- description presence and length: 25 points
- item specifics count: 15 points
- picture count: 10 points
- category present: 10 points
- listing status active: 10 points
- forbidden marketplace mutation fields absent: blocking safety check

Maximum score: 100.

Listing-quality-low preview rule:

```text
listing_quality_score < 70
OR missing title
OR missing description
```

A listing is not eligible for opportunity preview if forbidden marketplace mutation fields are present or listing status is not active.

Allowed proposed mutation fields are limited to:

- title
- description
- item_specifics

Forbidden field families remain blocked:

- price
- quantity / qty
- inventory / stock
- end listing
- create listing
- relist
- SKU remapping

## Evidence scoring validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-score-evidence --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "operation": "listing_quality_evidence_score",
  "count": 5,
  "low_quality_count": 0,
  "eligible_opportunity_previews": [],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false
}
```

Per-item scores:

```json
[
  {
    "item_id": "206284113032",
    "title": "2025 Solo Leveling 3rd Edition Card BN SL3E-001 Promo Card Sealed",
    "listing_quality_score": 75,
    "detected_gaps": ["description_under_300_chars"],
    "recommendation": "No listing_quality_low opportunity recommended from cached evidence.",
    "would_create_listing_quality_low_opportunity": false,
    "proposed_mutation_fields": ["description"],
    "risk_level": "info"
  },
  {
    "item_id": "206284142714",
    "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
    "listing_quality_score": 70,
    "detected_gaps": ["description_under_300_chars", "pictures_below_2"],
    "recommendation": "No listing_quality_low opportunity recommended from cached evidence.",
    "would_create_listing_quality_low_opportunity": false,
    "proposed_mutation_fields": ["description"],
    "risk_level": "info"
  },
  {
    "item_id": "206284230187",
    "title": "Solo Leveling Official Trading Card STORE PROMO SOLO LEVELING Mapnivers",
    "listing_quality_score": 75,
    "detected_gaps": ["description_under_300_chars"],
    "recommendation": "No listing_quality_low opportunity recommended from cached evidence.",
    "would_create_listing_quality_low_opportunity": false,
    "proposed_mutation_fields": ["description"],
    "risk_level": "info"
  },
  {
    "item_id": "206284249404",
    "title": "[Lotte World] MapleStory Silicone Meso Pouch Keyring",
    "listing_quality_score": 75,
    "detected_gaps": ["description_under_300_chars"],
    "recommendation": "No listing_quality_low opportunity recommended from cached evidence.",
    "would_create_listing_quality_low_opportunity": false,
    "proposed_mutation_fields": ["description"],
    "risk_level": "info"
  },
  {
    "item_id": "206286078077",
    "title": "Shooting Star Catch Teenieping Stackable Melamine 5 Section Kids SPlate",
    "listing_quality_score": 70,
    "detected_gaps": ["description_under_300_chars", "item_specifics_below_5"],
    "recommendation": "No listing_quality_low opportunity recommended from cached evidence.",
    "would_create_listing_quality_low_opportunity": false,
    "proposed_mutation_fields": ["description", "item_specifics"],
    "risk_level": "info"
  }
]
```

All five target listings had cached evidence and scored at or above the listing-quality-low threshold. No opportunity was forced.

## Opportunity preview validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=10 --dry-run
```

Observed output:

```json
{
  "read_only": true,
  "dry_run": true,
  "operation": "listing_quality_opportunity_preview",
  "limit": 10,
  "scanned_count": 5,
  "low_quality_count": 0,
  "opportunities": [],
  "eligible_opportunity": null,
  "recommendation": "No eligible listing_quality_low opportunity found from cached evidence. Do not force a candidate."
}
```

No opportunity was created.

## Next-candidate selector revalidation

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

The already executed Phase 12 item remains excluded from reuse.

## Validation commands

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/engines/signalEngine.js
node --check src/agents/opportunityAgent.js
```

Functional checks:

```bash
npm run hermes:agent -- ebay-listing-quality-score-evidence --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=10 --dry-run
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

## Safety validation

Both new Phase 13G commands returned safety flags showing:

```json
{
  "cached_evidence_only": true,
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

Safety grep was run on changed files and diff-only additions for:

- eBay call indicators
- marketplace write API names
- `ReviseFixedPriceItem`
- opportunity creation
- packet creation
- approval creation
- execution-state mutation
- DB write methods

The Phase 13G diff adds no eBay call, no marketplace write, no opportunity write, no packet write, no approval write, and no execution-state mutation.

Historical references in the shared service remain from earlier phases, but the new Phase 13G command paths are cached-evidence-only.

## Final Phase 13G state

```json
{
  "listing_quality_evidence_scoring_added": true,
  "opportunity_preview_added": true,
  "target_items_scored": 5,
  "low_quality_count": 0,
  "eligible_opportunity": null,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "selected_candidate": null,
  "phase_12_item_reused": false
}
```
