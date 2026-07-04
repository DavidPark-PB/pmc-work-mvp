# Hermes Phase 14AC — Corrected Image Upload Execution

## Purpose

Phase 14AC consumes the exact corrected image upload approval supplied after Phase 14AB and allows one corrected `UploadSiteHostedPictures` attempt for the Phase 14AA local pre-eBay exception case.

It does not redo Phase 14A through Phase 14AB. Phase 14AB baseline:

```text
dc3a599 Add Phase 14AB corrected image upload reapproval
```

## Approved scope

Exact approved target:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem"
}
```

## Corrected approval text

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

## Corrected duplicate guard behavior

The normal duplicate guard continues to block repeated upload attempts. Phase 14AC allows a single exception only when all of the following are true:

- the previous attempt exists
- the previous attempt failed locally before eBay
- the previous error is `EbayAPI is not defined`
- no previous corrected upload attempt exists
- the exact corrected approval text is supplied
- `HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true`
- `--write` is supplied

After the corrected attempt is recorded, future attempts for the same item/candidate are blocked by `duplicate_corrected_image_upload_attempt_for_item_candidate`.

## Safety guarantees

Phase 14AC may call only `UploadSiteHostedPictures` after exact corrected approval.

It must not:

- call `ReviseFixedPriceItem`
- create a listing execution request
- create a listing revise packet
- perform a listing revise
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or listing images
- call AI
- push commits

## Command shape

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text='<exact corrected approval text>'
```

## Validation

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/api/ebayAPI.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-corrected-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-reapproval-checklist --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
git diff --stat
```
