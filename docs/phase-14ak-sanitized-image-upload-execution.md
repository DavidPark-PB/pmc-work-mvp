# Hermes Phase 14AK — Sanitized Image Upload Execution

## Purpose

Phase 14AK consumes the exact sanitized image upload approval supplied after Phase 14AJ and allows one `UploadSiteHostedPictures` attempt for the sanitized local JPEG candidate.

It does not redo Phase 14A through Phase 14AJ. Phase 14AJ baseline:

```text
38daa80 Add Phase 14AJ sanitized image upload reapproval
```

## Approval consumed

```text
Sanitized eBay image upload transport approval after image data failure.
item_id=206288370789 only.
image_path=/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg only.
candidate_sha256=sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
One sanitized upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Execution command

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text='<exact sanitized approval text>'
```

## Execution result

The approved sanitized upload attempt reached eBay Picture Services.

Result:

```json
{
  "phase": "14AK",
  "blocked": false,
  "upload_site_hosted_pictures_called": true,
  "actual_ebay_call": true,
  "actual_network_call": true,
  "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
  "candidate_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
  "ebay_ack": "Failure",
  "picture_url": null,
  "image_uploaded": false,
  "errors": [
    {
      "code": "21916550",
      "short_message": "File has corrupt image data",
      "long_message": "Picture Services found a data corruption problem when processing retrieved picture file"
    }
  ]
}
```

No `PictureURL` was returned.

## Safety outcome

Phase 14AK did not:

- call `ReviseFixedPriceItem`
- perform a listing revise
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or listing images
- create a listing execution request
- create a listing revise packet
- print token values
- call AI
- push commits

The only eBay API operation attempted was `UploadSiteHostedPictures`.

## Duplicate guard outcome

The result was recorded with:

```json
{
  "phase": "14AK",
  "sanitized_upload_attempt": true,
  "sanitized_upload_approval_text_matched": true
}
```

Future upload transport calls for the same sanitized candidate are blocked by the duplicate guard unless a later phase deliberately introduces a new explicit approval and a new remediation path.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789
git diff --stat
```
