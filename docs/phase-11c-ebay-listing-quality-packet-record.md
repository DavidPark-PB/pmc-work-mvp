# Hermes Phase 11C — eBay Listing Quality Packet Record

Report timestamp: 2026-07-02T12:17:29Z

## Scope

Phase 11C adds an internal immutable review artifact flow for operator-provided eBay `listing_quality_update` packets.

This phase creates an internal packet table, service write path, CLI command, and read-only detail/UI visibility. It does not perform marketplace execution.

Phase 11C does not:

- implement real eBay revision
- call eBay APIs
- call Shopee or Shopify APIs
- call marketplace APIs
- change price
- change inventory
- change live listings
- revise, end, create, or relist listings
- update `executed_at`
- update `execution_result`
- add UI buttons
- add UI write fetch calls
- push commits

## Baseline

Phase 11B is complete and committed:

```text
aa832c4 Add Phase 11B eBay operator mutation packet
```

Phase 11B proved a safe title-only operator packet can become ready for request id 1 while still remaining dry-run/internal-only.

## Migration

Created:

```text
supabase/migrations/065_hermes_ebay_listing_quality_packets.sql
```

Table:

```text
hermes_ebay_listing_quality_packets
```

Columns:

- `id serial primary key`
- `request_id integer not null references hermes_execution_requests(id)`
- `item_id text not null`
- `actor text`
- `reason text`
- `packet_hash text not null`
- `planned_mutation jsonb not null`
- `before_snapshot jsonb not null`
- `rollback_snapshot jsonb not null`
- `safety_flags jsonb not null`
- `status text not null default 'packet_recorded'`
- `created_at timestamp default now()`

Allowed statuses:

- `packet_recorded`
- `packet_rejected`
- `packet_expired`

The table intentionally has no marketplace response fields and no execution result fields.

## Active migration status during validation

Active Supabase/PostgREST table visibility check returned:

```json
{
  "table_visible": false,
  "error_code": "PGRST205",
  "error_message": "Could not find the table 'public.hermes_ebay_listing_quality_packets' in the schema cache"
}
```

Therefore write validation was not run in this pass.

Required operator step before write validation:

```sql
-- Apply the full contents of:
-- supabase/migrations/065_hermes_ebay_listing_quality_packets.sql
```

After applying migration 065 and refreshing the Supabase/PostgREST schema cache if needed, rerun:

```bash
npm run hermes:agent -- ebay-listing-quality-record-packet --id=1 --actor=operator --reason="operator packet validation" --title="BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card - Operator Review" --write
```

## Service implementation

Updated:

- `src/services/hermesExecutionApproval.js`

Added:

```js
recordEbayListingQualityPacket({ requestId, title, description, itemSpecifics, actor, reason, dryRun })
listEbayListingQualityPackets({ requestId, limit })
```

`recordEbayListingQualityPacket` behavior:

- defaults to `dryRun = true`
- write mode requires `actor`
- write mode requires `reason`
- reuses `buildOperatorEbayListingQualityPacket`
- requires `operator_packet.ready = true`
- requires `execution_packet_ready = true`
- requires non-empty safe `planned_mutation`
- rejects price/quantity/inventory/end/create/relist fields
- computes stable `packet_hash`
- write mode inserts only an internal packet row
- write mode inserts only one internal event: `ebay_listing_quality_packet_recorded`
- never calls eBay API
- never updates `executed_at`
- never updates `execution_result`

## CLI

Added:

```bash
npm run hermes:agent -- ebay-listing-quality-record-packet --id=<REQUEST_ID> --actor=<USER> --reason="..." [--title="..."] [--description="..."] [--item-specifics-json='{}'] [--dry-run|--write]
```

Default is dry-run.

Dry-run validation command:

```bash
npm run hermes:agent -- ebay-listing-quality-record-packet --id=1 --actor=operator --reason="operator packet validation" --title="BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card - Operator Review" --dry-run
```

