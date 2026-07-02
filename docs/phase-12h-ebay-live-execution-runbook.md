# Hermes Phase 12H — eBay Live Execution Runbook

Report timestamp: 2026-07-02T14:46:37Z

## Scope

Phase 12H creates the final operator runbook and live execution checklist for the single confirmed eBay `listing_quality_update` packet.

Baseline:

```text
b76d614 Add Phase 12G eBay live transport wiring
```

Phase 12H did not redo Phase 12A through Phase 12G.

## Explicit warning

Phase 12H does not execute live marketplace changes.

It does not call eBay.
It does not perform a network call.
It does not write to the database.
It does not write to a marketplace.
It does not change a listing.
It does not change price or inventory.
It does not update `executed_at`.
It does not update `execution_result`.
It does not mark marketplace execution complete.
It does not print secret values.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service:

```js
buildEbayListingQualityLiveRunbook({ packetId })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-live-runbook --packet-id=<PACKET_ID>
```

The CLI is read-only. It composes existing packet, payload, rollback snapshot, readiness, credential-presence, and previous-execution status into an operator checklist.

## Final pre-live state for packet 1

Observed runbook summary:

```json
{
  "packet_id": 1,
  "request_id": 1,
  "target_item_id": "202551129453",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "current_approval_status": {
    "request_status": "dry_run_ready",
    "final_approval_status": "approved",
    "final_approval_actor": "operator"
  },
  "confirmation_status": {
    "packet_status": "packet_recorded",
    "confirmation_status": "confirmed",
    "confirmed_by_actor": "operator",
    "packet_hash": "sha256:a46c12a7c33c89574aab5f10b3a2e987f984962ebb695704a1a4157c03db4412"
  },
  "payload_summary": {
    "updates_title": true,
    "updates_description": false,
    "updates_item_specifics": false,
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "non_allowed_fields": []
  },
  "live_readiness_summary": {
    "ready_for_live_execution": false,
    "ready_for_dry_run": true,
    "live_enabled": false,
    "missing_requirements": [
      "live_ebay_execution_disabled"
    ]
  }
}
```

Current payload changes only the title field. It does not include price, quantity, inventory, stock, end/create/relist, shipping, payment, or returns changes.

## Credential presence summary

The runbook checks environment variable presence only. It does not print values.

Checked names:

```text
HERMES_EBAY_LIVE_EXECUTION_ENABLED
EBAY_APP_ID
EBAY_CERT_ID
EBAY_DEV_ID
EBAY_USER_TOKEN
EBAY_REFRESH_TOKEN
EBAY_ENVIRONMENT
```

Observed summary:

```json
{
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
}
```

Credentials are present by name in this local environment, but live execution remains disabled because `HERMES_EBAY_LIVE_EXECUTION_ENABLED` is not set.

## Rollback snapshot summary

Observed rollback snapshot summary:

```json
{
  "available": true,
  "title_present": true,
  "description_present": false,
  "item_specifics_present": false,
  "item_specifics_count": 0,
  "source": "packet_internal_snapshots",
  "packet_hash": "sha256:a46c12a7c33c89574aab5f10b3a2e987f984962ebb695704a1a4157c03db4412",
  "confirmation_snapshot_reference_present": true
}
```

The rollback source includes packet internal snapshots and references the packet hash / confirmation snapshot. Description and item specifics are absent in the available pre-change snapshot, so rollback is primarily title-based for this confirmed packet.

## Live execution prerequisites

Before any future operator-approved live execution, all of the following must be true:

1. Operator explicitly approves live marketplace execution for this exact packet.
2. `packet_id` remains `1`.
3. `request_id` remains `1`.
4. `target_item_id` remains `202551129453`.
5. Packet status remains `packet_recorded`.
6. Confirmation status remains `confirmed`.
7. Request final approval remains `approved`.
8. `request.executed_at` remains null before execution.
9. `request.execution_result` remains null before execution.
10. No previous marketplace execution event exists.
11. Payload builds successfully.
12. Payload contains allowed fields only: `title`, `description`, `item_specifics`.
13. Payload contains no price, quantity, inventory, stock, end/create/relist, shipping, payment, or returns changes.
14. Rollback snapshot is present.
15. Response parser exists.
16. Live transport boundary exists.
17. Existing `src/api/ebayAPI.js` module is detected.
18. Credential env names are present.
19. `HERMES_EBAY_LIVE_EXECUTION_ENABLED=true` is set only for the intentional live command invocation.
20. The operator understands that the live command may revise an eBay listing.

## Exact command sequence

### 1. Read-only runbook

```bash
npm run hermes:agent -- ebay-listing-quality-live-runbook --packet-id=1
```

### 2. Read-only live readiness

