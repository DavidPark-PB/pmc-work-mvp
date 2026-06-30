# Hermes Phase 3A — Listing Intelligence Alignment Plan

## Purpose

Phase 3A audits the existing Phase 3 Listing Intelligence implementation and aligns the next Phase 3 work with the verified Phase 1C through Phase 2G Signal Engine / Opportunity Inbox flow.

This is an alignment plan only.

No implementation code was changed in this phase. No DB writes, marketplace writes, AI calls, price changes, inventory changes, listing changes, or execution actions were performed.

Latest verified Phase 2 baseline:

```text
b693fdd Add Phase 2 final verification report
```

## Files reviewed

- `docs/phase-2-final-verification.md`
- `docs/phase-3-listing-intelligence-plan.md`
- `src/services/hermesListingIntelligence.js`
- `src/engines/signalEngine.js`
- `src/agents/opportunityAgent.js`
- `src/services/opportunityInbox.js`
- `scripts/hermes-market-intelligence.js`
- `scripts/hermes-agent.js`

## Current Listing Intelligence audit

Existing implementation file:

```text
src/services/hermesListingIntelligence.js
```

Current CLI entry:

```bash
npm run hermes:market -- listing --days=30
npm run hermes:market -- listing --days=30 --telegram
```

Current behavior:

1. `buildListingIntelligenceReport({ days, save })` builds a listing-quality markdown report.
2. `runListingIntelligence({ days, sendTelegram })` calls `buildListingIntelligenceReport({ save: true })` and optionally sends Telegram output.
3. `buildListingRows()` combines:
   - old Product Intelligence report rows from `hermesProductIntelligence.buildProductIntelligenceReport({ days, save: false })`
   - `ebay_products` mirror rows
   - listing enrichment cache tables:
     - `listing_details`
     - `listing_images`
     - `listing_item_specifics`
     - `listing_policies`
4. It calculates a standalone Listing Quality Score using title, images, item specifics, shipping, return policy, category, price position, sales velocity, and competitor gap.
5. It classifies rows with `listingSignal` and renders report sections such as:
   - improvement priority SKUs
   - cheaper but no sales
   - expensive but selling
   - title improvement needed
   - item specifics needed
   - image improvement needed
   - shipping/return check needed
   - dead stock priority
   - data-poor SKUs

## Existing old Product Intelligence dependency

Current Listing Intelligence still depends on old Hermes v1 Product Intelligence input:

```js
productIntel.buildProductIntelligenceReport({ days, save: false })
```

The old product intelligence classifier emits legacy row signals such as:

- `listing_quality_candidate`
- `dead_stock_candidate`
- `data_gap`
- `price_or_margin_review`
- `stock_risk`
- `scale_candidate`
- `watch`

Listing Intelligence then prioritizes these legacy types in `productRank` and `primaryCandidate()`.

This is not yet aligned with the verified Phase 1C~2G flow, where signals and opportunities are now represented as:

- Signal Engine signals, especially `listing_quality_low`
- Recommendation Engine recommendation `listing_quality_review`
- Opportunity Candidate type `listing_quality_review`
- Opportunity Inbox rows with `metadata.hermes_generated = true`
- Review status handled through Hermes-specific review actions
- Approved action planning via `buildHermesOpportunityActionPlan({ id })`

## Alignment target

Phase 3 Listing Intelligence should become the detailed listing-analysis layer behind `listing_quality_low` and `listing_quality_review`, not a separate legacy Product Intelligence track.

Target architecture:

```text
SKU Context
  -> Signal Engine
       -> listing_quality_low
  -> Recommendation Engine
       -> listing_quality_review
  -> Opportunity Candidate Builder
       -> listing_quality_review candidate
  -> Opportunity Inbox Writer
       -> opportunity_inbox row, default dry-run unless --write
  -> Human Review
       -> approved/rejected/reviewing/archived
  -> Action Planner
       -> prepare_listing_quality_review
  -> Phase 3 Listing Intelligence
       -> detailed read-only listing quality evidence/report
```

Phase 3A does not implement this flow. It defines how to align it safely.

## How Listing Intelligence should consume `listing_quality_low`

Recommended Phase 3B+ changes:

1. Add a read-only mode that accepts either:
   - a SKU and builds current SKU Context with `readOnly: true`, or
   - a Hermes-generated `listing_quality_review` opportunity id.
2. For SKU input:
   - call `buildSkuContext({ sku, readOnly: true })`
   - read `context.signals`
   - filter for `signal.type === 'listing_quality_low'`
   - use `signal.value.score` and `signal.value.reasons` as the top-level trigger.
3. For Opportunity Inbox input:
   - read Hermes opportunities via `listHermesOpportunities({ opportunity_type: 'listing_quality_review', ... })`, or a targeted read helper if added later.
   - require `metadata.hermes_generated === true`.
   - use `metadata.source_signals` to confirm `listing_quality_low` lineage where available.
4. Enrich the Signal Engine signal with existing Listing Intelligence score evidence:
   - title keyword score
   - title length score
   - image count score
   - image quality proxy score
   - item specifics score
   - shipping score
   - return policy score
   - category score
   - price position score
   - sales velocity score
   - competitor gap score
5. Keep `listing_quality_low` as the canonical trigger. Listing Intelligence may add details, but it should not create competing legacy signal names.

## How Listing Intelligence should support `listing_quality_review` opportunities

