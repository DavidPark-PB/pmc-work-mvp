# Hermes Phase 15D — Public PictureURL Packet

## Purpose

Phase 15D creates an internal, approval-gated, images-only public PictureURL execution request and listing revise packet for the selected Phase 15B/15C controlled rollout candidate.

This phase creates internal Hermes artifacts only. It does not call eBay, does not execute live, and does not perform marketplace writes.

## Baseline

Do not redo Phase 14, Phase 15A, Phase 15B, or Phase 15C.

```text
2db2de1 Add Phase 15C public PictureURL image intake
```

## Selected candidate

```json
{
  "item_id": "206284142714",
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "allowed_change_scope": ["images"],
  "public_picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
}
```

Blocked changes throughout Phase 15D:

```json
[
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
]
```

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"

npm run hermes:agent -- ebay-public-picture-url-create-packet --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
```

The existing Phase 14AT packet preview path remains available when no `--url` argument is supplied. When `--url` is supplied, the command uses the Phase 15D images-only preview path.

## Packet preview

The Phase 15D packet preview is read-only and returns:

```json
{
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
  "marketplace_write": false,
  "ready_for_packet_creation": true
}
```

Payload preview includes only the public PictureURL image update:

```json
{
  "Item": {
    "ItemID": "206284142714",
    "PictureDetails": {
      "PictureURL": [
        "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
      ]
    }
  }
}
```

Explicit absences:

```json
{
  "no_title": true,
  "no_item_specifics": true,
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

Mutation hash:

```text
sha256:03e2f0a16dd4b064b3589ba4faa3dd3cdff038a71a90c9f4d414c3477aa8141d
```

## Internal artifacts created

Final Phase 15D artifacts:

```json
{
  "request_id": 7,
  "request_status": "pending_approval",
  "packet_id": 7,
  "packet_status": "packet_recorded",
  "event_id": 17,
  "event_type": "phase_15d_public_picture_url_packet_created",
  "approval_gated": true,
  "live_execution_disabled": true,
  "no_ebay_call_performed": true
}
```

During implementation, the first create attempt inserted the internal request but the packet insert hit the packet table's non-null `before_snapshot` constraint. The implementation was patched to use empty internal snapshots (`{}`), then the create command completed the packet and audit event idempotently against the existing request.

The resulting request remains approval-gated:

```json
{
  "status": "pending_approval",
  "requires_approval": true,
  "final_approval_status": "not_requested",
  "executed_at": null,
  "execution_result": null
}
```

The resulting packet remains non-executed:

```json
{
  "status": "packet_recorded",
  "confirmation_status": "not_confirmed"
}
```

## Safety

Phase 15D did not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- execute live;
- call AI;
- change title;
- change item specifics;
- change price;
- change inventory;
- change quantity;
- change description;
- change category;
- change shipping/payment/returns;
- push commits.

Phase 15D did perform internal DB writes only for:

- `hermes_execution_requests.id=7`;
- `hermes_ebay_listing_quality_packets.id=7`;
- `hermes_execution_events.id=17`.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-selected-candidate --item-id=206284142714
npm run hermes:agent -- ebay-public-picture-url-validate-candidate-url --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
npm run hermes:agent -- ebay-public-picture-url-packet-preview --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
npm run hermes:agent -- ebay-public-picture-url-create-packet --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
git diff --stat
```

Note: one direct URL-validation command invocation was denied by the command approval guard and was not retried. The same URL validation logic ran inside the approved packet preview/create commands and returned `valid: true`.
