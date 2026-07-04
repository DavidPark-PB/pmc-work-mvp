# Hermes Phase 14T — Seed Live Execution

## Scope

Phase 14T implemented the seed live execution path for the Phase 14S approved tuple and executed the live command exactly once.

No Phase 14A through Phase 14S work was redone.

Baseline:

```text
7d26917 Add Phase 14S seed live approval checklist
```

## Exact approved scope

```json
{
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "allowed_changes": ["title", "item_specifics"],
  "forbidden_changes": ["price", "inventory", "quantity", "description", "shipping", "payment", "returns", "category", "images"]
}
```

Approved final mutation:

```json
{
  "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
  "item_specifics": {
    "Brand": "Torune",
    "Type": "Food Pick",
    "Theme": "Dolphin Sea Friend",
    "Number in Pack": "8"
  }
}
```

## Implementation summary

Updated:

```text
src/services/hermesExecutionApproval.js
```

Phase 14T adds a Phase 14T-specific live gate around the existing seed live transport command.

The Phase 14R hard blocker remains for non-eligible boundary mode. The blocker is bypassed only when all Phase 14T tuple and safety gates pass for the exact approved tuple.

The live transport continues to call the existing eBay Trading API path:

```text
src/api/ebayAPI.js
new EbayAPI().callTradingAPI('ReviseFixedPriceItem', requestBody)
```

No new eBay client or auth logic was added.

## Payload sent

The live request payload contained only `ItemID`, `Title`, and `ItemSpecifics`:

```xml
<Item>
  <ItemID>206288370789</ItemID>
  <Title>Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks</Title>
  <ItemSpecifics>
    <NameValueList><Name>Type</Name><Value>Food Pick</Value></NameValueList>
    <NameValueList><Name>Brand</Name><Value>Torune</Value></NameValueList>
    <NameValueList><Name>Theme</Name><Value>Dolphin Sea Friend</Value></NameValueList>
    <NameValueList><Name>Number in Pack</Name><Value>8</Value></NameValueList>
  </ItemSpecifics>
</Item>
```

The payload did not include:

- Description
- Price / StartPrice
- Quantity
- Inventory / InventoryStatus
- Shipping
- Payment
- Returns
- Category
- Images / PictureDetails

## Pre-live validation

The required non-piped validation commands were run before the live attempt.

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
```

All exited `0`.

Readiness/checklist/transport/events:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-approval-checklist --approval-id=37
npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=37
npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --dry-run
npm run hermes:agent -- execution-events --id=5 --limit=20
```

Observed before live:

```json
{
  "ready_for_explicit_user_live_approval": true,
  "ready_for_seed_live_path_review": true,
  "transport_ready_for_live_call": true,
  "transport_would_call_ebay": true,
  "execution_events_count": 0,
  "actual_ebay_call": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false
}
```

## Live command executed exactly once

Executed exactly once:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --write
```

The command reached eBay and called Trading API `ReviseFixedPriceItem` once through the existing `src/api/ebayAPI.js` path.

No retry was performed.

## eBay response

Observed eBay response summary:

```json
{
  "ack": "Failure",
  "success": false,
  "timestamp": "2026-07-04T12:19:31.024Z",
  "warnings_count": 1,
  "errors_count": 1,
  "actual_ebay_call": true,
  "revise_fixed_price_item_called": true,
  "marketplace_write_attempted": true,
  "marketplace_write_performed": false,
  "listing_changed": false
}
```

Error returned by eBay:

```text
21919137 — The resolution for provided picture(s) does not meet eBay's Picture Policy requirements. Please only use pictures that are at least 500 pixels on the longest side.
```

Warning returned by eBay:

```text
21919456 — Seller has opted into business policies. Please use policy IDs rather than legacy fields for Shipping, Payments or Returns.
```

Because eBay returned `Ack=Failure`, the listing was not changed.

## Persistence result

After the real eBay response was received and parsed:

```json
{
  "request_id": 5,
  "status": "failed",
  "executed_at": "2026-07-04T12:19:31.024",
  "execution_result_present": true,
  "event_id": 13,
  "event_type": "marketplace_execution_failed",
  "marketplace_execution_completed_event_count": 0,
  "marketplace_execution_failed_event_count": 1
}
```

The request was not marked `executed` because the eBay response was not successful.

A `marketplace_execution_failed` event was created so the reached-live-attempt is recorded and not retried automatically.

## Safety facts recorded

```json
{
  "title_changes": true,
  "item_specifics_changes": true,
  "description_changes": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "shipping_changes": false,
  "payment_changes": false,
  "returns_changes": false,
  "category_changes": false,
  "image_changes": false,
  "marketplace_write_performed": false,
  "listing_changed": false
}
```

`title_changes=true` and `item_specifics_changes=true` describe the approved mutation fields in the payload. Since eBay returned failure, `marketplace_write_performed=false` and `listing_changed=false` were recorded.

## Post-live validation

Required non-piped commands were run after the live attempt:

```bash
npm run hermes:agent -- execution-detail --id=5
npm run hermes:agent -- ebay-listing-quality-seed-live-readiness --approval-id=37
npm run hermes:agent -- ebay-listing-quality-seed-live-transport --approval-id=37 --dry-run
npm run hermes:agent -- execution-events --id=5 --limit=20
```

Observed post-live state:

```json
{
  "request_id": 5,
  "status": "failed",
  "executed_at_present": true,
  "execution_result_present": true,
  "readiness_ready_for_seed_live_path_review": false,
  "transport_ready_for_live_call": false,
  "transport_blocked": true,
  "transport_blockers": [
    "request_executed_at_present",
    "request_execution_result_present",
    "metadata_external_action_executed_not_false",
    "metadata_marketplace_execution_approved_not_false"
  ],
  "execution_events_count": 1,
  "event_id": 13,
  "event_type": "marketplace_execution_failed"
}
```

The dry-run duplicate guard blocks another automatic execution attempt after the live attempt reached eBay.

## Safety guarantees

Phase 14T preserved these boundaries:

- No other approval/request/packet/item was executed.
- No price field was sent.
- No inventory or quantity field was sent.
- No description field was sent.
- No shipping/payment/returns/category/images field was sent.
- No AI call was added to app logic.
- No new eBay API client or auth logic was created.
- No automatic retry was performed after the live attempt reached eBay.
- No push was performed.

## Final outcome

Phase 14T completed the approved live attempt path and recorded the real eBay failure response.

The requested update did not apply on eBay because eBay rejected the revise request due to an existing listing picture policy error (`21919137`).

No further live execution was attempted.
