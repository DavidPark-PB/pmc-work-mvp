# Hermes Phase 16C — Public PictureURL Mini-Batch Packets

## Purpose

Phase 16C creates approval-gated mini-batch public PictureURL packet previews and internal packet records for the three Phase 16A/16B validated low-risk candidates.

This phase is not a live execution phase. It does not call eBay, does not call `GetItem`, does not call `ReviseFixedPriceItem`, does not call `UploadSiteHostedPictures`, and does not perform marketplace writes.

## Baseline

Do not redo Phase 14, Phase 15, Phase 16A, or Phase 16B.

```text
81abc24 Add Phase 16B public PictureURL mini-batch image intake
```

Validated Phase 16B URL map:

```json
{
  "206332929888": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg",
  "206371786121": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg",
  "206387679082": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"
}
```

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-packet-preview --url-map='{"206332929888":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg","206371786121":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg","206387679082":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"}'

npm run hermes:agent -- ebay-public-picture-url-mini-batch-create-packets --url-map='{"206332929888":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg","206371786121":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg","206387679082":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"}'
```

## Packet preview

The preview command is read-only and outputs one preview per item.

Each preview has:

```json
{
  "operation": "ReviseFixedPriceItem",
  "change_scope": ["images"],
  "marketplace_write": false,
  "ready_for_packet_creation": true,
  "payload_contains_only_item_id_and_picture_details": true
}
```

Each payload preview includes only `Item.ItemID` and `Item.PictureDetails.PictureURL`:

```json
{
  "Item": {
    "ItemID": "206332929888",
    "PictureDetails": {
      "PictureURL": [
        "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg"
      ]
    }
  }
}
```

Equivalent payload previews were generated for:

- `206332929888`
- `206371786121`
- `206387679082`

## Explicit excluded fields

Every preview and packet explicitly excludes:

```json
{
  "no_title": true,
  "no_item_specifics": true,
  "no_price": true,
  "no_inventory": true,
  "no_quantity": true,
  "no_description": true,
  "no_category": true,
  "no_shipping": true,
  "no_payment": true,
  "no_returns": true
}
```

Blocked changes remain:

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

## Internal artifacts created

The create-packets command performed internal DB writes only. It created one pending approval execution request, one non-executed listing revise packet, and one audit event per item.

```json
{
  "created_request_ids": [8, 9, 10],
  "created_packet_ids": [8, 9, 10],
  "event_ids": [20, 21, 22],
  "approval_gated": true,
  "live_execution_disabled": true,
  "no_ebay_call_performed": true,
  "marketplace_write": false
}
```

Per-item artifact summary:

```json
[
  {
    "item_id": "206332929888",
    "request_id": 8,
    "request_status": "pending_approval",
    "packet_id": 8,
    "packet_status": "packet_recorded",
    "event_id": 20
  },
  {
    "item_id": "206371786121",
    "request_id": 9,
    "request_status": "pending_approval",
    "packet_id": 9,
    "packet_status": "packet_recorded",
    "event_id": 21
  },
  {
    "item_id": "206387679082",
    "request_id": 10,
    "request_status": "pending_approval",
    "packet_id": 10,
    "packet_status": "packet_recorded",
    "event_id": 22
  }
]
```

All packets are approval-gated and non-executed. Live execution remains disabled.

## Safety

Phase 16C did not:

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

Phase 16C did perform internal DB writes only for:

- `hermes_execution_requests.id=8,9,10`;
- `hermes_ebay_listing_quality_packets.id=8,9,10`;
- `hermes_execution_events.id=20,21,22`.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-mini-batch-packet-preview --url-map='{"206332929888":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg","206371786121":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg","206387679082":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"}'
npm run hermes:agent -- ebay-public-picture-url-mini-batch-create-packets --url-map='{"206332929888":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg","206371786121":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg","206387679082":"https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"}'
git diff --stat
```
