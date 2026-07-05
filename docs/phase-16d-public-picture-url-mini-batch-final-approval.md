# Hermes Phase 16D — Public PictureURL Mini-Batch Final Approval Checklist

## Purpose

Phase 16D creates a read-only final approval checklist and exact operator approval text for the three pending Phase 16C images-only public PictureURL mini-batch packets.

This phase does not execute live, does not call eBay, does not mutate packets, and does not perform marketplace writes.

## Baseline

Do not redo Phase 14, Phase 15, Phase 16A, Phase 16B, or Phase 16C.

```text
cb58e17 Add Phase 16C public PictureURL mini-batch packets
```

## Current pending mini-batch packets

```json
[
  {
    "request_id": 8,
    "packet_id": 8,
    "item_id": "206332929888",
    "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg"
  },
  {
    "request_id": 9,
    "packet_id": 9,
    "item_id": "206371786121",
    "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg"
  },
  {
    "request_id": 10,
    "packet_id": 10,
    "item_id": "206387679082",
    "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"
  }
]
```

## Command added

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-final-approval-checklist --request-ids=8,9,10
```

## Checklist output

The command outputs one checklist entry per request:

```json
{
  "request_id": 8,
  "packet_id": 8,
  "item_id": "206332929888",
  "operation": "ReviseFixedPriceItem",
  "change_scope": ["images"],
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg",
  "blocked_changes": [
    "title",
    "item_specifics",
    "price",
    "inventory",
    "quantity",
    "description",
    "category",
    "shipping",
    "payment",
    "returns"
  ],
  "ready_for_operator_approval": true,
  "live_execution_performed": false,
  "marketplace_write": false
}
```

The same readiness shape is emitted for:

- `request_id=8`, `packet_id=8`, `item_id=206332929888`;
- `request_id=9`, `packet_id=9`, `item_id=206371786121`;
- `request_id=10`, `packet_id=10`, `item_id=206387679082`.

Readiness checks confirmed for all three entries:

```json
{
  "request_status": "pending_approval",
  "packet_status": "packet_recorded",
  "confirmation_status": "not_confirmed",
  "final_approval_status": "not_requested",
  "packet_payload_is_images_only": true,
  "forbidden_fields_present": [],
  "blockers": []
}
```

## Exact operator approval text

The command emits this exact text for the operator to paste before any future live execution phase:

```text
Actual eBay mini-batch listing revise approval for images-only public PictureURL packets.
request_id=8,9,10 only.
packet_id=8,9,10 only.
item_id=206332929888,206371786121,206387679082 only.
Batch size: 3.
Allowed operation: ReviseFixedPriceItem only.
Allowed changes: images only.
PictureDetails.PictureURL for item_id=206332929888: https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg only.
PictureDetails.PictureURL for item_id=206371786121: https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg only.
PictureDetails.PictureURL for item_id=206387679082: https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg only.
No title changes.
No item_specifics changes.
No price, inventory, or quantity changes.
No description, category, shipping, payment, or returns changes.
Forbidden operation: UploadSiteHostedPictures.
One live ReviseFixedPriceItem attempt per request only.
Stop and report if any item fails; do not retry failed item automatically.
Record every eBay response.
Do not push.
```

## Safety

Phase 16D did not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- execute live;
- mutate packets;
- create execution requests;
- create packets;
- perform database writes;
- call AI;
- push commits.

The pending mini-batch requests and packets remain unchanged:

```json
{
  "request_ids": [8, 9, 10],
  "request_status": "pending_approval",
  "packet_ids": [8, 9, 10],
  "packet_status": "packet_recorded",
  "live_execution_performed": false,
  "marketplace_write": false,
  "no_packet_mutation_performed": true
}
```

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-mini-batch-final-approval-checklist --request-ids=8,9,10
git diff --stat
```
