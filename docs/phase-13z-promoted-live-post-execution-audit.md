# Hermes Phase 13Z — Promoted Live Post-Execution Audit

## Scope

Phase 13Z finalizes the post-live audit for the promoted single-SKU item specifics execution path.

This phase does not execute eBay again.
This phase does not call `ReviseFixedPriceItem` again.
This phase does not perform any marketplace write.

The already-completed live execution is treated as immutable evidence:

```json
{
  "approval_id": 15,
  "request_id": 4,
  "packet_id": 3,
  "target_item_id": "206315990948",
  "operation": "ReviseFixedPriceItem",
  "response_success": true,
  "ack": "Warning",
  "executed_at": "2026-07-03T15:33:17.714",
  "marketplace_execution_completed_event_id": 12,
  "request_status": "executed"
}
```

## Executed payload scope

The live request payload contained only `ItemSpecifics`:

```json
{
  "Item": {
    "ItemID": "206315990948",
    "ItemSpecifics": {
      "NameValueList": [
        { "Name": "Type", "Value": "Magnet" },
        { "Name": "Brand", "Value": "Pokemon" },
        { "Name": "Theme", "Value": "Anime & Manga" },
        { "Name": "Franchise", "Value": "Pokemon" },
        { "Name": "Country/Region of Manufacture", "Value": "Korea, Republic of" },
        { "Name": "Original/Licensed Reproduction", "Value": "Original" }
      ]
    }
  }
}
```

Confirmed non-mutated fields:

- no price change
- no inventory change
- no quantity change
- no title change
- no description change

## Phase 13Z implementation

Updated:

```text
src/services/hermesExecutionApproval.js
```

The promoted live transport path now preserves a dedicated final-packet execution guard for the exact approved tuple:

```json
{
  "approval_id": 15,
  "request_id": 4,
  "packet_id": 3,
  "target_item_id": "206315990948",
  "planned_mutation_fields": ["item_specifics"],
  "payload_fields": ["ItemSpecifics"]
}
```

The guard blocks duplicate execution when any of the following post-execution facts are present:

- `request.executed_at` is not null
- `request.execution_result` is not null
- a previous marketplace execution lifecycle event exists for request id `4`
- `metadata.external_action_executed` is no longer false
- `metadata.marketplace_execution_approved` is no longer false

The Phase 13Y final packet path is separate from the original placeholder source path:

```json
{
  "source_request_id": 3,
  "source_packet_id": 2,
  "final_request_id": 4,
  "final_packet_id": 3
}
```

Request id `3` remains unexecuted and has no marketplace execution events.

## Post-execution duplicate guard validation

Read-only duplicate guard check:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-transport --approval-id=15 --dry-run
```

Observed result after execution:

```json
{
  "dry_run": true,
  "write_requested": false,
  "approval_id": 15,
  "request_id": 4,
  "packet_id": 3,
  "ready_for_live_call": false,
  "would_call_ebay": false,
  "blocked": true,
  "blockers": [
    "request_executed_at_present",
    "request_execution_result_present",
    "metadata_external_action_executed_not_false",
    "metadata_marketplace_execution_approved_not_false",
    "previous_marketplace_execution_event_exists"
  ],
  "actual_ebay_call": false,
  "actual_network_call": false,
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "executed_at_updated": false,
  "execution_result_updated": false,
  "phase13y_live_execution_blockers": [
    "request_executed_at_present",
    "request_execution_result_present",
    "metadata_external_action_executed_not_false",
    "metadata_marketplace_execution_approved_not_false",
    "previous_marketplace_execution_event_exists"
  ],
  "previous_marketplace_execution_event_count_before_call": 1
}
```

## Post-readiness audit

Readiness command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=15
```

Observed result after execution:

```json
{
  "read_only": true,
  "approval_id": 15,
  "request_id": 4,
  "legacy_packet_id": 3,
  "source_request_id": 3,
  "source_legacy_packet_id": 2,
  "using_final_item_specifics_packet": true,
  "ready_for_promoted_live_path_review": false,
  "ready_for_live_execution": false,
  "blockers": [
    "request_executed_at_present",
    "request_execution_result_present",
    "external_action_executed_true",
    "marketplace_execution_approved_true",
    "previous_marketplace_execution_event_exists"
  ],
  "checks": {
    "request_executed_at_is_null": false,
    "request_execution_result_is_null": false,
    "metadata_external_action_executed_false": false,
    "metadata_marketplace_execution_approved_false": false,
    "no_previous_marketplace_execution_event": false,
    "previous_marketplace_execution_event_count": 1,
    "payload_item_specifics_only": true
  },
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["ItemSpecifics"],
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "non_allowed_fields": []
  },
  "safety": {
    "actual_ebay_call": false,
    "actual_network_call": false,
    "marketplace_write_performed": false,
    "revise_fixed_price_item_called": false,
    "live_execution_performed": false,
    "executed_at_updated": false,
    "execution_result_updated": false
  }
}
```

## Execution event audit

Request id `4`:

```bash
npm run hermes:agent -- execution-events --id=4 --limit=20
```

Observed:

```json
{
  "count": 1,
  "event_id": 12,
  "event_type": "marketplace_execution_completed",
  "request_id": 4,
  "packet_id": 3,
  "target_item_id": "206315990948",
  "success": true,
  "ack": "Warning",
  "payload_fields": ["ItemSpecifics"],
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "title_changes": false,
  "description_changes": false,
  "item_specifics_changes": true
}
```

Request id `3`:

```bash
npm run hermes:agent -- execution-events --id=3 --limit=20
```

Observed:

```json
{
  "count": 0,
  "data": []
}
```

## Validation commands

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=15
npm run hermes:agent -- execution-events --id=4 --limit=20
npm run hermes:agent -- execution-events --id=3 --limit=20
git diff --stat
```

Validation completed with no syntax errors. The read-only audits confirm the duplicate execution guard blocks another run and that no additional marketplace write was performed during Phase 13Z.
