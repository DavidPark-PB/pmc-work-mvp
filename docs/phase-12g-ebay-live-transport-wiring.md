# Hermes Phase 12G — eBay Live Transport Wiring v1

Report timestamp: 2026-07-02T14:35:46Z

## Scope

Phase 12G wires the eBay `listing_quality_update` live transport boundary to the existing eBay API module, while keeping actual live calls disabled in validation.

Baseline:

```text
246129a Add Phase 12F eBay live readiness preflight
```

Phase 12G did not redo Phase 12A through Phase 12F.

## Hard boundary

Phase 12G validation did not call eBay.
Phase 12G validation did not perform a network call.
Phase 12G validation did not write to the database.
Phase 12G validation did not write to a marketplace.
Phase 12G validation did not change a listing.
Phase 12G validation did not change price or inventory.
Phase 12G validation did not update `executed_at`.
Phase 12G validation did not update `execution_result`.
No push was performed.

## Existing eBay API call pattern

The existing eBay API module is:

```text
src/api/ebayAPI.js
```

It exports the `EbayAPI` class.

The existing Trading API pattern is:

```js
const EbayAPI = require('../api/ebayAPI');
const ebay = new EbayAPI();
await ebay.callTradingAPI('ReviseFixedPriceItem', requestBodyXml);
```

Phase 12G reuses this existing module and does not create new auth logic.

Existing auth behavior remains owned by `src/api/ebayAPI.js`:

- `EBAY_APP_ID`
- `EBAY_CERT_ID`
- `EBAY_DEV_ID`
- `EBAY_USER_TOKEN`
- `EBAY_REFRESH_TOKEN`
- optional `EBAY_ENVIRONMENT`
- DB token fallback/refresh via the existing token store logic

## Implementation

Updated:

```text
src/adapters/ebayListingQualityExecutionAdapter.js
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added adapter helpers:

```js
ebayRevisePayloadToTradingXml(payload)
callEbayListingQualityLiveTransport({ packet, request, payload, dryRun, writeRequested, liveEnabled, ebayApiModulePath })
```

Added service wrapper:

```js
callEbayListingQualityLiveTransportBoundary({ packetId, dryRun, writeRequested, liveEnabled })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=<PACKET_ID> [--dry-run|--write]
```

## Live transport gates

The live transport can only reach the future call branch when all are true:

- `dryRun === false`
- explicit CLI `--write` is present
- `HERMES_EBAY_LIVE_EXECUTION_ENABLED === true`
- packet status is `packet_recorded`
- confirmation status is `confirmed`
- request final approval is `approved`
- request `executed_at` is null
- request `execution_result` is null
- request metadata does not indicate external action executed
- request metadata does not indicate marketplace execution approved
- target item id exists
- rollback snapshot exists
- payload has only allowed fields
- no forbidden price/quantity/inventory/end/create/relist/shipping/payment/returns fields
- existing `src/api/ebayAPI.js` module is detected

Validation did not set the live env, so the live branch was not reached.

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --dry-run
```

Observed output summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "payload_ready": true,
  "existing_ebay_api_module_detected": true,
  "existing_ebay_api_call_pattern": "new EbayAPI().callTradingAPI(callName, requestBody)",
  "live_transport_wired": true,
  "dry_run": true,
  "explicit_write_requested": false,
  "live_enabled": false,
  "env_live_enabled": false,
  "blocked": false,
  "blockers": [],
  "would_call_ebay": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "marketplace_write_performed": false,
  "existing_ebay_api_module_path": "src/api/ebayAPI.js",
  "existing_ebay_api_module_export_detected": true,
  "existing_ebay_api_auth_logic_reused": true,
  "new_auth_logic_created": false
}
```

Transport request preview:

```json
{
  "call_name": "ReviseFixedPriceItem",
  "request_body_xml_preview": "<Item><ItemID>202551129453</ItemID><Title>BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card </Title></Item>",
  "generated_from_payload": true
}
```

## Disabled write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --write
```

No live env was set.

Observed output summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "payload_ready": true,
  "existing_ebay_api_module_detected": true,
  "live_transport_wired": true,
  "live_enabled": false,
  "blocked": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "blockers": [
    "live_ebay_execution_disabled",
    "live_ebay_execution_env_disabled"
  ]
}
```

This proves the write-shaped transport exists but remains blocked without explicit live enablement.

## Other validation commands

Syntax checks passed:

```bash
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Live readiness still passes:

```bash
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Execution detail still passes:

```bash
npm run hermes:agent -- execution-detail --id=1
```

## Direct safety assertions

Direct post-validation assertions:

```json
{
  "packet_id": 1,
  "packet_status": "packet_recorded",
  "confirmation_status": "confirmed",
  "target_item_id_exists": true,
  "no_ebay_api_call": true,
  "no_network_call": true,
  "no_database_write_from_live_transport_validation": true,
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
- network call indicators such as `fetch(`, `axios`, `http://`, and `https://`
- database write methods `.insert(`, `.update(`, `.upsert(`, `.delete(`
- route `POST/PUT/PATCH/DELETE`
- UI HTTP write methods
- price/quantity/inventory mutation fields
- `executed_at` and `execution_result` mutation indicators

Unsafe findings:

- no eBay API call occurred in validation
- no network call occurred in validation
- no database write path was added for validation
- no marketplace write occurred
- no route write method was added
- no UI write fetch method was added
- no `executed_at` update was added
- no `execution_result` update was added

Expected benign matches:

- `src/api/ebayAPI.js` contains the existing `axios.post` and `callTradingAPI` implementation; Phase 12G identifies and wires to this existing module but validation does not instantiate/call it on the blocked path
- `ReviseFixedPriceItem` appears as intended operation/call name text
- false safety flags
- forbidden-field regex/check strings
- existing internal DB write helpers unrelated to Phase 12G validation
- cached read column names and safety text

## Final state

Phase 12G wires the live transport boundary to the existing eBay API module and call pattern.

For packet 1:

- payload is ready
- existing eBay API module is detected
- live transport is wired
- live execution remains disabled because `HERMES_EBAY_LIVE_EXECUTION_ENABLED` is not set
- disabled write validation blocks
- no eBay API call occurred
- no DB execution result write occurred
