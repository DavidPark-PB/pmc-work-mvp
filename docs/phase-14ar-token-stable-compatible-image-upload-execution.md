# Hermes Phase 14AR — Token-Stable Compatible Image Upload Execution

## Purpose

Phase 14AR consumes the exact Phase 14AQ token-stable compatible upload approval and performs exactly one `UploadSiteHostedPictures` attempt using the preferred compatible image variant.

No listing revise is allowed in this phase.

## Operator approval consumed

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

## Pre-execution readiness

The Phase 14AQ readiness gate passed immediately before execution:

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
  "seconds_until_expiry": 5350,
  "database_token_still_overrides_env_token": true,
  "ready_for_token_stable_upload_reapproval": true,
  "blockers": []
}
```

## Exact candidate

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

## Execution command

```bash
approval_text=$'Token-stable compatible eBay image upload transport approval after Phase 14AO Invalid IAF token failure.\nitem_id=206288370789 only.\nimage_path=/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg only.\ncandidate_sha256=sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b exact match only.\nAllowed operation: UploadSiteHostedPictures only.\nForbidden operation: ReviseFixedPriceItem.\nForbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.\nRequire token updated after the latest Invalid IAF token failure.\nRequire token not expired at execution time.\nOne token-stable compatible upload attempt only.\nRecord returned PictureURL only.\nNo listing revise in the upload phase.'
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text="$approval_text"
```

## Result

The single approved token-stable compatible variant upload attempt reached eBay Picture Services. Authentication was accepted, and eBay returned the image-data error again:

```json
{
  "phase": "14AR",
  "upload_site_hosted_pictures_called": true,
  "actual_ebay_call": true,
  "actual_network_call": true,
  "ebay_ack": "Failure",
  "picture_url": null,
  "upload_succeeded": false,
  "marketplace_image_upload_performed": false,
  "marketplace_image_upload_failed": true,
  "errors": [
    {
      "code": "21916550",
      "severity": "Error",
      "short_message": "File has corrupt image data",
      "long_message": "Picture Services found a data corruption problem when processing retrieved picture file"
    }
  ],
  "timestamp": "2026-07-05T00:42:28.194Z"
}
```

Interpretation: Phase 14AR ruled the Phase 14AO auth regression out for this token-stable attempt. The failure returned to the original eBay Picture Services image-data rejection (`21916550`) for the compatible image variant. No PictureURL was produced.

## Recorded result

The local upload result registry appended a Phase 14AR result record:

```json
{
  "phase": "14AR",
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "ebay_ack": "Failure",
  "picture_url": null,
  "compatible_variant_upload_attempt": true,
  "token_stable_compatible_variant_upload_attempt": true,
  "token_stable_compatible_variant_upload_approval_text_matched": true,
  "upload_attempted": true,
  "upload_succeeded": false,
  "listing_revise_performed": false,
  "revise_fixed_price_item_called": false,
  "source": "phase_14ar_token_stable_compatible_variant_upload_site_hosted_pictures_result"
}
```

## Safety

Confirmed by execution output:

- `ReviseFixedPriceItem` was not called.
- No listing revise was performed.
- No listing fields were changed.
- No title, item specifics, description, price, inventory, quantity, category, shipping, payment, or returns changes were made.
- No execution request or revise packet was created.
- No token values were printed or modified by this phase.
- No AI calls were made.
- No push was performed.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-compatible-image-upload-token-stability-readiness --item-id=206288370789
git diff --stat
```