```bash
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Expected before live approval:

- `ready_for_dry_run=true`
- `ready_for_live_execution=false`
- `missing_requirements` includes `live_ebay_execution_disabled`
- no secret values are printed

### 3. Dry-run live transport preview

```bash
npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --dry-run
```

Expected:

- `payload_ready=true`
- `live_transport_wired=true`
- `actual_ebay_call=false`
- `actual_network_call=false`
- `actual_database_write=false`

### 4. Disabled write test

```bash
npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --write
```

Expected while live env is not set:

- `blocked=true`
- blockers include `live_ebay_execution_disabled` and `live_ebay_execution_env_disabled`
- `actual_ebay_call=false`
- `actual_network_call=false`
- `actual_database_write=false`

### 5. Live command — DO NOT RUN UNLESS OPERATOR APPROVES

```bash
HERMES_EBAY_LIVE_EXECUTION_ENABLED=true npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --write
```

DO NOT RUN this command unless the operator explicitly approves live execution for this exact packet and understands it may revise a live eBay listing.

Phase 12H does not run this command.

## Rollback plan

If a future approved live execution changes the listing incorrectly:

1. Stop further execution attempts.
2. Capture the live execution output, including eBay response, ack, correlation id, timestamp, warnings, and errors.
3. Run:

```bash
npm run hermes:agent -- execution-detail --id=1
```

4. Locate the packet rollback snapshot and packet hash:

```text
packet_id=1
packet_hash=sha256:a46c12a7c33c89574aab5f10b3a2e987f984962ebb695704a1a4157c03db4412
```

5. Restore the best available pre-change title from the rollback snapshot using an explicitly approved rollback phase or manual eBay Seller Hub operation.
6. Do not use any automated rollback command unless a later explicit rollback phase implements and validates it.
7. After rollback, verify the listing in eBay Seller Hub and record the result internally.

Rollback limitation for this packet:

- title is present
- description is not available
- item specifics are not available

## Failure handling

If the future live command fails before calling eBay:

- Treat the result as blocked.
- Do not retry by bypassing gates.
- Inspect blockers.
- Re-run the runbook and readiness commands.

If the future live command reaches eBay and eBay returns failure:

- Do not mark marketplace execution complete.
- Preserve raw response, parsed response, correlation id, timestamp, warnings, and errors.
- Re-run `execution-detail` for internal state.
- Do not retry unless the operator approves another attempt after reviewing the exact eBay error.

If eBay returns warning:

- Treat as operator-review-required unless the warning was explicitly accepted by the operator.
- Preserve warning text and correlation id.
- Verify the listing state manually before recording final success.

If eBay returns success:

- Verify the listing state independently.
- Only a later explicit phase should persist final `executed_at` / `execution_result` semantics if not already implemented.

## Post-execution verification steps

After any future operator-approved live attempt, run:

```bash
npm run hermes:agent -- execution-detail --id=1
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Then verify:

- eBay response ack, correlation id, and timestamp are recorded or captured.
- Target item id is still `202551129453`.
- Only the approved listing quality field changed.
- Price did not change.
- Quantity/inventory did not change.
- No end/create/relist action occurred.
- Internal status accurately reflects the real outcome.
- No false success is recorded if eBay failed or only partially accepted the request.

## Phase 12H validation

Syntax checks passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
```

Runbook validation passed:

```bash
npm run hermes:agent -- ebay-listing-quality-live-runbook --packet-id=1
```

Readiness validation passed:

```bash
npm run hermes:agent -- ebay-listing-quality-live-readiness --packet-id=1
```

Disabled write transport validation passed:

```bash
npm run hermes:agent -- ebay-listing-quality-live-transport --packet-id=1 --write
```

Execution detail validation passed:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Direct safety assertions:

```json
{
  "packet_id": 1,
  "packet_status": "packet_recorded",
  "confirmation_status": "confirmed",
  "target_item_id_exists": true,
  "no_ebay_api_call": true,
  "no_network_call": true,
  "no_database_write_from_runbook_validation": true,
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
- `executed_at` and `execution_result` mutation indicators

Unsafe findings:

- no new eBay API call path was added by Phase 12H
- no network call was added by Phase 12H
- no database write path was added by Phase 12H
- no marketplace write occurred
- no route write method was added
- no UI write fetch method was added
- no secret values are printed by the runbook output
- no `executed_at` update was added
- no `execution_result` update was added

Expected benign matches:

- Phase 12G live transport contains the previously added future live branch gated by live env and operator write
- `ReviseFixedPriceItem` appears as operation/call name text
- false safety flags
- env variable names without values
- forbidden-field regex/check strings
- existing internal DB write helpers unrelated to Phase 12H validation
- cached read column names and safety text

## Final state

Phase 12H provides the operator runbook and checklist only.

For packet 1:

- final approval is present
- packet confirmation is present
- payload is title-only and safe by field policy
- rollback snapshot is available
- credentials are present by env-name check
- live execution remains disabled
- disabled write validation blocks
- no eBay API call occurred
- no database execution result write occurred
