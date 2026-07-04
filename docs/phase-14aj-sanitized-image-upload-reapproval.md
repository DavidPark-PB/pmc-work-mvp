# Hermes Phase 14AJ — Sanitized Image Upload Reapproval

## Purpose

Phase 14AJ creates a read-only readiness audit and explicit operator approval checklist for one future `UploadSiteHostedPictures` attempt using the sanitized local JPEG candidate created in Phase 14AI.

It does not redo Phase 14A through Phase 14AI. Phase 14AI baseline:

```text
0e1a2a1 Add Phase 14AI image corruption remediation
```

## Current state

Original candidate:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47"
}
```

Phase 14AH reached eBay Picture Services, but eBay returned:

```json
{
  "ErrorCode": "21916550",
  "ShortMessage": "File has corrupt image data"
}
```

No `PictureURL` exists.

Phase 14AI created a sanitized local JPEG candidate:

```json
{
  "sanitized_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
  "sanitized_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
  "sanitized_width": 512,
  "sanitized_height": 512,
  "sanitized_policy_eligibility": true
}
```

## Why this phase does not upload

The sanitized candidate has not been approved for marketplace upload yet. `UploadSiteHostedPictures` is an eBay API operation and requires a separate exact operator approval even though it is not a listing revise.

Phase 14AJ only prepares the readiness audit and exact approval checklist. It does not call eBay.

## Readiness command

```bash
npm run hermes:agent -- ebay-listing-quality-image-sanitized-upload-readiness --item-id=206288370789
```

The command verifies:

- original candidate failed with eBay `21916550`
- sanitized candidate exists
- sanitized path matches the internal candidate path
- sanitized sha256 matches exactly
- sanitized dimensions are 512x512
- sanitized candidate satisfies the 500px longest-side policy
- no `PictureURL` exists yet
- previous upload attempts must not be reused
- `request_id=5` must not be reused
- a new explicit sanitized upload approval is required

## Exact approval text

The approval checklist emits this exact operator text for a later phase to consume:

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

## Approval checklist command

```bash
npm run hermes:agent -- ebay-listing-quality-image-sanitized-upload-approval-checklist --item-id=206288370789
```

## Safety gates

A future sanitized image upload phase must require:

```json
{
  "exact_item_id": "206288370789",
  "exact_image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
  "exact_candidate_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem",
  "one_sanitized_upload_attempt_only": true,
  "record_returned_picture_url_only": true,
  "no_listing_revise_in_upload_phase": true
}
```

## Safety guarantees

Phase 14AJ does not:

- upload images
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- call AI
- push commits

## Why another phase is required

Phase 14AJ only emits the exact approval text. A later phase must consume that exact text, gate a single upload attempt, record either the returned `PictureURL` or eBay failure, and then stop. No listing revise may happen in the upload phase.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-sanitized-candidate-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-sanitized-upload-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-sanitized-upload-approval-checklist --item-id=206288370789
git diff --stat
```
