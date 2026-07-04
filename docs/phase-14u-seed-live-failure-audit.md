# Hermes Phase 14U — Seed Live Failure Audit and Image Policy Remediation Plan

## Purpose

Phase 14U is a read-only post-failure audit for the Phase 14T seed live execution attempt.

It does not redo Phase 14A through Phase 14T. Phase 14T baseline:

```text
71b9d50 Add Phase 14T seed live execution
```

## Phase 14T outcome

Target tuple:

```json
{
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "item_id": "206288370789"
}
```

Phase 14T attempted the explicitly approved live execution exactly once.

The attempted API operation was `ReviseFixedPriceItem`, scoped to the approved listing-quality mutation:

```json
{
  "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
  "item_specifics": {
    "Brand": "Torune",
    "Type": "Food Pick",
    "Theme": "Dolphin Sea Friend",
    "Number in Pack": "8"
  }
}
```

No price, inventory, quantity, description, shipping, payment, returns, category, or image mutation was included.

## eBay rejection

The eBay response returned `Ack=Failure`.

Blocking error:

```text
21919137 — existing picture does not meet eBay minimum 500px longest-side picture policy.
```

Non-blocking warning also observed:

```text
21919456 — business policies warning.
```

The failure was caused by an existing listing image that does not satisfy eBay picture policy. eBay requires the longest side of listing pictures to be at least 500px.

## Why the listing was not changed

Because eBay returned `Ack=Failure`, the revise request was rejected by eBay.

The execution record marks:

```json
{
  "marketplace_write_performed": false,
  "listing_changed": false,
  "price_changes": false,
  "inventory_changes": false,
  "quantity_changes": false,
  "description_changes": false,
  "shipping_changes": false,
  "payment_changes": false,
  "returns_changes": false,
  "category_changes": false,
  "image_changes": false
}
```

## Why automatic retry is forbidden

`request_id=5` is now a terminal failed execution attempt. It must remain non-retryable.

The duplicate/retry guard must continue to show:

```json
[
  "request_executed_at_present",
  "request_execution_result_present",
  "metadata_external_action_executed_not_false",
  "metadata_marketplace_execution_approved_not_false"
]
```

A failed live attempt still counts as an attempted external action. Retrying the same request would violate the one-shot live execution boundary and could accidentally perform an unapproved marketplace write after remediation.

## Phase 14U commands

Failure audit:

```bash
npm run hermes:agent -- ebay-listing-quality-seed-live-failure-audit --request-id=5
```

Image policy remediation planner:

```bash
npm run hermes:agent -- ebay-listing-quality-image-policy-remediation-plan --item-id=206288370789
```

Both commands are read-only.

They do not call `GetItem`, do not call `ReviseFixedPriceItem`, do not call live transport, do not write marketplace state, do not write database state, do not download images, do not modify images, and do not call AI.

## What must happen before any future live attempt

Before any future listing revise attempt for this item:

1. The existing image policy issue must be remediated outside `request_id=5`.
2. Image evidence should prove that listing images satisfy eBay's minimum 500px longest-side rule.
3. A new request and packet must be created after remediation.
4. The new request/packet must go through the normal explicit approval flow.
5. Only after explicit approval may a future live attempt be considered.

`request_id=5` must not be retried.

## Exact safe next step

Run the read-only image policy remediation planner:

```bash
npm run hermes:agent -- ebay-listing-quality-image-policy-remediation-plan --item-id=206288370789
```

If cached dimensions are unknown, use an existing read-only evidence utility or manual inspection to determine image dimensions. Do not download, modify, upload, or revise images from Phase 14U.

## Safety guarantees

Phase 14U does not:

- retry the failed live execution
- call `ReviseFixedPriceItem`
- call `GetItem`
- perform marketplace writes
- perform database writes
- change title
- change item specifics
- change price
- change inventory
- change quantity
- change description
- change shipping
- change payment
- change returns
- change category
- change images
- download images
- modify images
- call AI
- push commits

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- execution-detail --id=5
npm run hermes:agent -- execution-events --id=5 --limit=20
npm run hermes:agent -- ebay-listing-quality-seed-live-failure-audit --request-id=5
npm run hermes:agent -- ebay-listing-quality-image-policy-remediation-plan --item-id=206288370789
git diff --stat
```
