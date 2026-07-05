# Hermes Phase 15G — Public PictureURL Post-Live Audit

## Purpose

Phase 15G performs a read-only post-live audit and final reconciliation check for the Phase 15F images-only public PictureURL live revise.

This phase does not perform marketplace writes, does not call `ReviseFixedPriceItem` again, and does not mutate Hermes DB state.

## Baseline

Do not redo Phase 15A through Phase 15F.

```text
0ee07d7 Add Phase 15F public PictureURL live revise
```

## Audited live execution

```json
{
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "operation": "ReviseFixedPriceItem",
  "change_scope": ["images"],
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg",
  "success": true,
  "ebay_ack": "Warning",
  "started_event_id": 18,
  "completion_event_id": 19
}
```

## Command added/read

```bash
npm run hermes:agent -- ebay-public-picture-url-post-live-audit --request-id=7
```

The existing post-live audit command now branches `request_id=7` to the Phase 15G images-only audit path. Existing Phase 14 audit behavior remains unchanged for other request ids.

## Audit result

```json
{
  "phase": "15G",
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "request_status": "executed",
  "packet_status": "packet_recorded",
  "packet_status_terminal_or_equivalent": true,
  "started_event_id": 18,
  "started_event_exists": true,
  "completion_event_id": 19,
  "completion_event_exists": true,
  "execution_result_recorded": true,
  "ebay_response_ack": "Warning",
  "ebay_response_ack_success_or_warning": true,
  "listing_image_appears_updated": true,
  "no_additional_live_revise_attempt_needed": true,
  "reconciliation_already_complete": true,
  "reconciliation_noop": true,
  "record_only_reconciliation_needed": false
}
```

`packet_recorded` is treated as the equivalent non-open packet terminal state for this packet because the live execution state is held on `hermes_execution_requests.id=7` and its recorded execution events.

## Read-only eBay verification

The audit used the existing safe read-only `GetItem` path for verification only.

Result:

```json
{
  "ack": "Success",
  "item_id": "206284142714",
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "picture_urls": [
    "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
  ],
  "raw_response_stored": false
}
```

Listing image evidence:

```json
{
  "listing_appears_updated": true,
  "item_id_matches": true,
  "picture_present": true,
  "requested_picture_url_retained": true,
  "picture_url_transformed_to_ebay_hosted": false
}
```

Unlike the earlier Phase 14 public PictureURL case, eBay retained the public R2 URL verbatim in the read-only `GetItem` evidence for this item.

## Execution result verification

The recorded execution result confirms:

```json
{
  "actual_ebay_call": true,
  "actual_network_call": true,
  "revise_fixed_price_item_called": true,
  "upload_site_hosted_pictures_called": false,
  "marketplace_write_performed": true,
  "listing_changed": true,
  "allowed_changes": ["images"],
  "ebay_response": {
    "ack": "Warning",
    "success": true,
    "errors": []
  }
}
```

The Phase 15G audit itself performed no writes and no marketplace mutation.

## Forbidden change audit

```json
{
  "no_title_changes": true,
  "no_item_specifics_changes": true,
  "no_price_changes": true,
  "no_inventory_changes": true,
  "no_quantity_changes": true,
  "no_description_changes": true,
  "no_category_changes": true,
  "no_shipping_changes": true,
  "no_payment_changes": true,
  "no_returns_changes": true
}
```

## Reconciliation status

Reconciliation is already complete because:

- `request_id=7` status is `executed`;
- `execution_result` is recorded;
- started event `18` exists;
- completion event `19` exists;
- eBay response ack is `Warning` with `success=true`;
- listing image appears updated by read-only `GetItem` evidence;
- forbidden change audit is clean.

Therefore Phase 15G reports:

```json
{
  "reconciliation_already_complete": true,
  "reconciliation_noop": true,
  "record_only_reconciliation_needed": false,
  "no_additional_live_revise_attempt_needed": true
}
```

No record-only reconciliation command or approval text was needed.

## Safety

Phase 15G did not:

- call `ReviseFixedPriceItem` again;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- perform DB writes;
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

Phase 15G did perform one read-only `GetItem` verification call.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-post-live-audit --request-id=7
git diff --stat
```
