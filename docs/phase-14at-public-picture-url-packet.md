# Hermes Phase 14AT — Public PictureURL Packet

## Purpose

Phase 14AT creates a new internal image-aware listing revise request/packet using the validated operator-supplied public HTTPS `PictureURL` from Phase 14AS.

This phase does not execute live and does not call eBay. It creates internal request/packet artifacts only.

## Baseline

Do not redo Phase 14A–14AS. Phase 14AS baseline:

```text
9a3e453 Add Phase 14AS public PictureURL fallback planning
```

## Valid public PictureURL candidate

```text
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg
```

Candidate source type:

```text
operator_supplied_public_https_url
```

Local candidate reference:

```text
/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg
sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b
```

## Source request guard

`request_id=5` failed during Phase 14T and must not be reused.

Phase 14AT reads the previous approved packet (`packet_id=4`) only as the source for the approved title and item-specifics mutation, then creates a new request/packet pair.

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-packet-readiness --item-id=206288370789
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206288370789
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206288370789 --create
```

## Readiness result before create

```json
{
  "phase": "14AT",
  "item_id": "206288370789",
  "failed_source_request_id": 5,
  "failed_source_request_status": "failed",
  "request_id_5_must_not_be_reused": true,
  "previous_packet_id": 4,
  "public_picture_url_exists": true,
  "picture_url_source_type": "operator_supplied_public_https_url",
  "forbidden_fields_absent": true,
  "existing_public_picture_url_request_id": null,
  "existing_public_picture_url_packet_id": null,
  "ready_for_public_picture_url_packet_creation": true,
  "blockers": []
}
```

## Planned mutation

Allowed planned mutation fields only:

```json
[
  "title",
  "item_specifics",
  "images"
]
```

Title from previous approved packet:

```text
Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks
```

Item specifics from previous approved packet:

```json
{
  "Type": "Food Pick",
  "Brand": "Torune",
  "Theme": "Dolphin Sea Friend",
  "Number in Pack": "8"
}
```

Image mutation using `PictureDetails.PictureURL`:

```json
{
  "source_type": "operator_supplied_public_https_url",
  "PictureDetails": {
    "PictureURL": [
      "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg"
    ]
  },
  "public_picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg"
}
```

Mutation hash:

```text
sha256:43c0d9ae37aaa148ecafd358cf279650f180d46d37a4c01c1106af1db265d434
```

## Payload preview

```json
{
  "Item": {
    "ItemID": "206288370789",
    "Title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
    "ItemSpecifics": {
      "NameValueList": [
        { "Name": "Type", "Value": "Food Pick" },
        { "Name": "Brand", "Value": "Torune" },
        { "Name": "Theme", "Value": "Dolphin Sea Friend" },
        { "Name": "Number in Pack", "Value": "8" }
      ]
    },
    "PictureDetails": {
      "PictureURL": [
        "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg"
      ]
    }
  }
}
```

Explicit absences:

```json
{
  "no_description": true,
  "no_price": true,
  "no_inventory": true,
  "no_quantity": true,
  "no_category": true,
  "no_shipping": true,
  "no_payment": true,
  "no_returns": true
}
```

## Create result

Create command:

```bash
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206288370789 --create
```

Created internal artifacts:

```json
{
  "request_created": true,
  "packet_created": true,
  "final_request_id": 6,
  "final_packet_id": 5,
  "event_type": "phase_14at_public_picture_url_packet_created",
  "event_id": 14
}
```

The new request status is `pending_approval`; it is not executed.

## Post-create readiness

```json
{
  "existing_public_picture_url_request_id": 6,
  "existing_public_picture_url_packet_id": 5,
  "ready_for_public_picture_url_packet_creation": true,
  "blockers": []
}
```

## Safety

Phase 14AT did not:

- call `UploadSiteHostedPictures`;
- call `ReviseFixedPriceItem`;
- perform marketplace writes;
- execute live;
- change the eBay listing;
- reuse `request_id=5`;
- create a live execution event;
- call AI;
- push commits.

Phase 14AT did create internal request/packet artifacts only:

- `hermes_execution_requests.id=6`
- `hermes_ebay_listing_quality_packets.id=5`
- `hermes_execution_events.id=14`

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-picture-url-candidate-readiness --item-id=206288370789
npm run hermes:agent -- ebay-public-picture-url-packet-readiness --item-id=206288370789
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206288370789
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206288370789 --create
npm run hermes:agent -- ebay-public-picture-url-packet-readiness --item-id=206288370789
git diff --stat
```
