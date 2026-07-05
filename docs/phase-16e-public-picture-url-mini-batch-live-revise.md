# Hermes Phase 16E — Public PictureURL Mini-Batch Live Revise

## Purpose

Phase 16E records the operator-supplied final approval text and performs exactly one live `ReviseFixedPriceItem` attempt per approved Phase 16C mini-batch request.

The batch is fixed to request_ids `8,9,10` and packet_ids `8,9,10` only. Execution stops on the first failure and does not automatically retry any failed item.

## Baseline

Do not redo Phase 14, Phase 15, Phase 16A, Phase 16B, Phase 16C, or Phase 16D.

```text
3f46ded Add Phase 16D public PictureURL mini-batch final approval checklist
```

## Operator approval received

```text
Actual eBay mini-batch listing revise approval for images-only public PictureURL packets.
request_id=8,9,10 only.
packet_id=8,9,10 only.
item_id=206332929888,206371786121,206387679082 only.
Batch size: 3.
Allowed operation: ReviseFixedPriceItem only.
Allowed changes: images only.
PictureDetails.PictureURL for item_id=206332929888:
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg only.
PictureDetails.PictureURL for item_id=206371786121:
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg only.
PictureDetails.PictureURL for item_id=206387679082:
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg only.
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

## Command added

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-approved-live-revise --request-ids=8,9,10 --approval-text="<operator approval text>"
```

Live execution requires both `--write` and `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true`:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-public-picture-url-mini-batch-approved-live-revise --request-ids=8,9,10 --write --approval-text="<operator approval text>"
```

## Dry-run preflight

Dry-run preflight passed before live execution:

```json
{
  "dry_run": true,
  "approval_text_matches": true,
  "previous_live_attempt_counts": {
    "8": 0,
    "9": 0,
    "10": 0
  },
  "blockers": [],
  "would_call_ebay": true
}
```

The generated XML payloads contained only `ItemID` and `PictureDetails.PictureURL`:

```xml
<Item><ItemID>206332929888</ItemID><PictureDetails><PictureURL>https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg</PictureURL></PictureDetails></Item>
<Item><ItemID>206371786121</ItemID><PictureDetails><PictureURL>https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg</PictureURL></PictureDetails></Item>
<Item><ItemID>206387679082</ItemID><PictureDetails><PictureURL>https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg</PictureURL></PictureDetails></Item>
```

## Live execution result

Live execution completed for all three requests:

```json
{
  "phase": "16E",
  "request_ids": [8, 9, 10],
  "packet_ids": [8, 9, 10],
  "item_ids": ["206332929888", "206371786121", "206387679082"],
  "dry_run": false,
  "write_requested": true,
  "live_enabled": true,
  "env_live_enabled": true,
  "approval_text_matches": true,
  "attempted_count": 3,
  "success_count": 3,
  "failure_count": 0,
  "stopped_after_failure": false,
  "skipped_after_failure_request_ids": [],
  "actual_ebay_call": true,
  "actual_network_call": true,
  "revise_fixed_price_item_called": true,
  "upload_site_hosted_pictures_called": false,
  "marketplace_write_performed": true,
  "listing_changed": true
}
```

## Per-request results

### request_id=8 / packet_id=8 / item_id=206332929888

```json
{
  "updated_request_status": "executed",
  "success": true,
  "started_event_id": 23,
  "completion_event_id": 24,
  "ack": "Warning",
  "timestamp": "2026-07-05T05:35:47.054Z",
  "warnings": ["21919456", "21920363"],
  "errors": []
}
```

Warnings:

- `21919456`: Seller has opted into business policies.
- `21920363`: Return information mapped to new business policy `30 days money back (292505936014)`.

### request_id=9 / packet_id=9 / item_id=206371786121

```json
{
  "updated_request_status": "executed",
  "success": true,
  "started_event_id": 25,
  "completion_event_id": 26,
  "ack": "Warning",
  "timestamp": "2026-07-05T05:35:50.689Z",
  "warnings": ["21919456"],
  "errors": []
}
```

Warning:

- `21919456`: Seller has opted into business policies.

### request_id=10 / packet_id=10 / item_id=206387679082

```json
{
  "updated_request_status": "executed",
  "success": true,
  "started_event_id": 27,
  "completion_event_id": 28,
  "ack": "Warning",
  "timestamp": "2026-07-05T05:35:54.497Z",
  "warnings": ["21919456"],
  "errors": []
}
```

Warning:

- `21919456`: Seller has opted into business policies.

## Safety

Phase 16E performed the approved live marketplace writes:

- `ReviseFixedPriceItem` called: true;
- marketplace write performed: true;
- attempted count: 3;
- success count: 3;
- failure count: 0;
- request statuses: `executed`.

Phase 16E did not:

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

No further live revise attempt is allowed for request_ids `8,9,10`.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-mini-batch-approved-live-revise --request-ids=8,9,10 --approval-text="<operator approval text>"
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-public-picture-url-mini-batch-approved-live-revise --request-ids=8,9,10 --write --approval-text="<operator approval text>"
git diff --stat
```
