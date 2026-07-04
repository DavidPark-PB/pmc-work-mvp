# Hermes Phase 14AB — Corrected Image Upload Reapproval

## Purpose

Phase 14AB audits the Phase 14AA corrected-upload failure and creates a new explicit re-approval checklist for one corrected `UploadSiteHostedPictures` attempt.

It does not redo Phase 14A through Phase 14AA. Phase 14AA baseline:

```text
b18d4f6 Add Phase 14AA image upload transport
```

## What failed in Phase 14AA

Phase 14AA executed the approved image upload command once for:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47"
}
```

The attempt failed before eBay because of a local implementation exception:

```text
EbayAPI is not defined
```

The missing import was fixed after the failed local attempt.

## Why no eBay upload happened

Because the exception occurred before constructing/calling the eBay API helper:

- `UploadSiteHostedPictures` was not called.
- No eBay API call occurred.
- No PictureURL was returned.
- No marketplace image upload occurred.
- No listing revise occurred.
- `ReviseFixedPriceItem` was not called.

## Why automatic retry is not allowed

The Phase 14AA approval allowed one upload attempt only. Even though the failure was local and pre-eBay, Hermes recorded an attempt result and the duplicate guard blocks automatic retry.

A corrected upload attempt requires a new explicit operator approval.

## Why a new explicit approval is required

The corrected attempt would now be able to reach the eBay upload transport path. Since `UploadSiteHostedPictures` creates marketplace-hosted image state, the operator must approve the corrected attempt explicitly after seeing the Phase 14AA failure audit.

## Exact approval text

The operator must copy this exact text in a later phase before a corrected upload can be enabled:

```text
Corrected eBay image upload transport approval after local pre-eBay exception.
item_id=206288370789 only.
image_path=/Users/parksungmin/Downloads/torune.jpeg only.
candidate_sha256=sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47 exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
One corrected upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Safety gates for corrected upload attempt

A future corrected upload attempt must require:

```json
{
  "new_explicit_operator_approval": true,
  "reason": "Phase 14AA failed locally before eBay: EbayAPI is not defined",
  "dedicated_environment_flag": "HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true",
  "exact_item_id_match": "206288370789",
  "exact_image_path_match": "/Users/parksungmin/Downloads/torune.jpeg",
  "exact_candidate_sha256_match": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem",
  "one_corrected_upload_attempt_only": true,
  "record_returned_picture_url_only": true,
  "no_listing_revise_in_upload_phase": true,
  "request_id_5_must_not_be_reused": true
}
```

## Commands

Corrected readiness audit:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-corrected-readiness --item-id=206288370789
```

Corrected reapproval checklist:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-reapproval-checklist --item-id=206288370789
```

Future placeholder only, still blocked until exact new approval is supplied in a later phase:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write
```

## Safety guarantees

Phase 14AB does not:

- upload images
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- create a listing execution request
- create a listing revise packet
- perform marketplace writes
- execute live
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- call AI
- push commits

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/api/ebayAPI.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-corrected-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-reapproval-checklist --item-id=206288370789
git diff --stat
```
