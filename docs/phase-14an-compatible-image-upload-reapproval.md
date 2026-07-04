# Hermes Phase 14AN — Compatible Image Upload Reapproval

## Purpose

Phase 14AN creates a read-only readiness audit and explicit approval checklist for exactly one future `UploadSiteHostedPictures` attempt using the Phase 14AM preferred compatible image variant.

It does not redo Phase 14A through Phase 14AM. Phase 14AM baseline:

```text
4c9c69f Add Phase 14AM compatible image variant generation
```

## Current state

Target:

```json
{
  "item_id": "206288370789"
}
```

Prior eBay Picture Services failures:

```json
[
  {
    "phase": "14AH",
    "candidate": "original",
    "error_code": "21916550",
    "picture_url": null
  },
  {
    "phase": "14AK",
    "candidate": "sanitized_baseline",
    "error_code": "21916550",
    "picture_url": null
  }
]
```

Phase 14AL confirmed:

- token/auth is not the blocker
- local `PictureData` base64 roundtrip is valid
- decoded payload bytes match the sanitized file bytes
- XML escaping does not alter base64

Phase 14AM generated compatible local variants and selected this preferred candidate:

```json
{
  "variant_id": "srgb-white-800-q90-420-baseline",
  "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "width": 800,
  "height": 800,
  "color_space": "srgb",
  "baseline_jpeg_detected": true,
  "progressive": false,
  "chroma_subsampling": "4:2:0",
  "metadata_stripped": true,
  "white_background": true,
  "eligible_for_ebay_picture_policy": true
}
```

## Scope

Phase 14AN is approval checklist only.

It does not:

- upload images
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- call AI
- push commits

## Compatible upload readiness command

```bash
npm run hermes:agent -- ebay-listing-quality-image-compatible-upload-readiness --item-id=206288370789
```

The command verifies:

- exact item id is `206288370789`
- Phase 14AM variant audit is ready
- preferred variant exists
- preferred variant path matches exactly
- preferred variant sha256 matches exactly
- preferred variant file exists locally
- preferred variant is 800x800
- preferred variant is sRGB
- preferred variant is baseline/non-progressive JPEG
- preferred variant uses 4:2:0 chroma subsampling
- preferred variant metadata is stripped
- preferred variant uses white background
- preferred variant is eBay 500px policy eligible
- original candidate failed with eBay `21916550`
- sanitized baseline candidate failed with eBay `21916550`
- token/auth is ruled out
- payload roundtrip is valid
- PictureURL remains unavailable
- no previous compatible variant upload attempt exists

Readiness result:

```json
{
  "ready_for_compatible_variant_upload_reapproval": true,
  "new_explicit_upload_approval_required": true,
  "blockers": []
}
```

## Compatible upload approval checklist command

```bash
npm run hermes:agent -- ebay-listing-quality-image-compatible-upload-approval-checklist --item-id=206288370789
```

## Exact approval text

The checklist emits this exact operator approval text:

```text
Compatible eBay image upload transport approval after repeated 21916550 image data failures.
item_id=206288370789 only.
image_path=/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg only.
candidate_sha256=sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
One compatible variant upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Safety gates for the later upload phase

A future execution phase must consume the exact approval text and enforce:

```json
{
  "exact_item_id": "206288370789",
  "exact_image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "exact_candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem",
  "one_compatible_variant_upload_attempt_only": true,
  "record_returned_picture_url_only": true,
  "no_listing_revise_in_upload_phase": true
}
```

## Why no upload occurred

Phase 14AN only creates the reapproval checklist. It does not contain approval to execute an eBay API operation. A later phase may execute one upload attempt only if the exact approval text is supplied.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-compatible-variant-audit --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-compatible-upload-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-compatible-upload-approval-checklist --item-id=206288370789
git diff --stat
```