Observed dry-run result:

```json
{
  "dry_run": true,
  "created": false,
  "blocked": false,
  "request_id": 1,
  "packet_hash": "sha256:a46c12a7c33c89574aab5f10b3a2e987f984962ebb695704a1a4157c03db4412",
  "record_preview": {
    "request_id": 1,
    "item_id": "202551129453",
    "actor": "operator",
    "reason": "operator packet validation",
    "status": "packet_recorded",
    "planned_mutation": {
      "title": "BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card ",
      "description": null,
      "item_specifics": {}
    }
  },
  "event_preview": {
    "event_type": "ebay_listing_quality_packet_recorded",
    "actor": "operator"
  },
  "safety": {
    "marketplace_api_calls": false,
    "execution_performed": false,
    "ebay_api_calls": false,
    "price_changes": false,
    "inventory_changes": false,
    "listing_revisions": false,
    "database_writes": false
  }
}
```

## Detail and UI visibility

Execution detail now includes:

```text
ebay_listing_quality_packets
```

When migration 065 is not visible, detail returns:

```json
{
  "count": 0,
  "data": [],
  "migration_required": true,
  "migration": "supabase/migrations/065_hermes_ebay_listing_quality_packets.sql"
}
```

UI now shows recorded eBay listing quality packets when available:

- packet hash
- actor
- reason
- status
- item id
- planned mutation JSON
- rollback snapshot JSON

No buttons were added.
No write fetch calls were added.

## Validation

Syntax validation passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check public/js/hermesExecutionRequests.js
```

Read-path validation passed:

```bash
npm run hermes:agent -- ebay-listing-quality-record-packet --id=1 --actor=operator --reason="operator packet validation" --title="BTS 2017 The Wings Tour In Seoul DVD Live Trilogy Episode III Set No Photo Card - Operator Review" --dry-run
npm run hermes:agent -- execution-detail --id=1
```

Write validation was skipped because migration 065 was not visible in active Supabase/PostgREST during validation.

Direct safety assertions:

```json
{
  "dry_run": true,
  "created": false,
  "blocked": false,
  "packet_hash_exists": true,
  "record_status": "packet_recorded",
  "table_visible": false,
  "migration_required": true,
  "write_validation_ran": false,
  "write_validation_skipped_reason": "migration_065_not_applied_or_schema_cache_stale",
  "planned_mutation_keys": ["title", "description", "item_specifics"],
  "title_only_or_allowed_fields_only": true,
  "no_price_quantity_fields": true,
  "no_end_create_relist_fields": true,
  "no_ebay_api_call": true,
  "no_listing_changed": true,
  "no_price_inventory_changed": true,
  "executed_at_still_null": true,
  "execution_result_still_null": true,
  "external_action_executed_false": true,
  "marketplace_execution_approved_false": true,
  "marketplace_execution_event_count": 0
}
```

## Safety audit

Safety grep covered:

- marketplace write APIs
- eBay/Shopee/Shopify API call indicators
- price/quantity mutation fields
- route POST/PUT/PATCH/DELETE
- UI HTTP write methods

Unsafe findings:

- no marketplace write API calls added
- no eBay API call added
- no Shopee/Shopify API call added
- no route POST/PUT/PATCH/DELETE handlers added
- no UI HTTP write methods added
- no price/quantity mutation added
- no live listing change added

Expected benign matches:

- existing safety strings and false flags
- forbidden-field regex/check strings
- existing read-only UI GET `fetch()` calls
- migration DDL for internal packet table
- internal `.insert()` for `hermes_ebay_listing_quality_packets`
- internal event insert for `ebay_listing_quality_packet_recorded`

## Boundary

Phase 11C records only an internal review artifact after migration 065 is applied.

No eBay API was called.
No marketplace execution occurred.
No listing changed.
No price or inventory changed.
No execution fields were updated.
No live listing revision was implemented.
No push was performed.
