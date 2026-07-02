# Hermes Phase 13A — Controlled Expansion Candidate Selector

Report timestamp: 2026-07-02T22:47:10Z

## Scope

Phase 13A implements a read-only selector for the next possible eBay `listing_quality_update` candidate after the completed Phase 12 single-SKU live execution.

Baseline:

```text
779d0b5 Add Phase 12 final closeout
```

Phase 13A does not redo Phase 12 and does not execute any marketplace write.

## Hard boundary

Phase 13A is selector-only.

It does not:

- call eBay
- call `ReviseFixedPriceItem`
- use network
- write DB rows
- create packets
- create approvals
- change execution state
- modify eBay listings
- change price
- change inventory/quantity
- push commits

## Implementation

Updated:

```text
src/services/hermesExecutionApproval.js
scripts/hermes-agent.js
```

Added service:

```js
selectNextEbayListingQualityCandidate({ limit })
```

Added CLI:

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

The selector reads existing internal data only:

- `hermes_execution_requests`
- `opportunity_inbox`
- `hermes_execution_events`
- cached eBay listing evidence through existing read-only cache helpers

It does not use marketplace APIs and does not create packet/approval records.

## Selection policy

Hard exclusions:

- `packet_id=1`
- `request_id=1`
- `item_id=202551129453`
- any request with `executed_at` present
- any request with `execution_result` present
- any item with prior `marketplace_execution_completed` event

Preferred candidate traits:

- `listing_quality_low` signal
- listing quality recommendation
- title-only deterministic mutation preview
- no price changes
- no inventory/quantity changes
- valid cached eBay item id/listing id
- enough cached evidence to build a safe packet preview
- low rollback risk

## Output shape

The selector returns:

- ranked candidates
- SKU
- item id / listing id
- signal summary
- proposed mutation fields
- forbidden field check
- evidence summary
- risk level
- reason selected or reason not selected
- recommended next action
- safety object proving read-only behavior

## Validation command

```bash
npm run hermes:agent -- ebay-listing-quality-next-candidate --limit=10
```

Observed summary:

```json
{
  "read_only": true,
  "marketplace": "ebay",
  "operation": "listing_quality_update",
  "limit": 10,
  "scanned": {
    "request_count": 2,
    "opportunity_count": 6,
    "source_count": 2,
    "marketplace_execution_event_count": 1,
    "completed_marketplace_item_ids": [
      "202551129453"
    ]
  },
  "ranked_candidates": [],
  "selected_candidate": null,
  "recommended_next_action": "No selectable next eBay listing_quality_update candidate found. Do not create a packet or approval until an active listing_quality_low opportunity with valid cached eBay item evidence exists."
}
```

This is the correct safe result for the current database state. There is no selectable next candidate yet.

## Blocked / excluded candidates observed

### Archived listing-quality fixture

The selector found the historical Phase 3 fixture opportunity:

```json
{
  "source_type": "opportunity",
  "opportunity_id": 6,
  "opportunity_status": "archived",
  "sku": "PHASE3B-LISTING-QUALITY-FIXTURE",
  "signals": [
    "listing_quality_low"
  ],
  "item_id": null,
  "candidate_blockers": [
    "valid_ebay_item_id_missing",
    "title_evidence_missing",
    "opportunity_status_archived_not_active"
  ]
}
```

It was not selected because it is archived and lacks cached eBay item/title evidence.

### Phase 12 source request / item

The selector also saw request `2` derived from the same Phase 12 source opportunity/SKU:

```json
{
  "source_type": "request",
  "request_id": 2,
  "opportunity_id": 4,
  "sku": "202551129453",
  "item_id": "202551129453",
  "signals": [
    "dead_stock",
    "no_recent_sales"
  ],
  "exclusion_blockers": [
    "item_id_202551129453_excluded",
    "item_previous_marketplace_execution_completed_event_exists",
    "phase_12_source_opportunity_excluded"
  ],
  "candidate_blockers": [
    "listing_quality_low_signal_missing",
    "inventory_or_stock_signal_present"
  ]
}
```

It was not selected because the item was already executed in Phase 12 and is explicitly excluded. It also lacks `listing_quality_low` and is tied to dead-stock/no-recent-sales signals rather than listing-quality-only expansion.

## Current selector result

```json
{
  "selected_candidate": null,
  "ranked_candidates": [],
  "phase_12_item_excluded": true,
  "no_packet_created": true,
  "no_approval_created": true,
  "no_marketplace_write": true
}
```

## Read-only Phase 12 guard validation

Command:

```bash
npm run hermes:agent -- execution-detail --id=1
```

Observed state remains:

- request `1` status is `executed`
- `executed_at` is present
- `execution_result` is present
- packet `1` remains associated with item `202551129453`
- execution result remains `Ack=Warning`, `success=true`, errors `0`
- marketplace execution event `id=11` remains the single completed execution event
- title-only remains true
- price changes remain false
- inventory changes remain false

This command is read-only.

## Syntax validation

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
```

All syntax checks passed.

## Safety validation

Phase 13A added no marketplace write path.

The new selector path only uses read-only `select` queries and existing cache-only evidence helpers.

Safety result from selector output:

```json
{
  "read_only": true,
  "actual_ebay_call": false,
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
```

Safety grep confirmed:

- no new eBay write command was added
- no new `ReviseFixedPriceItem` runtime call was added
- no new DB mutation path was added for the selector
- no packet creation path is used
- no approval creation path is used
- no execution state update is used
- no marketplace write occurred

Expected benign matches in the repository include historical Phase 12 live-transport code and documentation references to `ReviseFixedPriceItem`; those are not part of Phase 13A selector execution.

## Remaining gap before next execution candidate

There is currently no active next candidate that satisfies Phase 13A criteria.

Before any Phase 13B/next packet work, create or identify a fresh active candidate with:

- `listing_quality_low` signal
- valid cached eBay item id/listing id
- cached current title evidence
- title-only deterministic improvement proposal
- no price/inventory/quantity signals
- low rollback risk
- not tied to `packet_id=1`, `request_id=1`, or item `202551129453`
- no prior marketplace execution event for that item

## Recommended next action

Do not create a packet or approval yet.

Recommended next step is read-only candidate generation/enrichment for listing quality opportunities until an active candidate appears with valid cached eBay item/title evidence. Only after that should a later phase build a new operator packet preview, still without executing marketplace writes.

## Final state

Phase 13A completed the controlled expansion selector.

Final state:

- Phase 12 remains closed
- `packet_id=1` was not reused
- `request_id=1` was not reused
- `item_id=202551129453` was excluded
- no selectable new candidate exists in the current data
- no packet was created
- no approval was created
- no DB mutation occurred
- no eBay write occurred
- no push was performed
