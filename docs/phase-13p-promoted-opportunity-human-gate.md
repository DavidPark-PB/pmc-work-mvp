# Hermes Phase 13P — Promoted Opportunity Human Gate

## Scope

Phase 13P adds a human approval gate for the Phase 13O promoted borderline opportunity.

Baseline:

```text
8b28ee6 Add Phase 13O borderline review promotion
```

Phase 13P does not redo Phase 13O. Promoted opportunity `id=13` already exists.

## Starting state

- Promoted opportunity `id=13` exists.
- Source review id is `9`.
- Target item id is `206315990948`.
- `opportunity_type=listing_quality_improvement`.
- `source=phase_13_borderline_review_promotion`.
- `proposed_mutation_fields=["item_specifics"]`.
- `not_listing_quality_low=true`.
- `requires_human_approval=true`.
- `not_execution_candidate=true`.
- No packet, approval request, execution request, execution-state mutation, or marketplace write had occurred.

## Hard boundary

Phase 13P may only update internal opportunity metadata/status for the promoted opportunity when explicitly run with `--write`.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- create packets
- create approval requests
- create execution requests
- update execution state
- mark marketplace execution
- modify marketplace listings
- change price, inventory, quantity, or listing content
- push commits

## CLI

List promoted opportunities:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunities --limit=20
```

Show promoted opportunity detail:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=13
```

Dry-run human decision:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=13 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --dry-run
```

Write human decision:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=13 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --write
```

Supported actions:

- `approve_for_packet`
- `reject`

Default is dry-run unless `--write` is supplied.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helpers:

```js
listEbayListingQualityPromotedOpportunities({ limit })
getEbayListingQualityPromotedOpportunityDetail({ id })
actOnEbayListingQualityPromotedOpportunity({ id, action, actor, reason, dryRun, write })
```

The action helper validates the target row is a Phase 13O promoted opportunity:

```text
opportunity_type = listing_quality_improvement
source_type = phase_13_borderline_review_promotion
```

In write mode it updates only the existing `opportunity_inbox` row with metadata such as:

```json
{
  "human_review_status": "approved_for_packet",
  "reviewed_by": "operator",
  "reviewed_at": "ISO8601",
  "review_reason": "approved for packet preview",
  "review_action": "approve_for_packet",
  "still_not_execution_candidate": true,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "phase_13p_human_gate": true
}
```

For `approve_for_packet`, table `status` remains `reviewing`. For `reject`, table `status` becomes `rejected`.

## List validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunities --limit=20
```

Observed summary:

```json
{
  "read_only": true,
  "operation": "listing_quality_promoted_opportunity_list",
  "limit": 20,
  "count": 1,
  "promoted_opportunities": [
    {
      "id": 13,
      "opportunity_type": "listing_quality_improvement",
      "source": "phase_13_borderline_review_promotion",
      "status": "reviewing",
      "item_id": "206315990948",
      "sku": "206315990948",
      "source_review_id": 9,
      "not_listing_quality_low": true,
      "requires_human_approval": true,
      "not_execution_candidate": true,
      "proposed_mutation_fields": ["item_specifics"],
      "allowed_mutation_fields": ["item_specifics"]
    }
  ]
}
```

Safety output confirmed no eBay call, no DB write, no packet, no approval, no execution request, and no execution-state mutation.

## Detail validation before write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=13
```

Observed summary before write:

```json
{
  "read_only": true,
  "operation": "listing_quality_promoted_opportunity_detail",
  "id": 13,
  "found": true,
  "promoted_opportunity": {
    "id": 13,
    "opportunity_type": "listing_quality_improvement",
    "source": "phase_13_borderline_review_promotion",
    "status": "reviewing",
    "item_id": "206315990948",
    "source_review_id": 9,
    "not_listing_quality_low": true,
    "requires_human_approval": true,
    "not_execution_candidate": true,
    "proposed_mutation_fields": ["item_specifics"],
    "allowed_mutation_fields": ["item_specifics"]
  }
}
```

