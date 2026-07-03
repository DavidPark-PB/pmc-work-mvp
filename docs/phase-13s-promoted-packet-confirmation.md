# Hermes Phase 13S — Promoted Packet Confirmation

## Scope

Phase 13S implements an operator confirmation gate for the Phase 13R promoted packet artifact.

Baseline:

```text
d68c8a9 Add Phase 13R promoted packet creation
```

Phase 13S does not redo Phase 13R. The existing promoted packet artifact remains the source object:

- packet artifact id: `14`
- source opportunity id: `13`
- source review id: `9`
- target item id: `206315990948`
- source type: `phase_13r_promoted_packet_creation`
- status before confirmation: `packet_recorded`
- confirmation status before confirmation: `not_confirmed`
- planned mutation: `item_specifics` only
- not execution candidate: `true`

## Hard boundary

Phase 13S records internal operator confirmation metadata only.

It does not:

- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call marketplace write APIs
- create an approval request
- create an execution request
- update execution state
- execute marketplace actions
- modify price, inventory, quantity, shipping, payment, returns, title, description, or live listing content
- push commits

## CLI

Detail by packet artifact id:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --packet-id=14
```

The existing opportunity-id detail remains available:

```bash
npm run hermes:agent -- ebay-listing-quality-promoted-packet-detail --opportunity-id=13
```

Confirmation dry-run, which is the default behavior unless `--write` is provided:

```bash
npm run hermes:agent -- ebay-listing-quality-confirm-promoted-packet --packet-id=14 --actor=operator --reason="confirmed item_specifics packet" --dry-run
```

Confirmation write:

```bash
npm run hermes:agent -- ebay-listing-quality-confirm-promoted-packet --packet-id=14 --actor=operator --reason="confirmed item_specifics packet" --write
```

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service helper:

```js
confirmEbayListingQualityPromotedPacket({ packetId, actor, reason, dryRun, write })
```

The write updates only the internal `opportunity_inbox` promoted packet artifact row metadata/status scope. The row remains `status=packet_recorded` and remains non-executable.

## Validation gates before write

The confirmation helper validates:

- packet artifact exists
- `opportunity_type=listing_quality_update_packet`
- `source_type=phase_13r_promoted_packet_creation`
- row `status=packet_recorded`
- current `confirmation_status=not_confirmed`
- planned mutation fields are exactly `["item_specifics"]`
- no forbidden price/inventory/quantity/stock/end/create/relist mutation fields exist
- target item id is exactly `206315990948`
- packet has no `request_id`
- packet has no `approval_request_id`
- packet has no `execution_request_id`
- no approval/execution request exists for source opportunity id `13`
- actor and reason are present for write mode

## Write fields

The write records:

```json
{
  "confirmation_status": "confirmed",
  "confirmed_by_actor": "operator",
  "confirmation_reason": "confirmed item_specifics packet",
  "confirmed_at": "ISO8601",
  "confirmation_snapshot": {},
  "still_not_execution_candidate": true,
  "not_execution_candidate": true
}
```

The confirmation snapshot includes packet identity, source opportunity/review, target item, planned mutation hash, rollback snapshot hash, request counts, and explicit safety flags confirming no marketplace/API/write execution path.

## Observed validation results

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both passed.

Detail before write showed packet id `14` with:

```json
{
  "confirmation_status": "not_confirmed",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "approval_request_id": null,
  "execution_request_id": null
}
```

Dry-run confirmation was unblocked:

```json
{
  "dry_run": true,
  "updated": false,
  "blocked": false,
  "blockers": [],
  "target_item_id_valid": true,
  "planned_mutation_item_specifics_only": true,
  "forbidden_fields_absent": true,
  "approval_request_count_for_source_opportunity_before": 0,
  "approval_request_count_for_source_opportunity_after": 0,
  "execution_request_count_for_source_opportunity_before": 0,
  "execution_request_count_for_source_opportunity_after": 0
}
```

Write confirmation completed:

```json
{
  "dry_run": false,
  "updated": true,
  "packet_id": 14,
  "confirmation_status": "confirmed",
  "confirmed_by_actor": "operator",
  "confirmation_reason": "confirmed item_specifics packet",
  "still_not_execution_candidate": true,
  "not_execution_candidate": true,
  "planned_mutation_fields": ["item_specifics"],
  "planned_mutation_item_specifics_only": true,
  "approval_request_count_for_source_opportunity_before": 0,
  "approval_request_count_for_source_opportunity_after": 0,
  "approval_request_created": false,
  "execution_request_count_for_source_opportunity_before": 0,
  "execution_request_count_for_source_opportunity_after": 0,
  "execution_request_created": false,
  "execution_state_updated": false
}
```

Detail after write showed packet id `14` with:

```json
{
  "confirmation_status": "confirmed",
  "confirmed_by_actor": "operator",
  "confirmation_reason": "confirmed item_specifics packet",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "approval_request_id": null,
  "execution_request_id": null
}
```

Next-candidate selector remains safe:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed:

```json
{
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists.",
  "safety": {
    "read_only": true,
    "actual_ebay_call": false,
    "get_item_called": false,
    "actual_network_call": false,
    "actual_database_write": false,
    "marketplace_write_performed": false,
    "revise_fixed_price_item_called": false,
    "packet_created": false,
    "approval_created": false,
    "execution_state_changed": false,
    "price_changes": false,
    "inventory_changes": false
  }
}
```

## Final Phase 13S state

```json
{
  "packet_artifact_id": 14,
  "source_opportunity_id": 13,
  "source_review_id": 9,
  "target_item_id": "206315990948",
  "source_type": "phase_13r_promoted_packet_creation",
  "status": "packet_recorded",
  "confirmation_status": "confirmed",
  "confirmed_by_actor": "operator",
  "confirmation_reason": "confirmed item_specifics packet",
  "planned_mutation_fields": ["item_specifics"],
  "not_execution_candidate": true,
  "still_not_execution_candidate": true,
  "approval_request_created": false,
  "execution_request_created": false,
  "execution_state_changed": false,
  "marketplace_write_performed": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "selected_execution_candidate": null
}
```
