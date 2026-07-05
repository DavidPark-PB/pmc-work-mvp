# Hermes Phase 14AO — Compatible Image Upload Execution

## Purpose

Phase 14AO consumes the exact Phase 14AN operator approval and performs exactly one `UploadSiteHostedPictures` attempt using the preferred compatible JPEG variant from Phase 14AM.

No listing revise is allowed in this phase.

## Operator approval consumed

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
  "metadata_stripped": true
}
```

## Execution command

```bash
approval_text=$'Compatible eBay image upload transport approval after repeated 21916550 image data failures.\nitem_id=206288370789 only.\nimage_path=/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg only.\ncandidate_sha256=sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b exact match only.\nAllowed operation: UploadSiteHostedPictures only.\nForbidden operation: ReviseFixedPriceItem.\nForbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.\nOne compatible variant upload attempt only.\nRecord returned PictureURL only.\nNo listing revise in the upload phase.'
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text="$approval_text"
```

## Result

The single approved compatible variant upload attempt reached eBay Picture Services.

```json
{
  "phase": "14AO",
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
      "code": "21916984",
      "severity": "Error",
      "short_message": "Invalid IAF token.",
      "long_message": "IAF token supplied is invalid."
    }
  ]
}
```

Important: this failure is auth/token-related (`21916984`), not the previous Picture Services image corruption error (`21916550`). Because the approved instruction allowed exactly one compatible variant upload attempt only, the upload was not retried.

## Recorded result

The result was appended to the local upload result registry:

```json
{
  "phase": "14AO",
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "ebay_ack": "Failure",
  "picture_url": null,
  "compatible_variant_upload_attempt": true,
  "compatible_variant_upload_approval_text_matched": true,
  "upload_attempted": true,
  "upload_succeeded": false,
  "listing_revise_performed": false,
  "revise_fixed_price_item_called": false,
  "source": "phase_14ao_compatible_variant_upload_site_hosted_pictures_result"
}
```

## Safety

Confirmed during execution result:

- `ReviseFixedPriceItem` was not called.
- No listing revise was performed.
- No listing fields were changed.
- No title, item specifics, description, price, inventory, quantity, category, shipping, payment, or returns changes were made.
- No execution request or revise packet was created.
- No AI calls were made.
- No push was performed.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

All syntax checks passed.
