# Hermes Phase 15E — Public PictureURL Final Approval Checklist

## Purpose

Phase 15E creates a read-only final approval checklist and exact operator approval text for the pending images-only public PictureURL packet created in Phase 15D.

This phase does not execute live, does not call eBay, does not mutate packets, and does not perform marketplace writes.

## Baseline

Do not redo Phase 14, Phase 15A, Phase 15B, Phase 15C, or Phase 15D.

```text
0fd9bbd Add Phase 15D public PictureURL packet
```

## Current pending packet

```json
{
  "request_id": 7,
  "packet_id": 7,
  "event_id": 17,
  "item_id": "206284142714",
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "change_scope": ["images"],
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg",
  "request_status": "pending_approval",
  "packet_status": "packet_recorded",
  "live_execution_status": "not_executed"
}
```

## Command added

```bash
npm run hermes:agent -- ebay-public-picture-url-final-approval-checklist --request-id=7
```

The command branches the existing final-approval checklist command to the Phase 15E images-only approval path when `--request-id=7` is supplied. Existing Phase 14AU behavior for other request ids is preserved.

## Checklist output

The command outputs:

```json
{
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "operation": "ReviseFixedPriceItem",
  "change_scope": ["images"],
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg",
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

Additional readiness checks confirmed:

```json
{
  "request_status": "pending_approval",
  "packet_status": "packet_recorded",
  "confirmation_status": "not_confirmed",
  "final_approval_status": "not_requested",
  "planned_mutation_fields": ["images"],
  "forbidden_fields_present": [],
  "non_allowed_fields_present": [],
  "packet_payload_is_images_only": true,
  "no_packet_mutation_performed": true,
  "blockers": []
}
```

## Exact operator approval text

The command emits this exact text for the operator to paste before any future live execution phase:

```text
Actual eBay listing revise approval for images-only public PictureURL packet.
request_id=7 only.
packet_id=7 only.
item_id=206284142714 only.
Allowed operation: ReviseFixedPriceItem only.
Allowed changes: images only.
PictureDetails.PictureURL=https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg only.
No title changes.
No item_specifics changes.
No price, inventory, or quantity changes.
No description, category, shipping, payment, or returns changes.
Forbidden operation: UploadSiteHostedPictures.
One live ReviseFixedPriceItem attempt only.
Record eBay response.
Do not push.
```

## Safety

Phase 15E did not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- execute live;
- mutate the packet;
- create execution requests;
- create packets;
- perform database writes;
- call AI;
- push commits.

The pending request and packet remain unchanged:

```json
{
  "request_id": 7,
  "request_status": "pending_approval",
  "packet_id": 7,
  "packet_status": "packet_recorded",
  "live_execution_performed": false,
  "marketplace_write": false
}
```

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-final-approval-checklist --request-id=7
git diff --stat
```
