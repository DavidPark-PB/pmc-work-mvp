# Hermes Phase 14Y — Image Transport Boundary

## Purpose

Phase 14Y adds a safe dry-run image transport boundary for the validated replacement image candidate.

It does not redo Phase 14A through Phase 14X. Phase 14X baseline:

```text
4f50aa5 Add Phase 14X image-aware packet planning
```

## Current target

```json
{
  "item_id": "206288370789",
  "failed_source_request_id": 5,
  "replacement_image_candidate_path": "/Users/parksungmin/Downloads/torune.jpeg"
}
```

`request_id=5` must not be reused because it already reached eBay once through `ReviseFixedPriceItem` and has a recorded failed execution result.

## Why the local file path is insufficient

The local file path is internal evidence only:

```text
/Users/parksungmin/Downloads/torune.jpeg
```

It is not an HTTPS URL and is not an eBay-hosted `PictureURL`. eBay `PictureDetails` expects a marketplace-compatible URL value, not a local operator workstation path.

Phase 14W proved that the local JPEG is policy-eligible by dimensions, but it did not make the file available to eBay.

## Why a PictureURL is required

A future listing revise that replaces images must eventually send a `PictureDetails.PictureURL` value that eBay can fetch or has already hosted.

Expected future revise shape:

```json
{
  "ReviseFixedPriceItemRequest": {
    "Item": {
      "ItemID": "206288370789",
      "PictureDetails": {
        "PictureURL": "<future eBay-compatible image URL>"
      }
    }
  }
}
```

Phase 14Y does not perform that revise and does not produce a live `PictureURL`.

## Supported future strategies

Phase 14Y reports two possible future strategies:

1. `UploadSiteHostedPictures` gated upload path
   - Future operation: `UploadSiteHostedPictures`
   - Future output: `PictureURL`
   - Current status: boundary stub only; live upload disabled in Phase 14Y

2. Safe hosted URL path
   - Future input: HTTPS URL accepted by eBay `PictureDetails.PictureURL`
   - Future output: URL used in a new image-aware packet
   - Current status: planning strategy only; no hosting or network call in Phase 14Y

## Why no upload happens in this phase

Phase 14Y is a transport boundary only. It previews the payload shape and safety gates without side effects.

It does not:

- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- upload images to eBay
- make network calls
- perform marketplace writes
- create a new live execution request
- create a new packet
- change title
- change item specifics
- change description
- change price
- change inventory
- change quantity
- change category
- change shipping
- change payment
- change returns
- change images
- call AI

## Safety gates required before future upload

A later explicit upload phase must require all of these gates:

```json
{
  "explicit_operator_approval": true,
  "dedicated_environment_flag": "HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true",
  "exact_item_id_match": "206288370789",
  "exact_candidate_sha256_match": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "request_id_5_must_not_be_reused": true
}
```

A future upload is still not a live listing revise by itself. After producing a marketplace-compatible `PictureURL`, Hermes must create a new request and packet, route them through explicit human approval, and only then consider a future live listing update.

## Commands

Transport plan:

```bash
npm run hermes:agent -- ebay-listing-quality-image-transport-plan --item-id=206288370789
```

Transport dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-image-transport-dry-run --item-id=206288370789
```

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/api/ebayAPI.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-candidate-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-aware-packet-plan --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-transport-plan --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-transport-dry-run --item-id=206288370789
git diff --stat
```
