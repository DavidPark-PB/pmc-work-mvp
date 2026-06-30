# Hermes Phase 3E — Listing Evidence E2E Validation

Verification timestamp: 2026-06-30T15:54:29Z

## Purpose

Phase 3E creates and validates one controlled Hermes-generated `listing_quality_review` opportunity so the Phase 3C Listing Evidence UI can be tested end-to-end.

This phase does not redo Phase 2 or Phase 3A~3D.

Baseline:

```text
5b4813d Add targeted listing quality opportunity filter
```

## Safety scope

This phase intentionally allowed exactly one database write to `opportunity_inbox`, using the existing targeted writer from Phase 3D.

No other write or execution actions were performed.

Safety constraints verified:

- No marketplace writes.
- No price changes.
- No inventory changes.
- No listing changes.
- No AI calls.
- No review status actions.
- No approve/reject/archive/reviewing transition.
- No action plan creation.

## Step 1 — Pre-check existing `listing_quality_review` rows

Command:

```bash
npm run hermes:agent -- opportunity-list --opportunity_type=listing_quality_review --limit=10
```

Observed:

```json
{
  "count": 0,
  "data": []
}
```

Conclusion: no Hermes-generated `listing_quality_review` row existed before Phase 3E.

## Step 2 — Create exactly one targeted row

Because no existing row was present, Phase 3E performed one intentional DB write with the targeted writer:

```bash
npm run hermes:agent -- opportunity-write --sku=PHASE3B-LISTING-QUALITY-FIXTURE --type=listing_quality_review --write
```

Observed write result:

```json
{
  "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
  "dry_run": false,
  "created": [
    {
      "row": {
        "id": 6,
        "opportunity_type": "listing_quality_review",
        "priority": "normal",
        "status": "new",
        "metadata": {
          "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
          "candidate_type": "listing_quality_review",
          "source_signals": ["listing_quality_low"],
          "source_recommendations": ["listing_quality_review"],
          "hermes_generated": true,
          "requires_human_review": true
        }
      }
    }
  ],
  "skipped_duplicates": [],
  "errors": [],
  "type_filter": "listing_quality_review"
}
```

Created row id:

```text
6
```

## Step 3 — Re-list and capture row

Command:

```bash
npm run hermes:agent -- opportunity-list --opportunity_type=listing_quality_review --limit=10
```

Observed:

```json
{
  "count": 1,
  "data": [
    {
      "id": 6,
      "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
      "type": "listing_quality_review",
      "priority": "normal",
      "status": "new",
      "source_signals": ["listing_quality_low"],
      "source_recommendations": ["listing_quality_review"],
      "hermes_review": null
    }
  ]
}
```

The row remained in `new` status. No review action was performed.

## Step 4 — Validate Listing Evidence API equivalent

The route implementation is:

```http
GET /api/opportunity-inbox/hermes/:id/listing-evidence
```

which calls:

```js
buildListingQualityEvidence({ opportunityId: id })
```

For Phase 3E validation, the equivalent local service call was used for id `6` and the row was read directly for metadata verification.

Observed result:

```json
{
  "id": 6,
  "row": {
    "opportunity_type": "listing_quality_review",
    "status": "new",
    "hermes_generated": true,
    "source_signals": ["listing_quality_low"],
    "source_recommendations": ["listing_quality_review"],
    "created_at": "2026-06-30T15:53:42.819705",
    "updated_at": "2026-06-30T15:53:42.819705"
  },
  "evidence": {
    "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
    "opportunity": {
      "id": 6,
      "type": "listing_quality_review",
      "status": "new",
      "title": "Listing quality review needed for SKU PHASE3B-LISTING-QUALITY-FIXTURE"
    },
    "listing_quality_signal_type": "listing_quality_low",
    "source": "signal_engine",
    "read_only": true,
    "reasons": [
      "missing_listing_id",
      "missing_title",
      "missing_or_zero_price",
      "이미지 보강",
      "item specifics 보강",
      "return policy 확인",
      "category 확인"
    ],
    "recommendation": "이미지 보강 + item specifics 보강 + return policy 확인 + category 확인",
    "raw_refs": {
      "context_source": "db_fallback",
      "connector_skipped": "read_only",
      "listing_id": "",
      "enrichment_available": false
    }
  }
}
```

Checks:

```json
{
  "row_type_listing_quality_review": true,
  "hermes_generated_true": true,
  "source_signals_include_listing_quality_low": true,
  "evidence_source_signal_engine": true,
  "evidence_read_only_true": true,
  "status_unchanged_new": true
}
```

## Validation commands

Syntax checks:

```bash
node --check src/agents/opportunityAgent.js
node --check src/services/opportunityInbox.js
node --check src/web/routes/opportunityInbox.js
node --check public/js/hermesOpportunityReview.js
```

All passed.

Final row list check:

```json
{
  "count": 1,
  "rows": [
    {
      "id": 6,
      "type": "listing_quality_review",
      "status": "new",
      "source_signals": ["listing_quality_low"]
    }
  ]
}
```

## E2E conclusion

Phase 3E successfully created exactly one controlled Hermes-generated `listing_quality_review` Opportunity Inbox row for the Phase 3C Listing Evidence UI.

The row is suitable for UI testing:

- `id`: `6`
- `sku`: `PHASE3B-LISTING-QUALITY-FIXTURE`
- `type`: `listing_quality_review`
- `status`: `new`
- `metadata.hermes_generated`: `true`
- `source_signals`: includes `listing_quality_low`
- Listing Evidence source: `signal_engine`
- Listing Evidence read-only flag: `true`

No review status action was performed, and no marketplace/price/inventory/listing action was executed.
