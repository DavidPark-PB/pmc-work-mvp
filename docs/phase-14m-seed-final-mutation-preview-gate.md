# Hermes Phase 14M — Seed Final Mutation Preview Gate

## Purpose

Phase 14M adds a read-only operator final mutation preview gate for the Phase 14 seed-promoted opportunity.

This phase exists because Phase 14L produced a packet-shaped preview whose planned mutation still contains placeholders:

```json
{
  "title": { "required_human_review": true },
  "description": { "required_human_review": true },
  "item_specifics": { "required_human_review": true }
}
```

Phase 14M must not create a packet from those placeholders.

Instead, it accepts only operator-supplied final values and builds a final packet-shaped preview only. It does not generate title, description, or item specifics.

## Target opportunity

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "source_type": "phase_14_seed_review_promotion",
  "human_review_status": "approved_for_packet"
}
```

Baseline:

```text
76fef08 Add Phase 14L seed promoted packet preview
```

Phase 14M does not redo Phase 14A through Phase 14L.

## CLI

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-preview --opportunity-id=36 --final-mutation-json='{}'
```

The command is read-only and has no write mode.

## Accepted final mutation JSON format

All fields are optional, but at least one allowed field must be present and non-placeholder:

```json
{
  "title": "Operator-supplied final title",
  "description": "Operator-supplied final description",
  "item_specifics": {
    "Brand": "Operator-supplied brand",
    "Type": "Operator-supplied type"
  }
}
```

Allowed fields:

- `title`
- `description`
- `item_specifics`

The command does not infer or generate values from the listing title. It returns:

```json
{
  "operator_supplied_json_only": true,
  "guesses_from_title": false
}
```

## Forbidden fields

The preview gate blocks unsupported or marketplace-sensitive fields, including:

- `price`
- `inventory`
- `quantity`
- `stock`
- `shipping`
- `payment`
- `returns`
- `category`
- `images`
- `sku`
- `item_id`
- `create`
- `end`
- `relist`

Forbidden fields are rejected before any final packet-shaped preview can be considered usable.

## Placeholder and internal-value blockers

Phase 14M blocks final mutation JSON containing:

- `required_human_review`
- `internal_review`
- `human_review`
- `placeholder`
- `todo`
- empty title
- empty description
- empty `item_specifics` object
- empty item-specific field names
- empty item-specific values
- boolean-only fake item specifics

Examples that must be blocked:

```json
{}
```

```json
{
  "title": {
    "required_human_review": true
  }
}
```

```json
{
  "price": 9.99
}
```

## Behavior

The command:

1. Loads `opportunity_id=36`.
2. Verifies `source_type=phase_14_seed_review_promotion`.
3. Verifies `human_review_status=approved_for_packet`.
4. Loads the Phase 14L packet preview.
5. Rejects placeholder/internal values.
6. Rejects empty final mutation JSON.
7. Rejects unsupported fields.
8. Rejects price/inventory/quantity/stock and other forbidden fields.
9. Builds a final packet-shaped preview only when unblocked.
10. Returns payload summary.
11. Returns rollback snapshot from cached evidence.
12. Performs no database writes.

## Output shape

The output includes:

```json
{
  "read_only": true,
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "blocked": true,
  "blockers": [],
  "final_mutation_preview": {},
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": false,
    "payload_fields": [],
    "forbidden_fields_present": false
  },
  "superseding_packet_required_for_write": true,
  "would_mutate_existing_packet": false,
  "actual_database_write": false,
  "actual_ebay_call": false,
  "marketplace_write_performed": false
}
```

For blocked inputs, `final_mutation_preview` is `{}` and no packet-shaped preview contains a usable mutation.

## Safety boundary

Phase 14M does not:

- write to the database
- call eBay
- call `GetItem`
- call `ReviseFixedPriceItem`
- call eBay write APIs
- write to marketplaces
- mutate listings
- change price
- change inventory
- change quantity
- create packets
- create approval requests
- create execution requests
- create live candidates
- call AI
- push commits

## Validation results

Required non-piped commands were run.

### Syntax checks

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Both exited `0` with no syntax output.

