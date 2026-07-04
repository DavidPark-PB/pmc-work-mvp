# Hermes Phase 14AI — Image Corruption Remediation

## Purpose

Phase 14AI creates a local image data corruption audit and sanitized replacement image candidate workflow after the Phase 14AH post-token-refresh `UploadSiteHostedPictures` attempt reached eBay Picture Services but failed.

It does not redo Phase 14A through Phase 14AH. Phase 14AH baseline:

```text
014afd4 Add Phase 14AH post-token-refresh upload execution
```

## Phase 14AH failure

Target:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47"
}
```

Phase 14AH called only `UploadSiteHostedPictures`. eBay returned:

```json
{
  "Ack": "Failure",
  "ErrorCode": "21916550",
  "ShortMessage": "File has corrupt image data",
  "LongMessage": "Picture Services found a data corruption problem when processing retrieved picture file"
}
```

No `PictureURL` was produced.

## Why token is no longer the blocker

Phase 14AC failed earlier with `21916984 Invalid IAF token`. Phase 14AF refreshed/rotated the token, and Phase 14AH reached eBay Picture Services. The Phase 14AH error is from Picture Services image processing, not token authentication.

Therefore the next blocker is image/payload compatibility, not token readiness.

## Why PictureURL is still unavailable

`UploadSiteHostedPictures` did not succeed. Because eBay returned `Ack=Failure`, there is no hosted `PictureURL` to place into any future listing image remediation packet.

No listing revise can proceed without a valid hosted `PictureURL` or other marketplace-compatible image URL approved in a later phase.

## Why automatic retry is forbidden

The Phase 14AH approval was explicitly one post-token-refresh upload attempt only. The duplicate guard records that attempt and blocks reusing the same approval/candidate.

Automatic retry is forbidden because it would be another eBay API operation. Any future upload attempt requires:

- a new validated image candidate or sanitized candidate
- a new exact approval checklist
- one-attempt-only controls
- no `ReviseFixedPriceItem` in the upload phase

## Local corruption audit

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-image-corruption-audit --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
```

The audit reports:

- file exists
- file size
- MIME/format
- width and height
- longest side
- sha256
- local decoder readability
- EXIF/metadata issue hints
- whether eBay rejected the exact sha256 with `21916550`
- likely cause
- recommended next safe action

Phase 14AI observed that local decoders can read the original JPEG and no EXIF/ICC/XMP/IPTC metadata issue was detected, while eBay rejected the exact candidate with `21916550`. The likely cause remains local file compatibility or UploadSiteHostedPictures `PictureData` payload compatibility.

## Sanitized candidate creation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-image-sanitize-local --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
```

The command:

- does not mutate the original image
- creates a new local JPEG copy under an internal path
- strips metadata if possible
- requests non-progressive baseline JPEG output
- preserves at least 500px longest side
- computes the sanitized sha256
- validates dimensions
- registers sanitized metadata internally
- does not call eBay

Created sanitized candidate:

```json
{
  "sanitized_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
  "sanitized_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
  "sanitized_width": 512,
  "sanitized_height": 512,
  "sanitized_longest_side": 512,
  "sanitized_policy_eligibility": true
}
```

Internal metadata registry:

```text
data/hermes-image-sanitized-candidates.json
```

Sanitized image path:

```text
data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg
```

## Sanitized candidate readiness

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-image-sanitized-candidate-readiness --item-id=206288370789
```

Readiness confirms:

- original candidate failed with eBay `21916550`
- sanitized candidate exists
- sanitized candidate is JPEG
- sanitized dimensions are 512x512
- sanitized candidate meets the 500px longest-side policy
- ready for a later new image upload reapproval
- `request_id=5` must not be reused
- previous upload attempts must not be reused

## Safety guarantees

Phase 14AI does not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change any eBay listing fields
- mutate the original image file
- call AI
- push commits

Local sanitized image creation and internal metadata writes are allowed and are the only writes performed.

## Why another explicit upload approval is required later

The sanitized candidate has not been uploaded to eBay. It only creates local evidence and internal metadata. A future phase must create a new exact approval checklist for one upload attempt using the sanitized path and sanitized sha256.

Until that later approval is provided, no marketplace upload is allowed.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-corruption-audit --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
npm run hermes:agent -- ebay-listing-quality-image-sanitize-local --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
npm run hermes:agent -- ebay-listing-quality-image-sanitized-candidate-readiness --item-id=206288370789
git diff --stat
```
