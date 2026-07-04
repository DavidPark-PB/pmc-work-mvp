# Hermes Phase 14AA — Image Upload Transport

## Purpose

Phase 14AA implements and executes the single explicitly approved eBay image upload transport path for the validated replacement image candidate.

It does not redo Phase 14A through Phase 14Z. Phase 14Z baseline:

```text
aecab4b Add Phase 14Z image upload approval checklist
```

## Exact approval scope

Approved target:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "width": 512,
  "height": 512,
  "longest_side": 512,
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem"
}
```

The approved upload scope allows one `UploadSiteHostedPictures` attempt only. It does not approve a listing revise.

## UploadSiteHostedPictures behavior

Phase 14AA uses the existing `src/api/ebayAPI.js` Trading API auth/token path. No new auth logic is created.

The upload payload contains only:

- `PictureName`
- `PictureSet`
- `PictureData` from the validated local JPEG candidate

Expected successful output:

```json
{
  "PictureURL": "<eBay-hosted URL>"
}
```

## Why ReviseFixedPriceItem is forbidden

`ReviseFixedPriceItem` changes listing state. The Phase 14AA approval is only for creating an eBay-hosted picture URL. It does not approve applying that URL to a listing.

Phase 14AA must not change:

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

## One-attempt rule

The upload command may call `UploadSiteHostedPictures` at most once for the exact item/candidate tuple.

If eBay returns failure, Phase 14AA records the failure and stops. It does not retry automatically.

## Result recording

Phase 14AA records internal metadata only in:

```text
data/hermes-image-upload-results.json
```

On success it records:

- item_id
- image_path
- candidate_sha256
- eBay Ack
- PictureURL
- timestamp
- upload_attempt_count=1
- marketplace_image_upload_performed=true
- listing_revise_performed=false
- revise_fixed_price_item_called=false

On failure it records:

- item_id
- image_path
- candidate_sha256
- eBay Ack or exception
- errors
- warnings
- timestamp
- upload_attempt_count=1
- marketplace_image_upload_performed=false
- listing_revise_performed=false
- revise_fixed_price_item_called=false

## Duplicate guard

After any upload attempt for this exact item/candidate, future write attempts are blocked by duplicate guard.

After a successful upload, future dry-run/result commands report the stored `PictureURL` and `ready_for_image_aware_packet_creation=true`.

## Next step after PictureURL is available

A later phase may use the recorded `PictureURL` to create a new image-aware request/packet. That later packet still requires explicit approval before any `ReviseFixedPriceItem` call.

`request_id=5` must remain non-retryable and must not be reused.

## Commands

Pre-live validation:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/api/ebayAPI.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-approval-checklist --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-transport-dry-run --item-id=206288370789
```

Approved one-shot upload:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write
```

Post-upload result:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
```

Duplicate guard validation:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write
```
