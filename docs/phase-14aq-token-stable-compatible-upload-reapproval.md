# Hermes Phase 14AQ — Token-Stable Compatible Upload Reapproval

## Purpose

Phase 14AQ creates a read-only token-stable reapproval checklist for one future compatible-variant `UploadSiteHostedPictures` attempt after Phase 14AO failed with `21916984 Invalid IAF token`.

It does not redo Phase 14A through Phase 14AP. Phase 14AP baseline:

```text
2a2d45d Add Phase 14AP eBay token regression audit
```

## Scope

Phase 14AQ does not:

- upload images
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- modify token values
- print token secrets
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- call AI
- push commits

## Commands added

```bash
npm run hermes:agent -- ebay-compatible-image-upload-token-stability-readiness --item-id=206288370789
npm run hermes:agent -- ebay-compatible-image-upload-token-stable-approval-checklist --item-id=206288370789
```

## Token-stability readiness result

The readiness command verifies that the latest auth failure was the Phase 14AO compatible variant attempt and that the currently selected token metadata was updated after that failure.

Observed readiness summary:

```json
{
  "phase": "14AQ",
  "item_id": "206288370789",
  "latest_invalid_iaf_token_failure_phase": "14AO",
  "latest_invalid_iaf_token_failure_timestamp": "2026-07-05T00:07:21.866Z",
  "latest_invalid_iaf_token_failure_error_codes": ["21916984"],
  "current_selected_token_source": "database_platform_tokens",
  "current_token_updated_at": "2026-07-05T00:11:14.392",
  "current_token_expires_at": "2026-07-05T02:11:14.392",
  "token_updated_after_latest_invalid_iaf_failure": true,
  "token_stale_or_expired": false,
  "database_token_still_overrides_env_token": true,
  "compatible_candidate_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "compatible_candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "ready_for_token_stable_upload_reapproval": true,
  "blockers": []
}
```

Exact readiness gates:

```json
{
  "item_id_exact": true,
  "latest_invalid_iaf_token_failure_phase_14ao": true,
  "latest_invalid_iaf_token_failure_has_21916984": true,
  "current_selected_token_source_database": true,
  "token_environment_production": true,
  "endpoint_environment_production": true,
  "token_updated_after_latest_invalid_iaf_failure": true,
  "token_not_stale_or_expired": true,
  "token_has_positive_seconds_until_expiry": true,
  "database_token_still_overrides_env_token": true,
  "compatible_candidate_path_exact": true,
  "compatible_candidate_sha256_exact": true,
  "compatible_candidate_file_exists": true,
  "compatible_candidate_policy_eligible": true,
  "compatible_candidate_materially_different": true,
  "no_previous_token_stable_compatible_upload_attempt": true,
  "picture_url_absent": true,
  "no_listing_revise_after_upload_attempts": true
}
```

## Compatible candidate

The only allowed candidate for the future attempt is:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "width": 800,
  "height": 800,
  "longest_side": 800,
  "color_space": "srgb",
  "baseline_jpeg_detected": true,
  "progressive": false,
  "chroma_subsampling": "4:2:0",
  "metadata_stripped": true,
  "eligible_for_ebay_picture_policy": true,
  "materially_different_from_sanitized": true
}
```

## Exact approval text

The checklist emits this exact operator approval text:

```text
Token-stable compatible eBay image upload transport approval after Phase 14AO Invalid IAF token failure.
item_id=206288370789 only.
image_path=/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg only.
candidate_sha256=sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
Require token updated after the latest Invalid IAF token failure.
Require token not expired at execution time.
One token-stable compatible upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Future upload command

The future upload command remains blocked unless the exact approval text is provided:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text="<exact token-stable compatible approval text>"
```

Phase 14AQ does not run that command.

## Safety note for later execution phase

A later execution phase must re-check token stability at execution time:

- token metadata updated after latest `21916984` failure
- token is not expired at execution time
- no previous token-stable compatible upload attempt exists
- candidate path and sha256 match exactly
- `ReviseFixedPriceItem` remains forbidden
- no listing revise or listing field changes occur
- one upload attempt only

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-token-current-health --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-regression-audit --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-compatible-image-upload-token-stability-readiness --item-id=206288370789
npm run hermes:agent -- ebay-compatible-image-upload-token-stable-approval-checklist --item-id=206288370789
git diff --stat
```
