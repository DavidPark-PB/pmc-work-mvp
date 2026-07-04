# Phase 14F Seed Human Review Inbox

## Purpose

Phase 14F creates an internal human-review inbox for the Phase 14E scored listing-quality seed shortlist.

The inbox is a review-only bridge between the deterministic Phase 14E seed scoring preview and a future explicit human decision step. It does not create marketplace candidates, packets, approvals, or execution requests, and it does not mutate any eBay listing fields.

## Source

Phase 14F uses the Phase 14E scoring preview output:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-scoring-preview --limit=100 --top=20
```

Only rows that were eligible and scored in Phase 14E are considered. The default review inbox limit is 20.

## Commands

Dry-run preview, default behavior:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-inbox --limit=20 --dry-run
```

Write internal review records:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-inbox --limit=20 --write
```

List internal review records:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
```

If neither `--dry-run` nor `--write` is provided, the inbox command defaults to dry-run.

## Review record content

Each internal review record stores the human-review payload in metadata:

- `sku`
- `item_id`
- `score`
- `score_breakdown`
- detected listing-quality issue signals
- evidence summary
- proposed safe mutation fields
- warning context
- excluded forbidden fields
- `source_phase: "14E"`
- `source_command`
- `created_at`
- deterministic `review_fingerprint`

Records are tagged as `opportunity_type=listing_quality_seed_review`, `source_type=phase_14e_seed_scoring_preview`, and `source_name=phase_14f_seed_human_review_inbox`. These rows are internal review inbox rows only; the Phase 14F safety response explicitly marks `opportunity_created=false` and `normal_opportunity_created=false`.

## Dry-run/write behavior

Dry-run:

- builds the planned review records from the Phase 14E shortlist;
- reports existing matching records;
- reports how many records would be inserted;
- performs no database write.

Write:

- creates only internal review inbox records;
- skips records already present by deterministic fingerprint;
- verifies review record count after write;
- verifies packet and execution request counts did not change;
- reports inserted and duplicate-skipped counts.

## Idempotency

Phase 14F uses a stable SHA-256 review fingerprint based on:

- source phase;
- SKU;
- item id;
- score;
- listing-quality issue signals;
- evidence gaps;
- proposed safe listing mutation fields;
- score breakdown.

Running `--write` multiple times is safe. A second run with the same Phase 14E shortlist detects the existing fingerprints and inserts zero additional rows.

Observed validation:

- first write inserted 20 internal review rows;
- second write inserted 0 rows and skipped 20 duplicates;
- matching review record count remained 20.

## Hard exclusions

Phase 14F never includes:

- `item_id=202551129453`
- `item_id=206315990948`
- rows already completed by `marketplace_execution_completed`
- `approval_id=15`
- `request_id=4`
- `packet_id=3`

The command preserves the Phase 14E/14D exclusion set and also checks execution-related records before writing.

## Safety guarantees

Allowed write:

- internal human-review inbox rows only when `--write` is explicitly provided.

Forbidden writes/actions:

- no marketplace writes;
- no eBay writes;
- no GetItem calls;
- no ReviseFixedPriceItem calls;
- no price/inventory/quantity changes;
- no title/description/item_specifics changes;
- no packet creation;
- no approval creation;
- no execution request creation;
- no live candidate creation;
- no AI calls.

The list command is read-only and performs no writes.

## Validation result summary

Non-piped validation commands were run:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-seed-review-inbox --limit=20 --dry-run
npm run hermes:agent -- ebay-listing-quality-seed-review-inbox --limit=20 --write
npm run hermes:agent -- ebay-listing-quality-seed-review-inbox --limit=20 --write
npm run hermes:agent -- ebay-listing-quality-seed-review-list --limit=20
npm run hermes:agent -- ebay-listing-quality-seed-scoring-preview --limit=100 --top=20
git diff --stat
```

Results:

- syntax checks passed;
- dry-run planned 20 review records and performed no database writes;
- first write created 20 internal review records only;
- second write created 0 duplicate records and skipped 20 existing records;
- review list returned 20 internal review records;
- Phase 14E scoring preview still returned 88 scored rows and 20 shortlist rows;
- safety flags reported no eBay calls, no marketplace writes, no packet/approval/execution request creation, no live candidates, no AI calls, and no listing field mutations.
