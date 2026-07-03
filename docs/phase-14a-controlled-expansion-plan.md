# Hermes Phase 14A — Controlled Expansion Planner

## Scope

Phase 14A starts a new controlled multi-candidate expansion cycle after Phase 13 was fully closed out.

Baseline:

```text
f54e7b5 Add Phase 13 final closeout
```

Phase 14A is read-only planning only. It does not redo Phase 13 and does not reuse the Phase 13 live execution records.

## Hard safety boundary

Phase 14A must not:

- execute eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- write database rows
- create packets
- create approvals
- create execution requests
- call AI from implemented app logic
- push commits

The planner only reads internal Hermes tables and cached evidence.

## CLI

```bash
npm run hermes:agent -- ebay-listing-quality-controlled-expansion-plan --limit=50
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service:

```js
buildEbayListingQualityControlledExpansionPlan({ limit })
```

Added CLI command:

```text
ebay-listing-quality-controlled-expansion-plan
```

The planner reuses existing internal candidate-source and cached evidence helpers, then applies Phase 14A-specific exclusion and classification rules.

## Exclusion policy

The planner excludes already executed live items from the actionable expansion plan.

Hard-excluded item ids:

```json
[
  "202551129453",
  "206315990948"
]
```

The planner also excludes:

- any item with a `marketplace_execution_completed` event
- any request with `executed_at` present
- any request with `execution_result` present

Phase 13 live records must not be reused:

```json
{
  "do_not_reuse_request_ids": [4],
  "do_not_reuse_packet_ids": [3]
}
```

## Classification buckets

Each candidate row is assigned one classification:

- `ready_for_cached_evidence_review`
- `needs_evidence_refresh`
- `blocked_already_executed`
- `blocked_missing_item_id`
- `blocked_no_listing_quality_signal`
- `blocked_price_or_inventory_related`
- `blocked_insufficient_cached_evidence`

The classification is advisory only; it does not create records and does not write state.

## Output fields

The planner output includes:

- scanned counts
- excluded executed item ids
- candidate rows
- blockers
- recommended next safe action
- safety object proving read-only behavior

## Validation result

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-controlled-expansion-plan --limit=50
```

Observed summary:

```json
{
  "read_only": true,
  "phase": "14A",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "limit": 50,
  "scanned_counts": {
    "request_count": 4,
    "opportunity_count": 15,
    "source_count": 5,
    "candidate_count": 5,
    "returned_candidate_count": 5,
    "marketplace_execution_event_count": 2,
    "marketplace_execution_completed_event_count": 2,
    "executed_request_count": 2,
    "classification_counts": {
      "blocked_already_executed": 4,
      "blocked_missing_item_id": 1
    }
  },
  "excluded_executed_item_ids": [
    "202551129453",
    "206315990948"
  ],
  "recommended_next_safe_action": "No actionable Phase 14A candidate is ready. Start the next expansion from a fresh candidate cycle and keep executed items excluded."
}
```

Observed candidate rows:

```json
[
  {
    "classification": "blocked_already_executed",
    "request_id": 3,
    "opportunity_id": 13,
    "sku": "206315990948",
    "item_id": "206315990948",
    "blockers": [
      "item_previous_marketplace_execution_completed_event_exists",
      "listing_quality_low_signal_missing"
    ]
  },
  {
    "classification": "blocked_already_executed",
    "request_id": 2,
    "opportunity_id": 4,
    "sku": "202551129453",
    "item_id": "202551129453",
    "blockers": [
      "item_id_202551129453_excluded",
      "item_previous_marketplace_execution_completed_event_exists",
      "phase_12_source_opportunity_excluded",
      "listing_quality_low_signal_missing",
      "inventory_or_stock_signal_present"
    ]
  },
  {
    "classification": "blocked_already_executed",
    "request_id": 4,
    "opportunity_id": 13,
    "sku": "206315990948",
    "item_id": "206315990948",
    "blockers": [
      "request_executed_at_present",
      "request_execution_result_present",
      "item_previous_marketplace_execution_completed_event_exists",
      "request_previous_marketplace_execution_completed_event_exists",
      "listing_quality_low_signal_missing",
      "request_status_executed_not_selectable"
    ]
  },
  {
    "classification": "blocked_already_executed",
    "request_id": 1,
    "opportunity_id": 4,
    "sku": "202551129453",
    "item_id": "202551129453",
    "blockers": [
      "request_id_1_excluded",
      "request_executed_at_present",
      "request_execution_result_present",
      "item_id_202551129453_excluded",
      "item_previous_marketplace_execution_completed_event_exists",
      "request_previous_marketplace_execution_completed_event_exists",
      "phase_12_source_opportunity_excluded",
      "listing_quality_low_signal_missing",
      "inventory_or_stock_signal_present",
      "request_status_executed_not_selectable"
    ]
  },
  {
    "classification": "blocked_missing_item_id",
    "request_id": null,
    "opportunity_id": 6,
    "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
    "item_id": null,
    "blockers": [
      "valid_ebay_item_id_missing",
      "title_evidence_missing",
      "opportunity_status_archived_not_active"
    ]
  }
]
```

No candidate is currently actionable for packet, approval, execution request, or marketplace work.

## Phase 13 guard validation

Read-only readiness validation remains blocked after the Phase 13 live execution:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=15
```

Observed summary:

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
    "no_previous_marketplace_execution_event": false,
    "previous_marketplace_execution_event_count": 1,
    "payload_item_specifics_only": true
  },
  "safety": {
    "actual_ebay_call": false,
    "actual_network_call": false,
    "marketplace_write_performed": false,
    "revise_fixed_price_item_called": false,
    "live_execution_performed": false
  }
}
```

Execution event audit:

```json
{
  "request_id_4_execution_events_count": 1,
  "request_id_3_execution_events_count": 0
}
```

## Safety result

Planner safety object:

```json
{
  "read_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "actual_network_call": false,
  "actual_database_write": false,
  "database_write_performed": false,
  "marketplace_write_performed": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "ai_calls": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "title_changes": false,
  "description_changes": false
}
```

## Recommended next safe action

Start the next expansion from a fresh candidate cycle and keep executed items excluded.

Do not reuse:

- request id `4`
- packet id `3`
- approval id `15`
- item id `206315990948`, unless explicitly approved as rollback/correction
- item id `202551129453`, unless explicitly approved as rollback/correction

No Phase 14A output should be used to create a packet, approval, execution request, or marketplace write.
