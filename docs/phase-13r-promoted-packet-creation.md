# Hermes Phase 13R — Promoted Packet Creation

## Scope

Phase 13R creates exactly one internal non-executable eBay `listing_quality_update` packet artifact for the Phase 13P-approved promoted opportunity.

Baseline:

```text
d55208b Add Phase 13Q promoted packet preview
```

Phase 13R does not redo Phase 13Q. Promoted opportunity `id=13` already has `human_review_status=approved_for_packet`, and Phase 13Q already proved the packet preview is safe.

## Starting state

- Promoted opportunity `id=13` exists.
- Source review id is `9`.
- Target item id is `206315990948`.
- `human_review_status=approved_for_packet`.
- Phase 13Q packet preview is safe.
- Planned mutation is `item_specifics` only.
- No packet for promoted opportunity `id=13` existed before the Phase 13R write.
- No approval request, execution request, execution-state mutation, or marketplace write had occurred for promoted opportunity `id=13`.

## Hard boundary

Phase 13R may create one internal packet artifact only when explicitly run with `--write`.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- create approval requests
- create execution requests
- update execution state
- mark marketplace execution
- modify marketplace listings
- change price, inventory, quantity, or listing content
- push commits

## Storage note

The existing legacy table `hermes_ebay_listing_quality_packets` is request-bound via non-null `request_id`. Phase 13R must not create an approval/execution request, so the promoted packet is recorded as a dedicated internal `opportunity_inbox` artifact with:

```text
opportunity_type=listing_quality_update_packet
source_type=phase_13r_promoted_packet_creation
status=packet_recorded
metadata.source_promoted_opportunity_id=13
```

The packet payload itself is stored in `metadata.packet`. It intentionally has `request_id=null`, `approval_request_id=null`, and `execution_request_id=null`.

## CLI

Dry-run, default behavior:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --dry-run
```

Write mode:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --write
```

Detail:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --opportunity-id=13
```

Default is dry-run unless `--write` is supplied.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
createEbayListingQualityPromotedPacket({ opportunityId, dryRun, write })
getEbayListingQualityPromotedPacketDetail({ opportunityId, packetId })
```

Added CLI commands:

```text
ebay-listing-quality-create-promoted-packet --opportunity-id=<OPPORTUNITY_ID> [--dry-run|--write]
ebay-listing-quality-promoted-packet-detail --opportunity-id=<OPPORTUNITY_ID>
```

## Packet artifact contents

The created packet artifact includes:

- `opportunity_id=13`
- `source_review_id=9`
- `target_item_id=206315990948`
- `marketplace=ebay`
- `operation=listing_quality_update`
- `planned_mutation` containing `item_specifics` only
- cached evidence snapshot
- rollback snapshot
- `packet_hash`
- `status=packet_recorded`
- `confirmation_status=not_confirmed`
- `not_execution_candidate=true`
- `request_id=null`
- `approval_request_id=null`
- `execution_request_id=null`

## Dry-run validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "opportunity_id": 13,
  "created": false,
  "idempotent_existing": false,
  "blocked": false,
  "blockers": [],
  "packet_preview": {
    "opportunity_id": 13,
    "source_review_id": 9,
    "target_item_id": "206315990948",
    "marketplace": "ebay",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "packet_hash": "sha256:b7dccb6a259a576b63c43705e667b316b0397485e7cd5da843b9d9dcba5ff6c3",
    "status": "packet_recorded",
    "confirmation_status": "not_confirmed",
    "not_execution_candidate": true
  },
  "verification": {
    "packet_count_for_opportunity_before": 0,
    "packet_count_for_opportunity_after": 0,
    "planned_mutation_item_specifics_only": true,
    "approval_request_count_for_opportunity_before": 0,
    "approval_request_count_for_opportunity_after": 0,
    "execution_request_count_for_opportunity_before": 0,
    "execution_request_count_for_opportunity_after": 0,
    "legacy_packet_count_before": 1,
    "legacy_packet_count_after": 1
  }
}
```

Dry-run safety confirmed `actual_database_write=false`.

## Write validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --write
```

