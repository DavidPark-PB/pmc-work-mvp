# Hermes Phase 15F — Public PictureURL Live Revise

## Purpose

Phase 15F records the operator-supplied exact approval text and performs exactly one live `ReviseFixedPriceItem` attempt for the Phase 15D/15E images-only public PictureURL packet.

## Baseline

Do not redo Phase 14, Phase 15A, Phase 15B, Phase 15C, Phase 15D, or Phase 15E.

```text
cecb62c Add Phase 15E public PictureURL final approval checklist
```

## Approved packet

```json
{
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "operation": "ReviseFixedPriceItem",
  "change_scope": ["images"],
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
}
```

## Exact approval text received

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

## Command used

A dry-run preflight was run first and reported `approval_text_matches=true`, `previous_live_attempt_count=0`, `blockers=[]`, and `would_call_ebay=true`.

Live command:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-public-picture-url-approved-live-revise --request-id=7 --write --approval-text="<exact approval text>"
```

## Live result

```json
{
  "phase": "15F",
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "dry_run": false,
  "write_requested": true,
  "live_enabled": true,
  "env_live_enabled": true,
  "approval_text_matches": true,
  "previous_live_attempt_count": 0,
  "actual_ebay_call": true,
  "actual_network_call": true,
  "revise_fixed_price_item_called": true,
  "upload_site_hosted_pictures_called": false,
  "marketplace_write_performed": true,
  "listing_changed": true,
  "updated_request_status": "executed"
}
```

Recorded events:

```json
{
  "started_event_id": 18,
  "completion_event_id": 19,
  "completion_event_type": "phase_15f_public_picture_url_images_only_revise_completed"
}
```

The execution result was attached to `hermes_execution_requests.id=7` and the request status was updated to `executed`.

## eBay response

```json
{
  "success": true,
  "ack": "Warning",
  "item_id": "206284142714",
  "timestamp": "2026-07-05T03:56:22.950Z",
  "errors": [],
  "warnings": [
    {
      "code": "21919456",
      "severity": "Warning",
      "short_message": "Seller has opted into business policies. Please use policy IDs rather than legacy fields for Shipping, Payments or Returns."
    },
    {
      "code": "21916137",
      "severity": "Warning",
      "short_message": "You must comply with international selling laws."
    }
  ]
}
```

The warnings were returned by eBay with successful acknowledgement and did not indicate a failed image revise.

## Payload scope

The XML payload contained only:

```xml
<Item><ItemID>206284142714</ItemID><PictureDetails><PictureURL>https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg</PictureURL></PictureDetails></Item>
```

Explicitly not included:

- title;
- item_specifics;
- price;
- inventory;
- quantity;
- description;
- category;
- shipping;
- payment;
- returns.

## Safety

Phase 15F performed one approved live marketplace write:

- `ReviseFixedPriceItem` called: true;
- marketplace write performed: true;
- eBay ack: `Warning` with `success=true`;
- request status: `executed`.

Phase 15F did not:

- call `UploadSiteHostedPictures`;
- call `GetItem`;
- change title;
- change item specifics;
- change price;
- change inventory;
- change quantity;
- change description;
- change category;
- change shipping/payment/returns;
- call AI;
- push commits.

No further live revise attempt is allowed for `request_id=7`.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-approved-live-revise --request-id=7 --approval-text="<exact approval text>"
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-public-picture-url-approved-live-revise --request-id=7 --write --approval-text="<exact approval text>"
git diff --stat
```
