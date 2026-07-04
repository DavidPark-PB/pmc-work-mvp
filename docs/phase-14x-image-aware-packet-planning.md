# Hermes Phase 14X — Image-Aware Packet Planning

## Purpose

Phase 14X creates a replacement-image-aware packet planning path for the failed seed listing update.

It does not redo Phase 14A through Phase 14W. Phase 14W baseline:

```text
7e81e12 Add Phase 14W image candidate validation
```

## Why request_id=5 cannot be reused

`request_id=5` already reached eBay exactly once through `ReviseFixedPriceItem` during Phase 14T.

eBay returned `Ack=Failure` with picture policy error `21919137`, and Hermes recorded the attempt as a failed live execution.

The failed request must remain non-retryable because retrying it after image remediation could perform a marketplace write without a new request, packet, and explicit approval cycle.

Expected retry blockers remain:

```json
[
  "request_executed_at_present",
  "request_execution_result_present",
  "metadata_external_action_executed_not_false",
  "metadata_marketplace_execution_approved_not_false"
]
```

## Why image replacement is required

Phase 14V verified that the existing listing image URL contains an eBay dimension hint:

```text
/s/MTgwWDE4MA==/ -> 180X180
```

The longest side is 180px, below eBay's minimum 500px longest-side picture policy. Any future revise attempt can remain blocked until this image-policy issue is remediated.

## Validated replacement candidate

Phase 14W validated and internally registered the operator-supplied candidate:

```text
/Users/parksungmin/Downloads/torune.jpeg
```

Candidate metadata:

```json
{
  "format": "jpeg",
  "width": 512,
  "height": 512,
  "longest_side": 512,
  "sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47"
}
```

The candidate satisfies eBay's 500px longest-side requirement.

## Future packet contents

The future image-aware packet should contain only these planned mutation fields:

```json
[
  "title",
  "item_specifics",
  "images"
]
```

The title and item specifics come from the previously approved packet (`packet_id=4`):

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

The image mutation plan should reference the internal replacement candidate metadata and explicitly state that the local path is not an eBay PictureURL.

Forbidden fields must remain absent:

- price
- inventory
- quantity
- description
- category
- shipping
- payment
- returns

## Why the local image path is not a live eBay image URL

The local file path:

```text
/Users/parksungmin/Downloads/torune.jpeg
```

is valid internal evidence, but it is not a marketplace-compatible image transport value.

A future live execution must either:

1. use an existing supported eBay image upload path that produces an eBay-compatible `PictureURL`, or
2. use a safe hosted URL path accepted by eBay in `PictureDetails.PictureURL`.

Phase 14X does not upload images and does not produce an eBay PictureURL.

## Commands

Planning command:

```bash
npm run hermes:agent -- ebay-listing-quality-image-aware-packet-plan --item-id=206288370789
```

Packet preview command:

```bash
npm run hermes:agent -- ebay-listing-quality-image-aware-packet-preview --item-id=206288370789
```

Create support exists behind:

```bash
npm run hermes:agent -- ebay-listing-quality-image-aware-packet-preview --item-id=206288370789 --create
```

Do not run `--create` in Phase 14X validation. Creation is for a later explicit phase or instruction.

## What must happen before a future live execution

1. Do not reuse `request_id=5`.
2. Create a new request and packet in a later explicit phase.
3. Confirm that the new packet includes only title, item specifics, and image remediation fields.
4. Resolve image transport by producing a marketplace-compatible image URL or supported eBay uploaded image URL.
5. Route the new request/packet through explicit human approval.
6. Only after approval may a future live execution be considered.

## Safety guarantees

Phase 14X does not:

- reuse `request_id=5`
- call `ReviseFixedPriceItem`
- upload images to eBay
- perform marketplace writes
- execute live
- change price
- change inventory
- change quantity
- change description
- change shipping
- change payment
- change returns
- change category
- call AI
- push commits

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-candidate-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-aware-packet-plan --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-aware-packet-preview --item-id=206288370789
git diff --stat
```