## Dry-run approval validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=13 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --dry-run
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "write_requested": false,
  "operation": "listing_quality_promoted_opportunity_action",
  "id": 13,
  "action": "approve_for_packet",
  "planned_decision": {
    "human_review_status": "approved_for_packet",
    "status": "reviewing",
    "reviewed_by": "operator",
    "review_reason": "approved for packet preview",
    "still_not_execution_candidate": true,
    "packet_created": false
  },
  "updated_promoted_opportunity": null,
  "verification": {
    "human_review_status": "approved_for_packet",
    "approved_for_packet": true,
    "still_not_execution_candidate": true,
    "packet_created_flag": false,
    "packet_count_before": 1,
    "packet_count_after": 1,
    "packet_created": false,
    "approval_request_count_before": 2,
    "approval_request_count_after": 2,
    "approval_created": false,
    "execution_request_count_before": 2,
    "execution_request_count_after": 2,
    "execution_request_created": false,
    "execution_state_updated": false
  }
}
```

Dry-run safety confirmed `actual_database_write=false`.

## Write approval validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=13 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --write
```

Observed summary:

```json
{
  "read_only": false,
  "dry_run": false,
  "write_requested": true,
  "operation": "listing_quality_promoted_opportunity_action",
  "id": 13,
  "action": "approve_for_packet",
  "updated_promoted_opportunity": {
    "id": 13,
    "status": "reviewing",
    "human_review_status": "approved_for_packet",
    "reviewed_by": "operator",
    "review_reason": "approved for packet preview",
    "still_not_execution_candidate": true,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false
  },
  "verification": {
    "human_review_status": "approved_for_packet",
    "approved_for_packet": true,
    "still_not_execution_candidate": true,
    "packet_created_flag": false,
    "packet_count_before": 1,
    "packet_count_after": 1,
    "packet_created": false,
    "approval_request_count_before": 2,
    "approval_request_count_after": 2,
    "approval_created": false,
    "execution_request_count_before": 2,
    "execution_request_count_after": 2,
    "execution_request_created": false,
    "execution_state_updated": false
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
  "database_write_scope": "opportunity_inbox promoted opportunity metadata/status only",
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "normal_opportunity_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "listing_changed": false
}
```

The only write was an internal metadata/status update on the existing promoted opportunity row.

## Detail validation after write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=13
```

Observed summary after write:

```json
{
  "read_only": true,
  "operation": "listing_quality_promoted_opportunity_detail",
  "id": 13,
  "found": true,
  "promoted_opportunity": {
    "id": 13,
    "status": "reviewing",
    "human_review_status": "approved_for_packet",
    "reviewed_by": "operator",
    "review_reason": "approved for packet preview",
    "still_not_execution_candidate": true,
    "packet_created": false,
    "approval_created": false,
    "execution_request_created": false,
    "not_execution_candidate": true,
    "not_listing_quality_low": true,
    "requires_human_approval": true
  }
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
    "opportunity_count": 13,
    "completed_marketplace_item_ids": ["202551129453"]
  },
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

Approving the promoted opportunity for a future packet preview did not make it executable.

## Validation commands

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-promoted-opportunities --limit=20
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=13
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=13 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --dry-run
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-action --id=13 --action=approve_for_packet --actor=operator --reason="approved for packet preview" --write
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=13
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
git diff --stat
```

## Safety grep

Safety grep was run on changed files and diff-only additions for:

- eBay calls / `GetItem`
- marketplace write APIs
- `ReviseFixedPriceItem`
- packet creation
- approval creation
- execution request creation
- execution-state mutation

The Phase 13P service diff adds only:

- promoted opportunity list/detail reads
- one guarded `.update()` on `opportunity_inbox` for metadata/status
- no eBay call
- no `GetItem` call
- no `ReviseFixedPriceItem` call
- no marketplace write path
- no packet creation path
- no approval / execution request creation path
- no execution-state mutation path

Historical shared-service write helpers remain present from previous phases, but Phase 13P does not invoke packet, approval, execution, or marketplace write helpers.

## Final Phase 13P state

```json
{
  "promoted_opportunity_id": 13,
  "source_review_id": 9,
  "item_id": "206315990948",
  "human_review_status": "approved_for_packet",
  "reviewed_by": "operator",
  "review_reason": "approved for packet preview",
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "not_listing_quality_low": true,
  "requires_human_approval": true,
  "proposed_mutation_fields": ["item_specifics"],
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "price_changes": false,
  "inventory_changes": false,
  "listing_changed": false,
  "selected_execution_candidate": null
}
```
