# Hermes Phase 12F — eBay Live Readiness Preflight v1

Report timestamp: 2026-07-02T14:18:21Z

## Scope

Phase 12F adds a read-only live readiness preflight for eBay `listing_quality_update` packet execution.

Baseline:

```text
01498af Add Phase 12E eBay response parser mock transport
```

Phase 12F did not redo Phase 12A, 12B, 12C, 12D, or 12E.

## Hard boundary

Phase 12F is read-only.

It did not call eBay.
It did not perform a network call.
It did not write to the database.
It did not write to a marketplace.
It did not change a listing.
It did not change price or inventory.
It did not update `executed_at`.
It did not update `execution_result`.
It did not print secret values.
No push was performed.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service:

```js
buildEbayListingQualityLiveReadiness({ packetId })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=<PACKET_ID>
```

The preflight checks internal state only. It builds the existing local payload, calls the existing live-call boundary in dry-run mode, verifies parser/boundary function presence, reads execution events, and checks environment variable presence without printing values.

## Readiness checks

The preflight verifies:

- packet exists
- packet status is `packet_recorded`
- confirmation status is `confirmed`
- request final approval is `approved`
- target item id exists
- payload builds successfully
- payload only contains allowed fields
- rollback snapshot exists
- response parser exists
- live-call boundary exists
- `request.executed_at` is still null
- `request.execution_result` is still null
- no previous marketplace execution event exists

The live readiness gate additionally requires:

- `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true`
- eBay credential environment variables are present

## Environment checks

Phase 12F checks presence only and prints no secret values.

Existing eBay credential env names used by this repo were identified from `src/api/ebayAPI.js`:

```text
EBAY_APP_ID
EBAY_CERT_ID
EBAY_DEV_ID
EBAY_USER_TOKEN
EBAY_REFRESH_TOKEN
```

Optional env checked:

```text
EBAY_ENVIRONMENT
```

Live enable env checked:

```text
HERMES_EBAY_LIVE_EXECUTION_ENABLED
```

The output reports booleans by name only. It does not print tokens, IDs, certs, refresh tokens, URLs, or credential values.

## Validation result

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Observed output summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "ready_for_live_execution": false,
  "ready_for_dry_run": true,
  "live_enabled": false,
  "credentials_present": true,
  "missing_requirements": [
    "live_ebay_execution_disabled"
  ],
  "dry_run_missing_requirements": [],
  "checks": {
    "packet_exists": true,
    "packet_status": "packet_recorded",
    "confirmation_status": "confirmed",
    "request_final_approval_status": "approved",
    "target_item_id_exists": true,
    "payload_builds": true,
    "payload_only_allowed_fields": true,
    "payload_forbidden_fields_present": false,
    "rollback_snapshot_exists": true,
    "response_parser_exists": true,
    "live_call_boundary_exists": true,
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "no_previous_marketplace_execution_event": true,
    "previous_marketplace_execution_event_count": 0
  },
  "environment": {
    "checked_names_only": true,
    "live_enable_env_name": "HERMES_EBAY_LIVE_EXECUTION_ENABLED",
    "live_enable_env_present": false,
    "credential_env_presence": {
      "EBAY_APP_ID": true,
      "EBAY_CERT_ID": true,
      "EBAY_DEV_ID": true,
      "EBAY_USER_TOKEN": true,
      "EBAY_REFRESH_TOKEN": true
    },
    "optional_env_presence": {
      "EBAY_ENVIRONMENT": true
    },
    "missing_credential_env_names": [],
    "values_printed": false
  },
  "safety": {
    "actual_ebay_call": false,
    "actual_network_call": false,
    "actual_database_write": false,
    "secrets_printed": false,
    "read_only": true
  }
}
```

`credentials_present` is true in this local environment because the required eBay credential env names are present. Live readiness still remains false because the live execution enable env is not set.

## Disabled write boundary validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-call-boundary --packet-id=1 --write
```

This command remained blocked because no live env was set.

Expected safety result remained:

```json
{
  "blocked": true,
  "actual_ebay_call": false,
  "actual_network_call": false,
  "actual_database_write": false
}
```

## Other validation commands

Syntax checks passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
```

Execution detail passed:

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
  "no_database_write_from_live_readiness": true,
  "no_marketplace_writes": true,
  "no_listing_changed": true,
  "no_price_changed": true,
  "no_inventory_changed": true,
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "external_action_executed_false": true,
  "marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0,
  "secrets_printed": false
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
- secret-value printing indicators
- price/quantity/inventory mutation fields

Unsafe findings:

- no eBay API client import or invocation was added
- no network call was added
- no new database write path was added by Phase 12F
- no marketplace write API invocation was added
- no route write method was added
- no UI write fetch method was added
- no secret values are printed by the readiness output
- no `executed_at` update was added
- no `execution_result` update was added

Expected benign matches:

- existing `src/api/ebayAPI.js` contains live eBay API code and env names; Phase 12F reads env names from that existing pattern but does not import or call it
- `ReviseFixedPriceItem` appears only as operation/parser/payload naming and docs
- false safety flags
- env variable names without values
- forbidden-field regex/check strings
- cached read column names and existing safety text

## Final state

Phase 12F provides a read-only live readiness preflight.

For packet 1:

- dry-run readiness is true
- live readiness is false
- the only live readiness blocker is `live_ebay_execution_disabled`
- no eBay API call occurred
- no database execution result write occurred
