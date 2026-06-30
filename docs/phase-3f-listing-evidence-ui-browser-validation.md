# Hermes Phase 3F — Listing Evidence UI Browser Validation

Validation timestamp: 2026-06-30T16:06:29Z

## Purpose

Phase 3F browser-validates the Hermes Opportunity Review UI Listing Evidence flow using the controlled Phase 3E row.

This phase does not redo Phase 2 or Phase 3A~3E.

Baseline:

```text
26ee454 Add listing evidence E2E validation report
```

Validated row:

```text
opportunity id: 6
sku: PHASE3B-LISTING-QUALITY-FIXTURE
type: listing_quality_review
status: new
```

## Local app

The local app was started for browser validation.

A local legacy admin session was used only to access the protected UI and API. No review/action buttons were clicked.

## Browser validation steps

### 1. Open Hermes Opportunity Review UI

The browser was opened to the local app and navigated to the Hermes Opportunity Review page.

Observed UI:

- Page title: `Hermes Opportunity Review`
- List count: `Hermes-generated 4건`
- Row `#6` visible in the list.

Row `#6` displayed:

```text
new
listing_quality_review
#6
Listing quality review needed for SKU PHASE3B-LISTING-QUALITY-FIXTURE
SKU PHASE3B-LISTING-QUALITY-FIXTURE · priority normal
```

### 2. Select row id 6

Row `#6` was selected in the UI.

Detail panel displayed:

```text
new
#6
Listing quality review needed for SKU PHASE3B-LISTING-QUALITY-FIXTURE
SKU PHASE3B-LISTING-QUALITY-FIXTURE · type listing_quality_review
priority normal
status new
source_signals listing_quality_low
source_recommendations listing_quality_review
```

The Listing Evidence panel was visible for row `#6`.

### 3. Confirm panel is type-gated

A non-listing row was selected for comparison:

```text
#5 price_or_margin_review
```

Result:

```json
{
  "nonListingRow5HasEvidenceButton": false,
  "row6HasEvidenceButtonAfterReselect": true
}
```

Conclusion: the Listing Evidence panel/button appears for `listing_quality_review` and not for `price_or_margin_review`.

### 4. Load evidence

The `Load evidence` button was clicked for row `#6`.

The browser UI loaded evidence successfully and displayed:

- `Listing Quality Evidence`
- `source: signal_engine`
- `normalized score`: `33.3`
- `signal`: `listing_quality_low`
- `listing_quality_signal`
- `score breakdown`
- `reasons`
- `recommendation`
- `raw_refs`

Visible evidence excerpt:

```text
Listing Quality Evidence
source: signal_engine
normalized score
33.3
signal
listing_quality_low
listing_quality_signal
{
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
}
score breakdown
score points status reason
title_keyword_score - needs_data title 없음
title_length_score - needs_data title 없음
image_count_score 0/10 needs_data image_url 없음
image_quality_proxy_score - needs_data image_url 없음
item_specifics_score - needs_data item specifics 없음/미수집
shipping_score 10/10 ok 무료배송
return_policy_score - needs_data return policy 미수집
category_score - needs_data category 미수집
price_position_score - needs_data 경쟁가 매핑 없음
sales_velocity_score 0/10 watch 최근 30일 0개 판매
reasons
missing_listing_id missing_title missing_or_zero_price 이미지 보강 item specifics 보강 return policy 확인 category 확인
recommendation
이미지 보강 + item specifics 보강 + return policy 확인 + category 확인
raw_refs
{
  "context_source": "db_fallback",
  "connector_skipped": "read_only",
  "listing_id": "",
  "enrichment_available": false
}
```

## API evidence load validation

A browser fetch to the actual API route was also validated:

```http
GET /api/opportunity-inbox/hermes/6/listing-evidence
```

Observed browser/API result:

```json
{
  "ok": true,
  "status": 200,
  "source": "signal_engine",
  "read_only": true,
  "signal": "listing_quality_low",
  "hasScore": true
}
```

## Row status validation

After browser validation, row `#6` was re-listed from the CLI:

```bash
npm run hermes:agent -- opportunity-list --opportunity_type=listing_quality_review --limit=10
```

Observed:

```json
{
  "id": 6,
  "type": "listing_quality_review",
  "status": "new",
  "source_signals": ["listing_quality_low"],
  "hermes_review": null
}
```

Conclusion: row `#6` remained `new`; no review status action was performed.

## Syntax validation

```bash
node --check public/js/hermesOpportunityReview.js
node --check src/web/routes/opportunityInbox.js
```

Both passed.

## Safety notes

No action buttons were clicked:

- `reviewing` not clicked
- `approved` not clicked
- `rejected` not clicked
- `archived` not clicked

No action plans were created.

No marketplace writes, price changes, inventory changes, listing changes, or AI calls were performed.

Browser console contained unrelated pre-existing dashboard loader errors from `dashboard.js` while the Hermes Opportunity Review target flow worked correctly. These errors were not from the Listing Evidence flow.

## Conclusion

Phase 3F browser validation passed.

The Hermes Opportunity Review UI can display row `#6`, type-gate the Listing Evidence section to `listing_quality_review`, load evidence on demand through the API, and render the required fields while preserving row status and safety constraints.
