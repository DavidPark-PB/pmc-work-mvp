# Phase 14I Seed Evidence Completion

## Purpose

Phase 14I completes missing cached rollback/review evidence for the shortlisted Phase 14 seed review selected in Phase 14G and checked in Phase 14H.

Target:

```text
review_id=19
sku=PMC-24141
item_id=206288370789
score=100
```

Phase 14H found the review was not promotion-eligible because cached description evidence was missing:

```json
{
  "eligible_for_promotion": false,
  "blockers": ["insufficient_cached_evidence_for_rollback_review"],
  "warnings": ["source_review_evidence_gap:cached_description"],
  "allowed_mutation_fields": ["description", "item_specifics", "title"]
}
```

## Commands

Dry-run fetch, with no database write:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-evidence-complete --id=19 --dry-run
```

Write mode, explicitly requested, upserts only internal evidence-cache rows:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-evidence-complete --id=19 --write
```

After write, re-run Phase 14H:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=19
npm run hermes:agent -- ebay-listing-quality-seed-promotion-candidates --limit=20
```

## Read-only GetItem boundary

Phase 14I may call only read-only eBay Trading API `GetItem` through the existing `src/api/ebayAPI.js` `callTradingAPI` path.

It does not create new auth logic and does not create a new eBay API client implementation.

The command verifies before fetching:

- the review exists;
- `metadata.review_status = shortlisted`;
- the target item is exactly `206288370789`;
- the Phase 14G/14H hard exclusion check returns `excluded=false`;
- the Phase 14H blockers include `insufficient_cached_evidence_for_rollback_review`.

If these prerequisites fail, the command returns blockers before calling `GetItem`.

## Cache tables written

`--write` may upsert only the existing internal evidence cache tables:

- `listing_details`
- `listing_item_specifics`
- `listing_images`

It does not write:

- normal opportunity rows;
- packets;
- approvals;
- execution requests;
- live candidates;
- marketplace execution events;
- price/inventory/listing mutation tables.

## Safety guarantees

Phase 14I does not:

- call `ReviseFixedPriceItem`;
- call any eBay write API;
- perform marketplace writes;
- mutate listing title, description, item specifics, price, inventory, or quantity;
- create opportunities, packets, approvals, execution requests, or live candidates;
- call AI.

Structured safety flags include:

```json
{
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "ebay_write_api_called": false,
  "opportunity_created": false,
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

## Validation result

Syntax checks passed:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
```

Review detail confirmed:

```json
{
  "found": true,
  "review_id": 19,
  "sku": "PMC-24141",
  "item_id": "206288370789",
  "review_status": "shortlisted",
  "hard_exclusion": { "excluded": false }
}
```

### Phase 14H before Phase 14I write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=19
```

Observed before write:

```json
{
  "eligible_for_promotion": false,
  "blockers": ["insufficient_cached_evidence_for_rollback_review"],
  "warnings": ["source_review_evidence_gap:cached_description"],
  "cached_evidence": {
    "description_present": false,
    "limitations": ["cached_description_missing"]
  }
}
```

### Dry-run GetItem evidence fetch

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-evidence-complete --id=19 --dry-run
```

Observed:

```json
{
  "dry_run": true,
  "actual_read_only_ebay_call": true,
  "get_item_called": true,
  "actual_database_write": false,
  "description_present": true,
  "description_length": 1005,
  "item_specifics_count": 2,
  "picture_count": 1,
  "listing_status": "Active",
  "fetch_success": true,
  "ack": "Success"
}
```

### Write-mode internal evidence cache upsert

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-evidence-complete --id=19 --write
```

Observed:

```json
{
  "dry_run": false,
  "actual_read_only_ebay_call": true,
  "get_item_called": true,
  "actual_database_write": true,
  "description_present": true,
  "description_length": 1005,
  "item_specifics_count": 2,
  "picture_count": 1,
  "listing_status": "Active",
  "cache_write_result": {
    "listing_details_written": true,
    "item_specifics_upserted": 2,
    "images_upserted": 1,
    "source": "internal_listing_quality_evidence_cache"
  },
  "marketplace_write_performed": false,
  "revise_fixed_price_item_called": false,
  "ebay_write_api_called": false
}
```

### Phase 14H after Phase 14I write

Command:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-promotion-check --id=19
```

Observed after write:

```json
{
  "eligible_for_promotion": true,
  "blockers": [],
  "warnings": [],
  "cached_evidence": {
    "description_present": true,
    "limitations": []
  },
  "enough_cached_evidence_for_rollback_review": true,
  "existing_artifacts": {
    "opportunities": [],
    "packets": [],
    "requests": []
  }
}
```

Candidate scan after write:

```json
{
  "scanned_count": 20,
  "shortlisted_count": 1,
  "eligible_promotion_count": 1,
  "recommended_next_review_id": 19,
  "blockers_by_type": {
    "review_status_not_shortlisted": 19,
    "insufficient_cached_evidence_for_rollback_review": 19
  }
}
```

The remaining blocker counts are for non-shortlisted review rows in the scan. The selected shortlisted review `19` is now eligible for a later explicit promotion phase only. Phase 14I did not create any opportunity, packet, approval, execution request, live candidate, AI call, eBay write call, marketplace write, or listing mutation.
