# Hermes Phase 3B — Listing Quality Evidence Mode

## Purpose

Phase 3B adds a read-only Listing Quality Evidence mode aligned with the Phase 1C Signal Engine and Phase 2 Opportunity Inbox flow.

It does not replace the existing portfolio Listing Intelligence report. The existing report remains available through:

```bash
npm run hermes:market -- listing --days=30
```

The new evidence mode is SKU/opportunity scoped and returns JSON evidence for human review.

## Safety rules

- No DB writes.
- No marketplace writes.
- No AI calls.
- No price changes.
- No inventory changes.
- No listing changes.
- No action execution.
- Uses `buildSkuContext({ sku, readOnly: true })` so marketplace connector sync is skipped.

## Implementation

Service:

```text
src/services/hermesListingIntelligence.js
```

New function:

```js
buildListingQualityEvidence({ sku, opportunityId, days })
```

CLI:

```text
scripts/hermes-market-intelligence.js
```

New command:

```bash
npm run hermes:market -- listing-evidence --sku=<SKU>
```

Optional Opportunity Inbox command:

```bash
npm run hermes:market -- listing-evidence --opportunity-id=<ID>
```

The `--opportunity-id` path is read-only and only accepts Hermes-generated `listing_quality_review` opportunities.

## Canonical trigger

The canonical trigger is the Signal Engine signal:

```text
listing_quality_low
```

Evidence mode reads SKU Context and finds:

```js
context.signals.find(signal => signal.type === 'listing_quality_low')
```

If the signal exists, it is returned as `listing_quality_signal` and its `value.score` / `value.reasons` are treated as the Signal Engine trigger evidence.

If the signal does not exist, the command still returns read-only score evidence, but `listing_quality_signal` is `null` and the recommendation is observation-only.

## Output shape

```json
{
  "sku": "...",
  "opportunity": null,
  "listing_quality_signal": {
    "type": "listing_quality_low",
    "severity": "warning",
    "value": {
      "score": 0,
      "reasons": []
    },
    "detected_at": "ISO8601"
  },
  "score_breakdown": {
    "normalized": 0,
    "total": 0,
    "max": 0,
    "needs_data": 0,
    "scores": {}
  },
  "reasons": [],
  "recommendation": "...",
  "source": "signal_engine",
  "read_only": true,
  "raw_refs": {}
}
```

## Score evidence reused

The evidence mode reuses existing Listing Intelligence score functions where practical:

- title keyword score
- title length score
- image count score
- image quality proxy score
- item specifics score
- shipping score
- return policy score
- category score
- price position score
- sales velocity score
- competitor gap score

It also reuses existing listing improvement classification to produce a human-readable recommendation.

## Opportunity Inbox alignment

For `--opportunity-id=<ID>`, the service validates:

- row exists in `opportunity_inbox`
- `metadata.hermes_generated === true`
- `opportunity_type === 'listing_quality_review'`
- `metadata.sku` is present

Then it builds the same read-only evidence for that SKU.

This command does not alter the opportunity row. Review state transitions remain owned by Phase 2E review actions, and planning remains owned by Phase 2G action planner.

## Validation

Syntax checks:

```bash
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js
```

Evidence command tested with a SKU that produces `listing_quality_low` through read-only SKU Context fallback:

```bash
npm run hermes:market -- listing-evidence --sku=PHASE3B-LISTING-QUALITY-FIXTURE
```

Observed result included:

```json
{
  "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
  "listing_quality_signal": {
    "type": "listing_quality_low",
    "severity": "warning",
    "value": {
      "score": 0,
      "reasons": [
        "missing_listing_id",
        "missing_title",
        "missing_or_zero_price"
      ]
    }
  },
  "source": "signal_engine",
  "read_only": true
}
```

The validation SKU is intentionally a read-only missing-listing fixture; no rows are inserted or updated.

## Notes

On environments where listing enrichment migrations/tables are not present, evidence mode keeps working because the existing Listing Intelligence `safeSelect()` helper treats missing enrichment tables as `needs_data` evidence.

Phase 3B does not modify Safety Foundation and does not add any execution path.
