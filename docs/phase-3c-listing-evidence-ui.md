# Hermes Phase 3C — Listing Evidence in Opportunity Review UI

## Purpose

Phase 3C exposes Phase 3B read-only Listing Quality Evidence inside the Hermes Opportunity Review UI for `listing_quality_review` opportunities.

This phase does not redo Phase 2, Phase 3A, or Phase 3B.

Baseline:

```text
6312b89 Add listing quality evidence mode
```

## Files changed

- `src/web/routes/opportunityInbox.js`
- `public/js/hermesOpportunityReview.js`
- `public/index.html`

## API route

New read-only route:

```http
GET /api/opportunity-inbox/hermes/:id/listing-evidence
```

Implementation:

```js
buildListingQualityEvidence({ opportunityId: id })
```

The route is mounted under the existing authenticated Opportunity Inbox router and returns:

```json
{
  "data": {
    "sku": "...",
    "opportunity": {
      "id": 0,
      "type": "listing_quality_review",
      "status": "...",
      "title": "..."
    },
    "listing_quality_signal": {},
    "score_breakdown": {},
    "reasons": [],
    "recommendation": "...",
    "source": "signal_engine",
    "read_only": true,
    "raw_refs": {}
  }
}
```

## Supported opportunity type

The route relies on the Phase 3B service validation. It only supports Opportunity Inbox rows where:

- `metadata.hermes_generated === true`
- `opportunity_type === 'listing_quality_review'`
- `metadata.sku` exists

Other opportunity types are rejected by the service and are not shown with a Listing Evidence button in the UI.

## UI behavior

The Hermes Opportunity Review UI now:

1. Keeps the existing list/detail/review workflow unchanged.
2. Shows a `Listing Evidence` panel only when selected row type is `listing_quality_review`.
3. Loads evidence on demand through:

```js
fetch(`/api/opportunity-inbox/hermes/${id}/listing-evidence`, { credentials: 'include' })
```

4. Displays:
   - `listing_quality_signal`
   - normalized Listing Quality Score
   - score breakdown table
   - reasons
   - recommendation
   - `raw_refs`
5. Caches evidence client-side for the selected row and allows reload.

## Safety constraints

The new route and UI are read-only.

They do not:

- update opportunity rows
- create action plans
- call AI
- call marketplace write APIs
- change price data
- change inventory data
- change listing data
- approve or execute marketplace actions

Review status actions remain unchanged and still use the existing Hermes review route:

```http
POST /api/opportunity-inbox/hermes/:id/review
```

`approved` continues to mean Opportunity Inbox human review state only, not marketplace execution approval.

## Validation

Syntax checks:

```bash
node --check src/web/routes/opportunityInbox.js
node --check public/js/hermesOpportunityReview.js
node --check src/services/hermesListingIntelligence.js
```

All passed.

Write-path audit:

- The evidence API route only calls `buildListingQualityEvidence({ opportunityId: id })`.
- The UI evidence loader only performs a GET request to `/listing-evidence`.
- No insert/update/upsert/delete was added to the evidence route or UI evidence path.
- No action planner call was added to the evidence route.

Diff summary at validation time:

```text
public/index.html                    |  2 +-
public/js/hermesOpportunityReview.js | 87 ++++++++++++++++++++++++++++++++++++
src/web/routes/opportunityInbox.js   | 14 ++++++
```

## Notes

`public/index.html` was updated only to bump the `hermesOpportunityReview.js` cache-busting query string so browsers load the Phase 3C UI code.