Observed summary:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "opportunity_id": 13,
  "created": true,
  "idempotent_existing": false,
  "blocked": false,
  "blockers": [],
  "packet": {
    "id": 14,
    "opportunity_type": "listing_quality_update_packet",
    "source_type": "phase_13r_promoted_packet_creation",
    "status": "packet_recorded",
    "opportunity_id": 13,
    "source_review_id": 9,
    "target_item_id": "206315990948",
    "marketplace": "ebay",
    "operation": "listing_quality_update",
    "planned_mutation_fields": ["item_specifics"],
    "packet_hash": "sha256:b7dccb6a259a576b63c43705e667b316b0397485e7cd5da843b9d9dcba5ff6c3",
    "confirmation_status": "not_confirmed",
    "not_execution_candidate": true,
    "request_id": null,
    "approval_request_id": null,
    "execution_request_id": null
  },
  "verification": {
    "packet_count_for_opportunity_before": 0,
    "packet_count_for_opportunity_after": 1,
    "exactly_one_packet_for_opportunity": true,
    "planned_mutation_item_specifics_only": true,
    "packet_hash_present": true,
    "confirmation_status": "not_confirmed",
    "not_execution_candidate": true,
    "approval_request_count_for_opportunity_before": 0,
    "approval_request_count_for_opportunity_after": 0,
    "approval_request_created": false,
    "no_approval_request_for_new_packet": true,
    "execution_request_count_for_opportunity_before": 0,
    "execution_request_count_for_opportunity_after": 0,
    "execution_request_created": false,
    "no_execution_request_for_new_packet": true,
    "legacy_packet_count_before": 1,
    "legacy_packet_count_after": 1
  }
}
```

Write safety output confirmed:

```json
{
  "cached_evidence_only": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "actual_network_call": false,
  "actual_database_write": true,
  "database_write_scope": "opportunity_inbox internal promoted packet artifact only",
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "normal_opportunity_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "listing_changed": false
}
```

## Idempotency validation

Command repeated:

```bash
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --write
```

Observed summary:

```json
{
  "created": false,
  "idempotent_existing": true,
  "packet": {
    "id": 14,
    "opportunity_id": 13,
    "packet_status": "packet_recorded",
    "confirmation_status": "not_confirmed",
    "planned_mutation_fields": ["item_specifics"],
    "request_id": null,
    "approval_request_id": null,
    "execution_request_id": null
  },
  "verification": {
    "packet_count_for_opportunity_before": 1,
    "packet_count_for_opportunity_after": 1,
    "exactly_one_packet_for_opportunity": true,
    "planned_mutation_item_specifics_only": true,
    "approval_request_count_for_opportunity_before": 0,
    "approval_request_count_for_opportunity_after": 0,
    "approval_request_created": false,
    "execution_request_count_for_opportunity_before": 0,
    "execution_request_count_for_opportunity_after": 0,
    "execution_request_created": false,
    "legacy_packet_count_before": 1,
    "legacy_packet_count_after": 1
  }
}
```

The repeat write returned existing packet artifact `id=14` and did not create a duplicate.

## Detail validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --opportunity-id=13
```

Observed summary:

```json
{
  "read_only": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "opportunity_id": 13,
  "packet_id": 14,
  "found": true,
  "count": 1,
  "verification": {
    "exactly_one_packet_for_opportunity": true,
    "planned_mutation_fields": ["item_specifics"],
    "planned_mutation_item_specifics_only": true,
    "confirmation_status": "not_confirmed",
    "not_execution_candidate": true,
    "approval_request_id": null,
    "execution_request_id": null
  }
}
```

## Direct database verification

A direct read confirmed:

```json
{
  "packet_count_for_opportunity_13": 1,
  "packet_ids": [14],
  "status": "packet_recorded",
  "packet_status": "packet_recorded",
  "confirmation_status": "not_confirmed",
  "planned_mutation_fields": ["item_specifics"],
  "planned_mutation_item_specifics_only": true,
  "request_id": null,
  "approval_request_id": null,
  "execution_request_id": null,
  "execution_requests_for_opportunity_13": 0,
  "execution_requests": []
}
```

## Next-candidate selector validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed result remains safe:

```json
{
  "scanned": {
    "opportunity_count": 14,
    "completed_marketplace_item_ids": ["202551129453"]
  },
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

Creating the promoted packet did not make it executable.

## Validation commands

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --dry-run
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --write
npm run hermes:agent -- ebay-listing-quality-create-promoted-packet --opportunity-id=13 --write
npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --opportunity-id=13
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
git diff --stat
```

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- approval request creation
- execution request creation
- execution-state mutation
- marketplace execution event marking

The Phase 13R service diff adds only:

- promoted packet dry-run construction
- one guarded `.insert()` into `opportunity_inbox` for an internal packet artifact
- idempotent lookup before insert
- packet detail read
- no eBay call
- no `GetItem` call
- no `ReviseFixedPriceItem` call
- no marketplace write path
- no approval request creation path
- no execution request creation path
- no execution-state mutation path

Historical shared-service write helpers remain present from previous phases, but Phase 13R does not invoke approval, execution request, execution-state, or marketplace write helpers.

## Final Phase 13R state

```json
{
  "promoted_opportunity_id": 13,
  "promoted_packet_artifact_id": 14,
  "source_review_id": 9,
  "target_item_id": "206315990948",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "packet_status": "packet_recorded",
  "confirmation_status": "not_confirmed",
  "packet_hash": "sha256:b7dccb6a259a576b63c43705e667b316b0397485e7cd5da843b9d9dcba5ff6c3",
  "planned_mutation_fields": ["item_specifics"],
  "planned_mutation_item_specifics_only": true,
  "request_id": null,
  "approval_request_id": null,
  "execution_request_id": null,
  "execution_requests_for_opportunity_13": 0,
  "exactly_one_packet_for_opportunity": true,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "marketplace_write_performed": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "listing_changed": false,
  "selected_execution_candidate": null
}
```
