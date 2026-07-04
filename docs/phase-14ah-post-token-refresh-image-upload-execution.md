# Hermes Phase 14AH — Post-Token-Refresh Image Upload Execution

## Purpose

Phase 14AH consumes the exact post-token-refresh image upload approval supplied after Phase 14AG and allows one new `UploadSiteHostedPictures` attempt for the validated replacement image candidate.

It does not redo Phase 14A through Phase 14AG. Phase 14AG baseline:

```text
fb7475a Add Phase 14AG post-token-refresh upload reapproval
```

## Approval consumed

```text
Post-token-refresh eBay image upload transport approval.
item_id=206288370789 only.
image_path=/Users/parksungmin/Downloads/torune.jpeg only.
candidate_sha256=sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47 exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
One post-token-refresh upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Execution result

The approved command was run once:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text='<exact post-token-refresh approval text>'
```

Result:

```json
{
  "phase": "14AH",
  "blocked": false,
  "upload_site_hosted_pictures_called": true,
  "actual_ebay_call": true,
  "actual_network_call": true,
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

Phase 14AH did not:

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

The result was recorded as a post-token-refresh upload attempt. Future upload transport calls for the same item/candidate are blocked by the one-attempt-only guard unless a later phase deliberately introduces a new explicit approval and a new validated candidate/remediation path.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789
git diff --stat
```
