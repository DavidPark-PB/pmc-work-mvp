# Hermes Phase 12E — eBay Response Parser and Mock Transport v1

Report timestamp: 2026-07-02T14:04:03Z

## Scope

Phase 12E adds a mock transport layer and response parser for future eBay `listing_quality_update` execution.

Baseline:

```text
ba8a71f Add Phase 12D eBay live call boundary
```

Phase 12E did not redo Phase 12A, 12B, 12C, or 12D. It builds the real local payload, passes that payload through a mock-only transport, and parses mock ReviseFixedPriceItem-style responses.

## Hard boundary

Phase 12E did not call eBay.
Phase 12E did not perform any network call.
Phase 12E did not write to a marketplace.
Phase 12E did not change any live listing.
Phase 12E did not change price or inventory.
Phase 12E did not update `executed_at`.
Phase 12E did not update `execution_result`.
Phase 12E did not write to the database by default.
No push was performed.

## Implementation

Updated:

```text
src/adapters/ebayListingQualityExecutionAdapter.js
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added adapter functions:

```js
parseEbayReviseFixedPriceItemResponse(rawResponse)
mockEbayListingQualityReviseTransport({ payload, scenario, correlationId, timestamp })
mockCallEbayListingQualityRevise({ packet, request, payload, scenario })
```

Added service function:

```js
mockCallEbayListingQualityPacket({ packetId, scenario, dryRun })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=success
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=warning
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=failure
```

Default behavior is dry-run / no database write.

An optional `--write` form exists, but Phase 12E validation did not run it. If used later, it only records an internal event named `ebay_listing_quality_mock_call_validated` with:

- `actual_ebay_call = false`
- `mock_transport = true`
- `marketplace_write_performed = false`
- no `executed_at` update
- no `execution_result` update

## Parser output

The parser normalizes ReviseFixedPriceItem-style mock responses to:

```json
{
  "success": true,
  "ack": "Success",
  "item_id": "202551129453",
  "correlation_id": "mock-ebay-listing-quality-success-202551129453",
  "timestamp": "ISO8601",
  "warnings": [],
  "errors": [],
  "raw_response": {}
}
```

For warning responses, `success = true`, `ack = Warning`, warnings are populated, and errors remain empty.

For failure responses, `success = false`, `ack = Failure`, errors are populated.

## Mock transport scenarios

### Success

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=success
```

Observed summary:

```json
{
  "scenario": "success",
  "ack": "Success",
  "success": true,
  "item_id": "202551129453",
  "warnings": [],
  "errors": [],
  "mock_transport": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false
}
```

### Warning

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=warning
```

Observed summary:

```json
{
  "scenario": "warning",
  "ack": "Warning",
  "success": true,
  "item_id": "202551129453",
  "warnings": 1,
  "errors": 0,
  "mock_transport": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false
}
```

### Failure

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=failure
```

Observed summary:

```json
{
  "scenario": "failure",
  "ack": "Failure",
  "success": false,
  "item_id": "202551129453",
  "warnings": [],
  "errors": 1,
  "mock_transport": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false
}
```

## Payload used by mock transport

The mock call builds the real local payload first:

```json
{
  "Item": {
    "ItemID": "202551129453",
    "Title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card "
  }
}
```

Then it routes only through the mock transport. No live call boundary is opened and no eBay client is imported.

## Validation commands

Syntax checks passed:

```bash
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Mock call scenarios passed:

```bash
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=success
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=warning
npm run hermes:agent -- ebay-listing-quality-mock-call --packet-id=1 --scenario=failure
```

Execution detail passed:

```bash
npm run hermes:agent -- execution-detail --id=1
```

## Direct safety assertions

Direct post-validation assertions:

```json
{
  "mock_validation_event_count": 0,
  "no_mock_db_write_by_default": true,
  "no_ebay_api_call": true,
  "no_network_call": true,
  "no_marketplace_writes": true,
  "no_listing_changed": true,
  "no_price_changed": true,
  "no_inventory_changed": true,
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "external_action_executed_false": true,
  "marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0
}
```

## Safety grep

Safety grep covered focused files for:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- route `POST/PUT/PATCH/DELETE`
- UI HTTP write methods
- price/quantity/inventory mutation fields
- network call indicators such as `fetch(`, `axios`, and URL strings

Unsafe findings:

- no eBay API client import or invocation was added
- no network call was added
- no marketplace write API invocation was added
- no route write method was added
- no UI write fetch method was added
- no executed_at update was added
- no execution_result update was added

Expected benign matches:

- `ReviseFixedPriceItem` appears only as an `api_operation` string and documentation, not as a function call
- false safety flags
- mock response object names
- forbidden-field regex/check strings
- documentation text explaining forbidden fields

## Final state

Phase 12E provides a deterministic mock transport and parser for eBay listing quality revise responses.

This prepares response-shape handling for a future live phase while preserving the no-marketplace-execution boundary.

No eBay API call occurred in Phase 12E.
