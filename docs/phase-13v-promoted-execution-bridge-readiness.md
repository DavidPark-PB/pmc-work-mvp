# Hermes Phase 13V — Promoted Execution Bridge Readiness

## Scope

Phase 13V creates the internal bridge from the approved Phase 13 promoted approval artifact into the existing Phase 12 execution pipeline shape.

Current committed baseline before this phase:

- Phase 13R: promoted packet artifact `opportunity_inbox.id=14` created internally
- Phase 13S: promoted packet artifact `id=14` confirmed
- Phase 13T: promoted approval artifact `opportunity_inbox.id=15` created
- Phase 13U: promoted approval artifact `id=15` approved
- target item id: `206315990948`
- planned mutation: `item_specifics` only
- no execution request existed before Phase 13V
- no eBay marketplace write occurred before Phase 13V

## Hard safety boundary

Phase 13V is bridge/readiness/runbook only.

It must not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call the live transport path
- perform a marketplace write
- change price
- change inventory
- change quantity
- change title
- change description
- change live listing content
- mark execution complete
- set `executed_at`
- set `execution_result`

The Phase 12I hard guard for `packet_id=1` remains intact. Phase 13V adds a dedicated promoted bridge/readiness path instead of weakening the Phase 12I single-packet guard.

## CLI

Create bridge dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-execution-bridge --approval-id=15 --dry-run
```

Create bridge write:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-execution-bridge --approval-id=15 --write
```

Readiness:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-readiness --approval-id=15
```

Runbook:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-live-runbook --approval-id=15
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
createEbayListingQualityPromotedExecutionBridge({ approvalId, dryRun, write })
buildEbayListingQualityPromotedLiveReadiness({ approvalId })
buildEbayListingQualityPromotedLiveRunbook({ approvalId })
```

## Internal records created

Write mode created internal bridge records only:

```json
{
  "request_id": 3,
  "legacy_packet_id": 2,
  "approval_artifact_id": 15,
  "packet_artifact_id": 14,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["item_specifics"]
}
```

The execution request is a Phase 12-compatible `hermes_execution_requests` row:

```json
{
  "id": 3,
  "opportunity_id": 13,
  "sku": "206315990948",
  "execution_type": "listing_quality_update",
  "status": "dry_run_ready",
  "final_approval_status": "approved",
  "final_approval_actor": "operator",
  "final_approval_policy_version": "phase-13v-promoted-execution-bridge-v1",
  "executed_at": null,
  "execution_result": null,
  "metadata": {
    "promoted_execution_bridge": true,
    "promoted_approval_artifact_id": 15,
    "promoted_packet_artifact_id": 14,
    "source_promoted_opportunity_id": 13,
    "source_review_id": 9,
    "target_item_id": "206315990948",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "external_action_executed": false,
    "marketplace_execution_approved": false,
    "marketplace_write_performed": false,
    "actual_ebay_call": false,
    "get_item_called": false,
    "revise_fixed_price_item_called": false,
    "live_transport_called": false
  }
}
```

The legacy-compatible Phase 12 packet is a `hermes_ebay_listing_quality_packets` row:

```json
{
  "id": 2,
  "request_id": 3,
  "item_id": "206315990948",
  "status": "packet_recorded",
  "confirmation_status": "confirmed",
  "planned_mutation_fields": ["item_specifics"],
  "safety_flags": {
    "promoted_execution_bridge": true,
    "promoted_approval_artifact_id": 15,
    "promoted_packet_artifact_id": 14,
    "no_ebay_call": true,
    "no_get_item_call": true,
    "no_revise_fixed_price_item_call": true,
    "no_live_transport_call": true,
    "no_marketplace_write": true,
    "price_changes": false,
    "inventory_changes": false,
    "quantity_changes": false,
    "title_changes": false,
    "description_changes": false,
    "listing_changed": false
  }
}
```

## Idempotency

The bridge lookup keys are stored on `hermes_execution_requests.metadata`:

```json
{
  "promoted_execution_bridge": true,
  "promoted_approval_artifact_id": 15
}
```

Repeated `--write` returns the same records:

```json
{
  "request_id": 3,
  "legacy_packet_id": 2,
  "created": false,
  "request_created": false,
  "legacy_packet_created": false,
  "idempotent_existing": true
}
```

No duplicate execution request or legacy-compatible listing quality packet was created.

## Validation gates