### Phase 14L packet preview still read-only

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promoted-packet-preview --opportunity-id=36
```

Observed summary:

```json
{
  "read_only": true,
  "dry_run": true,
  "preview_type": "seed_promoted_packet_preview",
  "opportunity_id": 36,
  "source_review_id": 19,
  "item_id": "206288370789",
  "human_review_status": "approved_for_packet",
  "packet_would_be_created": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "planned_mutation_fields": ["title", "description", "item_specifics"],
  "blockers": [],
  "verification": {
    "packet_count_before": 3,
    "packet_count_after": 3,
    "packet_created": false,
    "approval_request_count_before": 4,
    "approval_request_count_after": 4,
    "approval_created": false,
    "execution_request_count_before": 4,
    "execution_request_count_after": 4,
    "execution_request_created": false,
    "actual_database_write": false
  }
}
```

### Empty final mutation JSON is blocked

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-preview --opportunity-id=36 --final-mutation-json='{}'
```

Observed summary:

```json
{
  "read_only": true,
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "blocked": true,
  "blockers": [
    "operator_final_mutation_json_empty",
    "no_allowed_final_mutation_fields_present"
  ],
  "final_mutation_preview": {},
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": false,
    "payload_fields": [],
    "forbidden_fields_present": false
  },
  "superseding_packet_required_for_write": true,
  "would_mutate_existing_packet": false,
  "actual_database_write": false,
  "actual_ebay_call": false,
  "marketplace_write_performed": false,
  "verification": {
    "packet_count_before": 3,
    "packet_count_after": 3,
    "packet_created": false,
    "approval_request_count_before": 4,
    "approval_request_count_after": 4,
    "approval_created": false,
    "execution_request_count_before": 4,
    "execution_request_count_after": 4,
    "execution_request_created": false
  }
}
```

### Placeholder final mutation JSON is blocked

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-preview --opportunity-id=36 --final-mutation-json='{"title":{"required_human_review":true}}'
```

Observed summary:

```json
{
  "blocked": true,
  "blockers": [
    "placeholder_or_internal_value_present",
    "title_must_be_string",
    "no_valid_final_mutation_fields_after_audit"
  ],
  "final_mutation_preview": {},
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": false,
    "payload_fields": [],
    "forbidden_fields_present": false
  },
  "actual_database_write": false,
  "actual_ebay_call": false,
  "marketplace_write_performed": false
}
```

### Forbidden price field is blocked

```bash
npm run hermes:agent -- ebay-listing-quality-seed-final-mutation-preview --opportunity-id=36 --final-mutation-json='{"price":9.99}'
```

Observed summary:

```json
{
  "blocked": true,
  "blockers": [
    "forbidden_fields_present",
    "no_allowed_final_mutation_fields_present",
    "no_valid_final_mutation_fields_after_audit"
  ],
  "final_mutation_preview": {},
  "payload_summary": {
    "updates_title": false,
    "updates_description": false,
    "updates_item_specifics": false,
    "payload_fields": [],
    "forbidden_fields_present": true
  },
  "actual_database_write": false,
  "actual_ebay_call": false,
  "marketplace_write_performed": false
}
```

## Final Phase 14M state

```json
{
  "opportunity_id": 36,
  "source_review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "read_only": true,
  "operator_supplied_json_only": true,
  "guesses_from_title": false,
  "empty_json_blocked": true,
  "placeholder_json_blocked": true,
  "forbidden_price_field_blocked": true,
  "superseding_packet_required_for_write": true,
  "would_mutate_existing_packet": false,
  "packet_created": false,
  "approval_created": false,
  "execution_request_created": false,
  "live_candidate_created": false,
  "actual_database_write": false,
  "actual_ebay_call": false,
  "get_item_called": false,
  "revise_fixed_price_item_called": false,
  "ebay_write_api_called": false,
  "marketplace_write_performed": false
}
```

## Later phase requirement

A successful final packet creation is intentionally not part of Phase 14M.

A later explicit phase may create a superseding packet only from real operator-supplied final values. That future phase must not mutate an existing packet silently and must preserve the human approval boundary.
