# Hermes Phase 14AU — Public PictureURL Final Approval

## Purpose

Phase 14AU creates the final explicit operator approval checklist for a future live `ReviseFixedPriceItem` attempt using the public HTTPS `PictureURL` packet from Phase 14AT.

This phase does not execute live and does not call eBay.

## Baseline

Do not redo Phase 14A–14AT. Phase 14AT baseline:

```text
ec1aa2c Add Phase 14AT public PictureURL packet
```

## Current artifacts

```json
{
  "request_id": 6,
  "packet_id": 5,
  "item_id": "206288370789",
  "failed_source_request_id": 5,
  "request_status": "pending_approval",
  "packet_status": "packet_recorded",
  "confirmation_status": "not_confirmed"
}
```

`request_id=5` remains failed and must not be reused.

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-final-approval-readiness --request-id=6
npm run hermes:agent -- ebay-public-picture-url-final-approval-checklist --request-id=6
```

## Readiness result

```json
{
  "phase": "14AU",
  "request_id": 6,
  "packet_id": 5,
  "item_id": "206288370789",
  "request_status": "pending_approval",
  "packet_status": "packet_recorded",
  "confirmation_status": "not_confirmed",
  "final_approval_status": "not_requested",
  "planned_fields_exactly": ["title", "item_specifics", "images"],
  "planned_fields_exact_match": true,
  "picture_details_picture_url_exact": true,
  "forbidden_fields_absent": true,
  "ready_for_explicit_operator_live_approval": true,
  "blockers": []
}
```

## Planned fields

Allowed planned fields exactly:

```json
[
  "title",
  "item_specifics",
  "images"
]
```

Title:

```text
Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks
```

Item specifics:

```json
{
  "Type": "Food Pick",
  "Brand": "Torune",
  "Theme": "Dolphin Sea Friend",
  "Number in Pack": "8"
}
```

PictureDetails PictureURL:

```text
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg
```

Forbidden fields absent:

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

## Exact approval text

The checklist emits this exact operator approval text:

```text
Actual eBay listing revise approval for public PictureURL packet.
request_id=6 only.
packet_id=5 only.
item_id=206288370789 only.
Allowed operation: ReviseFixedPriceItem only.
Allowed changes: title, item_specifics, images.
PictureDetails.PictureURL=https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg only.
Forbidden operation: UploadSiteHostedPictures.
Forbidden changes: description, price, inventory, quantity, category, shipping, payment, returns.
One live listing revise attempt only.
Record eBay response.
Do not push.
```

## Safety

Phase 14AU did not:

- execute live;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- change the eBay listing;
- create execution requests;
- create revise packets;
- modify token values;
- print token secrets;
- call AI;
- push commits.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-final-approval-readiness --request-id=6
npm run hermes:agent -- ebay-public-picture-url-final-approval-checklist --request-id=6
git diff --stat
```
