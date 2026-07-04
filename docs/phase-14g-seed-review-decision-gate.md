# Phase 14G Seed Review Decision Gate

## Purpose

Phase 14G adds an internal decision gate for Phase 14F seed human-review inbox records.

The gate lets an operator inspect a Phase 14F review item and mark it as either:

- `shortlist`
- `reject`

This is still internal review state only. A shortlisted review is not a packet, approval, execution request, live candidate, or marketplace/listing mutation.

## Commands

List Phase 14F review records:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
```

Show one review detail:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=<REVIEW_ID>
```

Dry-run shortlist action:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=<REVIEW_ID> --action=shortlist --actor=operator --reason="selected for promotion eligibility review" --dry-run
```

Write shortlist action:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=<REVIEW_ID> --action=shortlist --actor=operator --reason="selected for promotion eligibility review" --write
```

Dry-run reject action:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=<REVIEW_ID> --action=reject --actor=operator --reason="not suitable for current controlled expansion" --dry-run
```

## Allowed actions

The action command supports only:

- `shortlist`
- `reject`

The target row must be a Phase 14F internal review record:

```text
opportunity_type = listing_quality_seed_review
source_type = phase_14e_seed_scoring_preview
```

Any other row type/source is ignored by the detail/action lookup and cannot be acted on through this command.

## Dry-run/write behavior

Dry-run is the default unless `--write` is explicitly supplied.

Dry-run:

- loads the existing Phase 14F review row;
- verifies it is not hard-excluded;
- previews the next metadata/status fields;
- writes nothing.

Write:

- updates only the existing internal review row;
- updates only `status`, `updated_at`, and `metadata`;
- creates no new rows in packet, approval, execution request, live candidate, marketplace, or listing mutation tables.

For `shortlist`, the review row remains `status=reviewing`, and metadata is updated with:

```json
{
  "review_status": "shortlisted",
  "review_action": "shortlist",
  "reviewed_by": "operator",
  "reviewed_at": "ISO8601",
  "review_reason": "selected for promotion eligibility review",
  "phase_14g_decision_gate": true,
  "still_not_execution_candidate": true,
  "not_live_candidate": true,
  "not_packet": true,
  "not_approval": true,
  "not_execution_request": true
}
```

For `reject`, the planned table status is `rejected`, and metadata uses:

```json
{
  "review_status": "rejected",
  "review_action": "reject"
}
```

## Hard exclusions

Phase 14G never allows an action on:

- `item_id=202551129453`
- `item_id=206315990948`
- any item already completed by `marketplace_execution_completed`
- `approval_id=15`
- `request_id=4`
- `packet_id=3`

The detail/action output includes hard-exclusion data for the selected row.

## Safety boundary

Phase 14G guarantees:

- no eBay live calls;
- no `GetItem` calls;
- no `ReviseFixedPriceItem` calls;
- no marketplace writes;
- no price/inventory/quantity changes;
- no title/description/item_specifics mutations;
- no packet creation;
- no approval creation;
- no execution request creation;
- no live candidate creation;
- no AI calls.

Structured safety flags include:

```json
{
  "marketplace_write_performed": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "ai_called": false
}
```

## Validation results

Non-piped validation commands were run.

Selected review id used during validation: `19`

Initial list command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
```

Observed:

- returned 20 review rows;
- top available review id was `19`;
- review `19` was `PMC-24141` / `206288370789` / score `100`.

Syntax checks:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Observed: both passed.

Detail command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=19
```

Observed:

- found=true;
- hard_exclusion.excluded=false;
- no database write;
- all marketplace/listing/AI safety flags false.

Shortlist dry-run:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=19 --action=shortlist --actor=operator --reason="selected for promotion eligibility review" --dry-run
```

Observed:

- planned `review_status=shortlisted`;
- planned `status=reviewing`;
- updated_review=null;
- execution request count remained 4;
- packet count remained 3;
- no approval, packet, execution request, live candidate, listing change, marketplace write, or AI call.

Shortlist write:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=19 --action=shortlist --actor=operator --reason="selected for promotion eligibility review" --write
```

Observed:

- updated existing review id `19` only;
- metadata now includes `review_status=shortlisted`, `review_action=shortlist`, `reviewed_by=operator`, `phase_14g_decision_gate=true`, `still_not_execution_candidate=true`, `not_live_candidate=true`, `not_packet=true`, `not_approval=true`, and `not_execution_request=true`;
- row status remained `reviewing`;
- packet count remained 3;
- execution request count remained 4;
- no approval, packet, execution request, live candidate, listing change, marketplace write, or AI call.

Post-write detail/list:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-detail --id=19
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
```

Observed:

- detail confirmed Phase 14G decision metadata on review id `19`;
- list still returned 20 review rows;
- review id `19` remained an internal review record, not an execution candidate.

Reject dry-run was also run for command coverage:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-action --id=19 --action=reject --actor=operator --reason="not suitable for current controlled expansion" --dry-run
```

Observed:

- planned `review_status=rejected` and `status=rejected`;
- wrote nothing;
- safety flags remained false for marketplace/listing/AI side effects.
