# Hermes Phase 14Z — Image Upload Approval Checklist

## Purpose

Phase 14Z creates the explicit operator approval checklist for a single future eBay image upload transport step.

It does not redo Phase 14A through Phase 14Y. Phase 14Y baseline:

```text
1400e74 Add Phase 14Y image transport boundary
```

## Current target

```json
{
  "item_id": "206288370789",
  "failed_source_request_id": 5,
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "width": 512,
  "height": 512,
  "longest_side": 512
}
```

`request_id=5` must not be reused. It already reached eBay once through `ReviseFixedPriceItem` and has a recorded failed execution result.

## Why PictureURL is required

A future listing image remediation packet cannot send a local workstation path to eBay. eBay listing image replacement requires a marketplace-compatible `PictureURL` that eBay can fetch or has already hosted.

The expected future output of an upload transport step is:

```json
{
  "PictureURL": "<eBay-hosted picture URL returned by UploadSiteHostedPictures>"
}
```

## Why the local file path is insufficient

The local file path:

```text
/Users/parksungmin/Downloads/torune.jpeg
```

is valid internal evidence and has been validated as a 512x512 JPEG, but it is not an HTTPS URL and is not available to eBay as `PictureDetails.PictureURL`.

## What UploadSiteHostedPictures will do

A future gated upload phase may call eBay Trading API operation:

```text
UploadSiteHostedPictures
```

It will upload the already-validated local JPEG candidate and should return a hosted `PictureURL`.

That returned `PictureURL` can then be recorded as an internal artifact for a later image-aware packet/request flow.

## Why this is not a listing revise

The image upload transport step is not a listing revise.

It must not call:

```text
ReviseFixedPriceItem
```

It must not change:

- title
- item_specifics
- description
- price
- inventory
- quantity
- category
- shipping
- payment
- returns
- listing images

The upload phase may only perform the approved image upload transport and record the returned `PictureURL`. A later phase must create a new request/packet and obtain separate approval before any listing revise.

## Why explicit approval is required

Even though `UploadSiteHostedPictures` is not itself a listing revise, it is still an eBay API operation and can create marketplace-hosted image state. Therefore it requires explicit operator approval, exact target checks, a dedicated environment flag, and one-attempt-only execution controls.

## Exact approval text

The operator must copy this exact text in a later phase before any upload transport can be enabled:

```text
eBay image upload transport approval.
item_id=206288370789 only.
image_path=/Users/parksungmin/Downloads/torune.jpeg only.
candidate_sha256=sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47 exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
One upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Future command placeholder

The future upload transport command placeholder is:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write
```

Phase 14Z adds the placeholder, but it remains blocked until a later phase supplies exact explicit operator approval and enables the implementation.

## Safety gates for future upload

A future image upload transport must require:

```json
{
  "explicit_operator_approval": true,
  "dedicated_environment_flag": "HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true",
  "exact_item_id_match": "206288370789",
  "exact_image_path_match": "/Users/parksungmin/Downloads/torune.jpeg",
  "exact_candidate_sha256_match": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem",
  "one_upload_attempt_only": true,
  "record_returned_picture_url_only": true,
  "request_id_5_must_not_be_reused": true
}
```

## Commands

Approval checklist:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-approval-checklist --item-id=206288370789
```

Future placeholder, still blocked:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write
```

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/api/ebayAPI.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-transport-plan --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-transport-dry-run --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-approval-checklist --item-id=206288370789
git diff --stat
```
