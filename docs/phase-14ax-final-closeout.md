# Hermes Phase 14AX — Final Closeout

## Purpose

Phase 14AX is the final closeout audit and duplicate-guard verification for the Phase 14 public PictureURL listing quality revise path.

This phase performs no eBay calls, no marketplace writes, and no listing changes.

## Baseline

Do not redo Phase 14A–14AW. Phase 14AW baseline:

```text
27879dc Add Phase 14AW record-only reconciliation
```

## Final outcome

```json
{
  "request_id": 6,
  "packet_id": 5,
  "item_id": "206288370789",
  "request_status": "executed",
  "executed_at": "2026-07-05T02:06:38.157",
  "execution_result_present": true,
  "started_event_id": 15,
  "completion_event_id": 16,
  "completion_event_type": "phase_14av_public_picture_url_revise_completed_rec",
  "listing_appears_updated": true,
  "no_unreconciled_state_remains": true,
  "no_further_live_action_required": true
}
```

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-final-closeout --request-id=6
npm run hermes:agent -- ebay-public-picture-url-duplicate-guard --request-id=6
```

Both commands are read-only. They use Hermes DB state and the recorded Phase 14AW execution result; they do not call eBay.

## Why the PictureData strategy was abandoned

The earlier `UploadSiteHostedPictures` / PictureData path was attempted through multiple guarded phases and failed repeatedly:

- token/IAF related failure paths were audited and stabilized;
- sanitized and compatible JPEG variants were generated;
- compatible local JPEG payloads were still rejected by eBay, including `21916550` corrupt image data failures;
- the final safe path was to stop reusing failed upload requests and switch to an operator-supplied public HTTPS PictureURL.

The failed request id remained non-retryable:

```text
failed_source_request_id=5 must not be reused
```

## Public PictureURL path success

The successful path used the public HTTPS PictureURL packet created in Phase 14AT:

```text
request_id=6
packet_id=5
item_id=206288370789
```

The approved future live operation was exactly one `ReviseFixedPriceItem` attempt with allowed changes only:

```json
[
  "title",
  "item_specifics",
  "images"
]
```

Forbidden changes throughout:

```json
[
  "description",
  "price",
  "inventory",
  "quantity",
  "category",
  "shipping",
  "payment",
  "returns"
]
```

## eBay-hosted image transformation

The requested public URL was:

```text
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/products/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg
```

Post-live read-only evidence showed eBay represented the image as an eBay-hosted URL:

```text
https://i.ebayimg.com/00/s/ODAwWDgwMA==/z/0KQAAeSwNlxqSbcV/$_1.JPG?set_id=8800005007
```

The closeout therefore records:

```json
{
  "requested_picture_url_retained": false,
  "picture_url_transformed_to_ebay_hosted": true,
  "picture_present": true
}
```

## Listing evidence

Title evidence:

```json
{
  "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
  "title_updated": true
}
```

Item specifics evidence:

```json
[
  { "Name": "Type", "Value": ["Food Pick"] },
  { "Name": "Brand", "Value": ["Torune"] },
  { "Name": "Theme", "Value": ["Dolphin Sea Friend"] },
  { "Name": "Number in Pack", "Value": ["8"] }
]
```

Picture evidence:

```json
{
  "picture_urls": [
    "https://i.ebayimg.com/00/s/ODAwWDgwMA==/z/0KQAAeSwNlxqSbcV/$_1.JPG?set_id=8800005007"
  ],
  "picture_present": true,
  "requested_picture_url_retained": false,
  "picture_url_transformed_to_ebay_hosted": true
}
```

## Record-only reconciliation

Phase 14AW reconciled Hermes internal state only. It did not call eBay.

It performed only:

- mark `request_id=6` executed;
- set `executed_at`;
- attach `execution_result` from the post-live audit evidence;
- create completion event `event_id=16`.

The execution result records:

```json
{
  "no_ebay_calls": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "revise_fixed_price_item_called_by_reconciliation": false,
  "upload_site_hosted_pictures_called_by_reconciliation": false,
  "marketplace_write_performed_by_reconciliation": false,
  "listing_changed_by_reconciliation": false
}
```

## Duplicate guard status

Duplicate guard verification reports:

```json
{
  "another_live_revise_attempt_blocked": true,
  "duplicate_guard_blockers": [
    "request_executed_at_present",
    "request_execution_result_present",
    "previous_live_attempt_exists",
    "completion_event_exists"
  ],
  "request_executed_at_present": true,
  "request_execution_result_present": true,
  "previous_live_attempt_exists": true,
  "completion_event_exists": true,
  "no_further_upload_revise_action_allowed": true
}
```

No further Phase 14 upload or revise action is allowed for this item.

## Safety

Phase 14AX did not:

- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- call `GetItem`;
- perform marketplace writes;
- perform internal DB writes;
- change listing fields;
- change price, inventory, quantity, description, category, shipping, payment, or returns;
- call AI;
- push commits.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-final-closeout --request-id=6
npm run hermes:agent -- ebay-public-picture-url-duplicate-guard --request-id=6
git diff --stat
```
