# Hermes Phase 12I — eBay Live Single SKU Execution

Report timestamp: 2026-07-02T14:59:33Z

## Scope

Phase 12I executed the operator-approved single eBay `listing_quality_update` for exactly one packet.

Baseline:

```text
b047227 Add Phase 12H eBay live execution runbook
```

Phase 12I did not redo Phase 12A through Phase 12H.

## Operator approval scope

Approved scope:

- execute `packet_id=1` only
- target eBay item/listing only
- target item id must be exactly `202551129453`
- title change only
- price changes forbidden
- inventory/quantity changes forbidden
- no other packet may be executed

## Code changes for Phase 12I

Updated:

```text
src/adapters/ebayListingQualityExecutionAdapter.js
src/services/hermesExecutionApproval.js
```

Adapter update:

- improved `parseEbayReviseFixedPriceItemResponse` to parse real XML responses from eBay Trading API, not only mock object responses

Service update:

- added Phase 12I hard live-execution gates for the existing live transport command
- added execution persistence after confirmed eBay response
- records a marketplace execution event
- sets `executed_at` and `execution_result` only after successful/accepted eBay response parsing
- does not mark success when eBay response is failure

## Pre-live validation

### Runbook

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-live-runbook --packet-id=1
```

Observed summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "target_item_id": "202551129453",
  "final_approval_status": "approved",
  "confirmation_status": "confirmed",
  "rollback_available": true,
  "ready_for_dry_run": true,
  "ready_for_live_execution": false,
  "missing_requirements": [
    "live_ebay_execution_disabled"
  ],
  "credentials_present_by_names": true,
  "previous_execution_status": {
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "previous_marketplace_execution_event_count": 0,
    "no_previous_marketplace_execution_event": true,
    "marketplace_execution_complete": false
  }
}
```

### Payload build

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-build-payload --packet-id=1
```

Observed payload:

```json
{
  "Item": {
    "ItemID": "202551129453",
    "Title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card "
  }
}
```

Observed payload summary:

```json
{
  "updates_title": true,
  "updates_description": false,
  "updates_item_specifics": false,
  "allowed_fields": [
    "title",
    "description",
    "item_specifics"
  ],
  "payload_fields": [
    "Title"
  ],
  "forbidden_fields_present": false,
  "forbidden_fields": [],
  "non_allowed_fields": []
}
```

Payload gate passed:

- `packet_id=1`
- `target_item_id=202551129453`
- title update is present
- description update is absent
- item specifics update is absent
- forbidden fields absent
- non-allowed fields absent

### Live readiness with live env enabled

Command:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Observed summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "target_item_id": "202551129453",
  "ready_for_live_execution": true,
  "ready_for_dry_run": true,
  "live_enabled": true,
  "credentials_present": true,
  "missing_requirements": [],
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": false,
    "forbidden_fields_present": false
  }
}
```

Live readiness gate passed before execution.

## Live execution

Executed exactly once:

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --write
```

The command performed one real eBay Trading API `ReviseFixedPriceItem` call through the existing `src/api/ebayAPI.js` module.

Observed live execution summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "target_item_id": "202551129453",
  "blocked": false,
  "actual_ebay_call": true,
  "actual_network_call": true,
  "marketplace_write_performed": true,
  "actual_database_write": true,
  "execution_recorded": true,
  "execution_success": true,
  "executed_at": "2026-07-02T14:58:01.356",
  "execution_result_updated": true,
  "event_id": 11,
  "event_type": "marketplace_execution_completed",
  "ack": "Warning",
  "success": true,
  "correlation_id": null,
  "warnings_count": 2,
  "errors_count": 0
}
```

During execution, the existing eBay token flow detected token expiry and refreshed the token through existing token-store logic. No secret values were printed.

## eBay response summary

Parsed eBay response:

```json
{
  "success": true,
  "ack": "Warning",
  "item_id": "202551129453",
  "correlation_id": null,
  "timestamp": "2026-07-02T14:58:01.356Z",
  "warnings_count": 2,
  "errors_count": 0
}
```

Warnings returned by eBay:

1. `21919456` — Seller has opted into business policies. eBay warns to use policy IDs rather than legacy shipping/payment/returns fields.
2. `21920277` — Some item specifics were renamed as per eBay recommendations.

These were eBay warnings, not errors. The request had `Ack=Warning`, `success=true`, and no parsed errors.

## Execution result recorded

Request `id=1` now has:

```json
{
  "status": "executed",
  "executed_at": "2026-07-02T14:58:01.356",
  "execution_result_present": true,
  "execution_result_ack": "Warning",
  "execution_result_success": true,
  "execution_result_target_item_id": "202551129453",
  "execution_result_title_only": true,
  "execution_result_price_changes": false,
  "execution_result_inventory_changes": false
}
```

Marketplace execution event:

```json
{
  "id": 11,
  "event_type": "marketplace_execution_completed",
  "created_at": "2026-07-02T14:58:01.556533"
}
```

Metadata after execution:

```json
{
  "external_action_executed": true,
  "marketplace_execution_approved": true,
  "marketplace_execution_packet_id": 1,
  "marketplace_execution_event_id": 11,
  "marketplace_execution_scope": "phase_12i_single_sku_title_only",
  "marketplace_execution_price_changes": false,
  "marketplace_execution_inventory_changes": false
}
```

## Post-execution validation

### Execution detail

Command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed summary:

```json
{
  "request_id": 1,
  "status": "executed",
  "executed_at": "2026-07-02T14:58:01.356",
  "execution_result_present": true,
  "execution_result_ack": "Warning",
  "execution_result_success": true,
  "execution_result_target_item_id": "202551129453",
  "execution_result_title_only": true,
  "execution_result_price_changes": false,
  "execution_result_inventory_changes": false,
  "parsed_warnings_count": 2,
  "parsed_errors_count": 0,
  "metadata_external_action_executed": true,
  "metadata_marketplace_execution_approved": true,
  "marketplace_execution_events": [
    {
      "id": 11,
      "event_type": "marketplace_execution_completed",
      "created_at": "2026-07-02T14:58:01.556533"
    }
  ]
}
```

### Live readiness after execution

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Observed summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "ready_for_live_execution": false,
  "ready_for_dry_run": false,
  "missing_requirements": [
    "request_executed_at_present",
    "request_execution_result_present",
    "previous_marketplace_execution_event_exists",
    "live_ebay_execution_disabled"
  ],
  "checks": {
    "request_executed_at_is_null": false,
    "request_execution_result_is_null": false,
    "no_previous_marketplace_execution_event": false,
    "previous_marketplace_execution_event_count": 1
  }
}
```

This is expected after one successful live execution: the request is no longer eligible for another live execution.

### Read-only eBay title verification

Existing read-only listing check attempted first:

```js
EbayAPI.getCompetitorItemFull('202551129453')
```

That path failed because eBay Browse API returned a rate-limit error:

```text
The request limit has been reached for the resource.
```

A read-only Trading API check then verified the item:

```js
EbayAPI.callTradingAPI('GetItem', '<ItemID>202551129453</ItemID><DetailLevel>ReturnAll</DetailLevel>')
```

Observed:

```json
{
  "item_id": "202551129453",
  "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card",
  "title_matches_payload_trimmed": true,
  "ack": "Success",
  "current_price_read_only": "48.9",
  "quantity_read_only": "183",
  "quantity_sold_read_only": "180"
}
```

Note: eBay returned the title without the trailing space from the payload. The normalized/trimmed title matches the approved title.

## Rollback snapshot location

Rollback snapshot is preserved in:

- `hermes_ebay_listing_quality_packets.id=1`
- `hermes_execution_requests.id=1.execution_result.rollback_snapshot`
- `hermes_execution_events.id=11.payload.rollback_snapshot`

Rollback reference:

```text
packet_id=1
request_id=1
packet_hash=sha256:a46c12a7c33c89574aab5f10b3a2e987f984962ebb695704a1a4157c03db4412
```

The preserved rollback title is:

```text
BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card
```

## Price/inventory confirmation

The approved payload contained title only:

```json
{
  "payload_fields": ["Title"],
  "updates_title": true,
  "updates_description": false,
  "updates_item_specifics": false,
  "forbidden_fields_present": false,
  "forbidden_fields": [],
  "non_allowed_fields": []
}
```

Recorded execution result confirms:

```json
{
  "title_only": true,
  "price_changes": false,
  "inventory_changes": false
}
```

Read-only post-check observed current eBay price and quantity only for verification. No price/inventory mutation was sent in the payload.

## Final state

Phase 12I completed the approved live eBay single-SKU listing quality update.

Final state:

- only `packet_id=1` was executed
- target item id was exactly `202551129453`
- eBay response was `Ack=Warning`, parsed as success with warnings and zero errors
- `execution_result` was recorded
- `executed_at` was set after the confirmed eBay response
- marketplace execution event `id=11` was recorded
- rollback snapshot was preserved
- price changes were not sent
- inventory/quantity changes were not sent
- no retry was performed
- no other packet was executed
- no push was performed