The bridge validates before writing:

- approval artifact exists
- approval artifact id is exactly `15`
- approval artifact status is `approved`
- `final_operator_approval=true`
- packet artifact id is exactly `14`
- target item id is exactly `206315990948`
- operation is `listing_quality_update`
- promoted packet artifact exists
- promoted packet is confirmed
- planned mutation fields are exactly `["item_specifics"]`
- forbidden price/inventory/quantity/stock/end/create/relist fields are absent
- no execution request id already exists on the promoted approval artifact
- no execution request id already exists on the promoted packet artifact
- no duplicate bridge execution requests exist
- no duplicate bridge legacy packets exist
- no prior marketplace execution event exists for the bridge request

## Validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
```

All passed.

Dry-run bridge command was unblocked:

```json
{
  "dry_run": true,
  "created": false,
  "blocked": false,
  "blockers": [],
  "verification": {
    "target_item_id_exact": true,
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "planned_mutation_item_specifics_only": true,
    "request_final_approval_status": "approved",
    "request_executed_at": null,
    "request_execution_result": null,
    "metadata_external_action_executed": false,
    "metadata_marketplace_execution_approved": false,
    "previous_marketplace_execution_event_count": 0
  }
}
```

Write bridge command created the bridge:

```json
{
  "created": true,
  "request_created": true,
  "legacy_packet_created": true,
  "request_id": 3,
  "legacy_packet_id": 2,
  "target_item_id_exact": true,
  "operation_valid": true,
  "planned_mutation_item_specifics_only": true,
  "request_final_approval_status_approved": true,
  "request_executed_at": null,
  "request_execution_result": null,
  "metadata_external_action_executed": false,
  "metadata_marketplace_execution_approved": false,
  "marketplace_execution_event_count_for_request": 0,
  "no_prior_marketplace_execution_event_for_new_request": true
}
```

Idempotent write rerun returned existing records:

```json
{
  "created": false,
  "request_created": false,
  "legacy_packet_created": false,
  "idempotent_existing": true,
  "request_id": 3,
  "legacy_packet_id": 2,
  "marketplace_execution_event_count_for_request": 0
}
```

Promoted live readiness:

```json
{
  "read_only": true,
  "approval_id": 15,
  "request_id": 3,
  "legacy_packet_id": 2,
  "target_item_id": "206315990948",
  "ready_for_promoted_live_path_review": true,
  "ready_for_live_execution": false,
  "phase_13v_does_not_execute_ebay": true,
  "blockers": [],
  "checks": {
    "bridge_request_exists": true,
    "legacy_packet_exists": true,
    "target_item_id_exact": true,
    "operation_listing_quality_update": true,
    "planned_mutation_fields": ["item_specifics"],
    "planned_mutation_item_specifics_only": true,
    "request_final_approval_status": "approved",
    "request_executed_at_is_null": true,
    "request_execution_result_is_null": true,
    "metadata_external_action_executed_false": true,
    "metadata_marketplace_execution_approved_false": true,
    "no_previous_marketplace_execution_event": true,
    "previous_marketplace_execution_event_count": 0,
    "payload_fields": ["ItemSpecifics"],
    "payload_item_specifics_only": true,
    "rollback_snapshot_exists": true,
    "live_transport_called": false
  },
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": true,
    "payload_fields": ["ItemSpecifics"],
    "forbidden_fields_present": false,
    "forbidden_fields": [],
    "non_allowed_fields": []
  }
}
```

Promoted live runbook is read-only and explicitly disallows live transport in Phase 13V.

Execution events for request id `3`:

```json
{
  "count": 0,
  "data": []
}
```

## Final Phase 13V state

```json
{
  "approval_artifact_id": 15,
  "approval_status": "approved",
  "packet_artifact_id": 14,
  "bridge_request_id": 3,
  "bridge_legacy_packet_id": 2,
  "target_item_id": "206315990948",
  "operation": "listing_quality_update",
  "planned_mutation_fields": ["item_specifics"],
  "request_final_approval_status": "approved",
  "request_executed_at": null,
  "request_execution_result": null,
  "metadata_external_action_executed": false,
  "metadata_marketplace_execution_approved": false,
  "marketplace_execution_event_count_for_request": 0,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "live_transport_called": false,
  "marketplace_write_performed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "title_changes": false,
  "description_changes": false,
  "ready_for_live_execution": false
}
```