Current Phase 2 flow already maps Recommendation Engine output to `listing_quality_review` opportunity candidates:

```text
listing_quality_review recommendation -> listing_quality_review opportunity candidate
```

Recommended alignment:

1. Do not create a separate Listing Intelligence write path at first.
2. Let Phase 2 Opportunity Candidate Builder remain the canonical creator of `listing_quality_review` candidates.
3. Listing Intelligence should provide detailed evidence that can be attached or viewed during review, such as:
   - score breakdown
   - missing/weak title evidence
   - image count or image quality gaps
   - missing item specifics
   - missing return/shipping/category enrichment
   - sales/price context if relevant
4. If a future writer is needed, it must reuse `writeOpportunityCandidates({ dryRun: true })` by default and preserve the existing duplicate-key behavior.
5. Any future `listing_quality_review` opportunity should preserve metadata lineage:

```json
{
  "hermes_generated": true,
  "sku": "...",
  "candidate_type": "listing_quality_review",
  "source_signals": ["listing_quality_low"],
  "source_recommendations": ["listing_quality_review"],
  "requires_human_review": true
}
```

6. Approved `listing_quality_review` opportunities should use the existing planner mapping:

```text
listing_quality_review -> prepare_listing_quality_review
```

The planner must remain non-executing and include forbidden actions.

## What should remain read-only

The following Phase 3 Listing Intelligence behaviors should remain read-only:

- Building listing quality reports.
- Reading SKU Context.
- Reading Signal Engine output.
- Reading Hermes-generated Opportunity Inbox rows.
- Reading eBay mirror/cache tables.
- Reading listing enrichment cache tables.
- Reading `daily_reports` for latest/preview views.
- Producing markdown or JSON evidence.
- Sending Telegram report text when explicitly requested by existing reporting paths.
- Generating dry-run opportunity previews.

Allowed only when explicitly requested by the existing report workflow:

- Saving a `daily_reports` report row from the existing `save: true` report flow.

For the Phase 3A/3B alignment work, default validation should use read-only or dry-run commands and avoid `save: true` report generation unless the task explicitly asks for report persistence.

## What must not be executed by Listing Intelligence

Listing Intelligence must not:

- Call marketplace write APIs.
- Revise eBay listings.
- Change title, category, item specifics, images, shipping policy, return policy, price, stock, or inventory.
- Create automatic listing drafts without human review.
- Approve or execute marketplace actions.
- Bypass Opportunity Inbox review statuses.
- Treat `approved` Opportunity Inbox status as marketplace execution approval.
- Call AI for listing rewrite generation unless a future phase explicitly adds an AI-gated, non-writing draft proposal step.
- Use paid API tokens unless explicitly requested.

## Safety Foundation boundary

Safety Foundation / PR S already exists in this repo and must not be reimplemented in Phase 3A.

Do not touch or duplicate existing Safety Foundation responsibilities such as:

- global safety guard architecture
- marketplace write blocking / approval enforcement
- approval workflow primitives
- audit/execution safety infrastructure
- existing safety middleware or policy modules
- existing marketplace write protection paths

Phase 3 Listing Intelligence should consume those safeguards if a later phase introduces execution planning or approvals, but Phase 3A only documents alignment and does not modify safety foundation code.

## Recommended Phase 3B implementation sequence

1. Add a read-only Listing Intelligence helper that can analyze one SKU using `buildSkuContext({ sku, readOnly: true })` and current `context.signals`.
2. Map `listing_quality_low` into the existing detailed Listing Quality Score output.
3. Add a CLI/report mode that can show listing quality evidence for:
   - `--sku=<SKU>`
   - `--opportunity-id=<ID>` for Hermes `listing_quality_review` rows
4. Keep default mode read-only and JSON/markdown output only.
5. Add optional dry-run Opportunity Inbox preview by reusing existing Phase 2 writer conventions; do not create new write semantics.
6. Only after review, decide whether the legacy `hermesProductIntelligence` dependency should be deprecated, wrapped, or kept as a portfolio-level report separate from the new SKU-centric Signal Engine flow.

## Validation plan for the next implementation phase

When Phase 3B begins, validate without writes:

```bash
node --check src/services/hermesListingIntelligence.js
node --check scripts/hermes-market-intelligence.js
npm run hermes:signals -- --sku=<SKU_WITH_LISTING_QUALITY_LOW>
npm run hermes:agent -- opportunity --sku=<SKU_WITH_LISTING_QUALITY_LOW>
npm run hermes:agent -- opportunity-write --sku=<SKU_WITH_LISTING_QUALITY_LOW> --dry-run
npm run hermes:agent -- opportunity-list --opportunity_type=listing_quality_review --limit=10
```

Expected results:

- `listing_quality_low` is the canonical listing-quality signal.
- `listing_quality_review` is the canonical Opportunity Inbox type.
- writer defaults to dry-run.
- no marketplace writes.
- no price/inventory/listing changes.
- no AI calls unless a later phase explicitly defines a gated draft-only mode.

## Phase 3A conclusion

Existing Listing Intelligence is useful as a detailed listing quality scoring/reporting engine, but it is currently anchored to old Hermes v1 Product Intelligence row signals.

The alignment path is to keep the scoring/reporting value, replace the legacy trigger source with Phase 1C Signal Engine `listing_quality_low`, and let Phase 2 Opportunity Inbox remain the canonical human-review workflow for `listing_quality_review`.

Safety Foundation should remain untouched.
