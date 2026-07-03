# Hermes Phase 13Q — Promoted Packet Preview

## Scope

Phase 13Q adds a read-only packet preview for the Phase 13P-approved promoted borderline opportunity.

Baseline:

```text
60c260c Add Phase 13P promoted opportunity human gate
```

Phase 13Q does not redo Phase 13P. Promoted opportunity `id=13` already exists and has `human_review_status=approved_for_packet`.

## Starting state

- Promoted opportunity `id=13` exists.
- Source review id is `9`.
- Target item id is `206315990948`.
- `opportunity_type=listing_quality_improvement`.
- `source=phase_13_borderline_review_promotion`.
- `human_review_status=approved_for_packet`.
- `proposed_mutation_fields=["item_specifics"]`.
- `allowed_mutation_fields=["item_specifics"]`.
- `not_listing_quality_low=true`.
- `still_not_execution_candidate=true`.
- No packet, approval request, execution request, execution-state mutation, or marketplace write had occurred.

## Hard boundary

Phase 13Q builds a packet-shaped preview object only.

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

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-packet-preview --opportunity-id=13
```

This command is always read-only. It has no `--write` mode.

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Read-only helper added:

```js
buildEbayListingQualityPromotedPacketPreview({ opportunityId })
```

CLI added:

```text
ebay-listing-quality-promoted-packet-preview --opportunity-id=<OPPORTUNITY_ID>
```

The preview reads the Phase 13O/13P promoted opportunity, builds a packet-shaped object, loads cached internal listing evidence, builds a rollback snapshot from cached evidence, and returns safety gates. It does not insert a packet row.

## Packet-shaped preview contents

The preview includes:

- `opportunity_id=13`
- `source_review_id=9`
- `item_id=206315990948`
- `marketplace=ebay`
- `operation=listing_quality_update`
- `planned_mutation`
- `allowed_mutation_fields=["item_specifics"]`
- forbidden field check
- cached evidence snapshot
- rollback snapshot
- safety gates
- `packet_would_be_created=false`

## Planned mutation boundary

For opportunity `id=13`, planned mutation includes only `item_specifics`:

```json
{
  "item_specifics": {
    "required_human_review": true
  }
}
```

No title change is included because no explicit title mutation exists in the promoted opportunity.

No description change is included because no explicit description mutation exists in the promoted opportunity.

No forbidden mutation families are included:

- no price
- no quantity
- no inventory
- no stock
- no shipping
- no payment
- no returns
- no create/end/relist

## Preview validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-packet-preview --opportunity-id=13
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "preview_type": "promoted_borderline_packet_preview",
  "opportunity_id": 13,
  "source_review_id": 9,
  "item_id": "206315990948",
  "target_item_id": "206315990948",
  "human_review_status": "approved_for_packet",
  "packet_would_be_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "planned_mutation_fields": ["item_specifics"],
  "allowed_mutation_fields": ["item_specifics"],
  "blockers": []
}
```

Packet-shaped object summary:

```json
{
  "id": null,
  "request_id": null,
  "opportunity_id": 13,
  "source_review_id": 9,
  "status": "packet_preview_only",
  "confirmation_status": "not_created",
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "item_id": "206315990948",
  "planned_mutation": {
    "item_specifics": {
      "required_human_review": true
    }
  }
}
```

Forbidden field check:

```json
{
  "forbidden_fields_present": false,
  "forbidden_fields": [],
  "non_allowed_fields": [],
  "allowed_mutation_fields": ["item_specifics"],
  "payload_fields": ["item_specifics"],
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "shipping_changes": false,
  "payment_changes": false,
  "returns_changes": false,
  "listing_end_create_relist": false,
  "sku_remapping": false
}
```

Cached evidence snapshot summary:

```json
{
  "source": "cached_internal_data_only",
  "source_tables": [
    "ebay_products",
    "listing_details",
    "listing_item_specifics",
    "listing_images",
    "listing_policies"
  ],
  "item_id": "206315990948",
  "sku": "206315990948",
  "title": "Pokemon Store Korea Official Jeju Edition RANDOM Magnet",
  "description_present": true,
  "description_length": 885,
  "item_specifics_count": 3,
  "images_count": 2,
  "policies_present": true,
  "listing_status": "Active",
  "listing_status_active": true,
  "live_marketplace_state_fetched": false,
  "ebay_api_call_made": false
}
```

Rollback snapshot is available from cached internal evidence:

```json
{
  "title": "Pokemon Store Korea Official Jeju Edition RANDOM Magnet",
  "item_specifics": {
    "Brand": "Pokemon",
    "Country of Origin": "China",
    "Type": "Magnet"
  },
  "available": true,
  "source": "packet_internal_snapshots"
}
```

Safety gates:

```json
{
  "human_review_approved_for_packet": true,
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "packet_preview_only": true,
  "packet_would_be_created": false,
  "no_ebay_call": true,
  "no_get_item_call": true,
  "no_revise_fixed_price_item_call": true,
  "no_marketplace_write": true,
  "no_packet_created": true,
  "no_approval_created": true,
  "no_execution_request_created": true,
  "no_execution_state_change": true,
  "allowed_fields_only": true,
  "forbidden_fields_absent": true,
  "no_price_inventory_quantity_fields": true,
  "no_shipping_payment_returns_fields": true,
  "no_end_create_relist_fields": true
}
```

Verification counts:

```json
{
  "packet_count_before": 1,
  "packet_count_after": 1,
  "packet_created": false,
  "approval_request_count_before": 2,
  "approval_request_count_after": 2,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_updated": false
}
```

## Promoted opportunity detail validation

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-opportunity-detail --id=13
```

Observed summary remains unchanged and safe:

```json
{
  "read_only": true,
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

Building a promoted packet preview did not make the opportunity executable.

## Validation commands

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
npm run hermes:agent -- ebay-listing-quality-promoted-packet-preview --opportunity-id=13
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

The Phase 13Q service diff adds only:

- promoted opportunity read
- cached evidence read
- packet-shaped object construction
- rollback snapshot construction from cached evidence
- no eBay call
- no `GetItem` call
- no `ReviseFixedPriceItem` call
- no marketplace write path
- no DB write path
- no packet creation path
- no approval / execution request creation path
- no execution-state mutation path

Historical shared-service write helpers remain present from previous phases, but Phase 13Q does not invoke packet, approval, execution, or marketplace write helpers.

## Final Phase 13Q state

```json
{
  "promoted_opportunity_id": 13,
  "source_review_id": 9,
  "item_id": "206315990948",
  "human_review_status": "approved_for_packet",
  "planned_mutation_fields": ["item_specifics"],
  "allowed_mutation_fields": ["item_specifics"],
  "forbidden_fields_present": false,
  "packet_would_be_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "price_changes": false,
  "inventory_changes": false,
  "listing_changed": false,
  "selected_execution_candidate": null
}
```
