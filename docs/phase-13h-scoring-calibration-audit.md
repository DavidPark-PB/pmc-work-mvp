# Hermes Phase 13H — Listing Quality Scoring Calibration Audit

## Scope

Phase 13H audits and calibrates deterministic listing-quality scoring after Phase 13G.

Baseline:

```text
422f8cb Add Phase 13G listing quality evidence scoring
```

Phase 13H does not redo Phase 13G and does not revert the current local work.

## Hard boundary

Phase 13H is cached-evidence-only and read-only.

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

## Problem found from Phase 13G

Phase 13G scored the five cached evidence rows at 70–75 and emitted `description_under_300_chars` even though Phase 13F cache validation showed raw description lengths above 4,000 characters for every item.

The issue was a deterministic text extraction/calibration bug:

- cached `raw_data` could contain more than one description-like field
- the previous helper selected the first non-empty description candidate
- a shorter summary-like candidate could be selected before the longer raw `Description`
- scorer therefore saw about 200 characters and incorrectly emitted `description_under_300_chars`

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added scorer audit CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-score-audit --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077
```

Added deterministic description audit helpers:

- collect description candidates from cached raw evidence
- choose the longest cached description candidate
- normalize whitespace
- strip HTML for visible-text scoring
- expose raw, normalized, HTML-stripped, and visible-text lengths
- explain why each detected gap was emitted

Calibrated scorer behavior:

- description score now uses normalized visible text derived from cached evidence
- thresholds were not lowered to create candidates
- no listing_quality_low signal/opportunity is forced
- scoring remains deterministic

## Audit output fields

For each item, the audit reports:

- `raw_description_length`
- `normalized_description_length`
- `html_stripped_description_length`
- `visible_text_length`
- `item_specifics_count`
- `picture_count`
- `score_component_breakdown`
- `detected_gaps`
- `gap_reasons`
- `recommendation`
- `would_create_listing_quality_low_opportunity`
- `proposed_mutation_fields`
- `risk_level`
- `evidence_source`

## Audit validation result

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-score-audit --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077
```

Observed Phase 13H audit summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "operation": "listing_quality_score_audit",
  "count": 5,
  "calibration_summary": {
    "raw_description_present_count": 5,
    "visible_text_present_count": 5,
    "description_under_300_count": 0,
    "low_quality_count": 0,
    "calibration_fix_applied": "description normalization now chooses the longest cached raw description candidate and scores stripped visible text"
  }
}
```

Per-item audit results:

```json
[
  {
    "item_id": "206284113032",
    "raw_description_length": 4695,
    "normalized_description_length": 4695,
    "html_stripped_description_length": 1796,
    "visible_text_length": 1796,
    "item_specifics_count": 16,
    "picture_count": 2,
    "listing_quality_score": 90,
    "detected_gaps": []
  },
  {
    "item_id": "206284142714",
    "raw_description_length": 4687,
    "normalized_description_length": 4687,
    "html_stripped_description_length": 1788,
    "visible_text_length": 1788,
    "item_specifics_count": 16,
    "picture_count": 1,
    "listing_quality_score": 85,
    "detected_gaps": ["pictures_below_2"],
    "gap_reasons": {
      "pictures_below_2": {
        "reason": "picture count 1 is below scoring threshold"
      }
    }
  },
  {
    "item_id": "206284230187",
    "raw_description_length": 4701,
    "normalized_description_length": 4701,
    "html_stripped_description_length": 1802,
    "visible_text_length": 1802,
    "item_specifics_count": 16,
    "picture_count": 2,
    "listing_quality_score": 90,
    "detected_gaps": []
  },
  {
    "item_id": "206284249404",
    "raw_description_length": 8437,
    "normalized_description_length": 8437,
    "html_stripped_description_length": 1212,
    "visible_text_length": 1212,
    "item_specifics_count": 8,
    "picture_count": 5,
    "listing_quality_score": 90,
    "detected_gaps": []
  },
  {
    "item_id": "206286078077",
    "raw_description_length": 11542,
    "normalized_description_length": 11467,
    "html_stripped_description_length": 1236,
    "visible_text_length": 1236,
    "item_specifics_count": 3,
    "picture_count": 5,
    "listing_quality_score": 85,
    "detected_gaps": ["item_specifics_below_5"],
    "gap_reasons": {
      "item_specifics_below_5": {
        "reason": "item specifics count 3 is below scoring threshold"
      }
    }
  }
]
```

## Re-scoring validation result

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-score-evidence --item-ids=206284113032,206284142714,206284230187,206284249404,206286078077 --dry-run
```

Observed recalibrated scores:

```json
[
  { "item_id": "206284113032", "score": 90, "description_length": 1796, "raw_description_length": 4695, "detected_gaps": [] },
  { "item_id": "206284142714", "score": 85, "description_length": 1788, "raw_description_length": 4687, "detected_gaps": ["pictures_below_2"] },
  { "item_id": "206284230187", "score": 90, "description_length": 1802, "raw_description_length": 4701, "detected_gaps": [] },
  { "item_id": "206284249404", "score": 90, "description_length": 1212, "raw_description_length": 8437, "detected_gaps": [] },
  { "item_id": "206286078077", "score": 85, "description_length": 1236, "raw_description_length": 11542, "detected_gaps": ["item_specifics_below_5"] }
]
```

Summary:

```json
{
  "count": 5,
  "low_quality_count": 0,
  "eligible_opportunity_previews": []
}
```

No `description_under_300_chars` gap remains after calibration.

## Opportunity preview validation result

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-opportunity-preview --limit=10 --dry-run
```

Observed result:

```json
{
  "read_only": true,
  "dry_run": true,
  "operation": "listing_quality_opportunity_preview",
  "scanned_count": 5,
  "low_quality_count": 0,
  "opportunities": [],
  "eligible_opportunity": null,
  "recommendation": "No eligible listing_quality_low opportunity found from cached evidence. Do not force a candidate."
}
```

No opportunity was created or forced.

## Next-candidate selector validation result

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

## Safety validation

The Phase 13H audit/scoring/preview commands report safety flags equivalent to:

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
  "inventory_changes": false
}
```

The next-candidate selector remains read-only and returned no selectable candidate.

## Final Phase 13H state

```json
{
  "score_audit_cli_added": true,
  "description_normalization_calibrated": true,
  "target_items_audited": 5,
  "description_under_300_count": 0,
  "recalibrated_scores": [90, 85, 90, 90, 85],
  "low_quality_count": 0,
  "eligible_opportunity": null,
  "opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "selected_candidate": null,
  "phase_12_item_reused": false
}
```
