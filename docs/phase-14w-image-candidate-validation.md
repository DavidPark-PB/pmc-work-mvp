# Hermes Phase 14W — Image Candidate Validation

## Purpose

Phase 14W validates and internally registers an operator-supplied replacement image candidate for the failed Phase 14T seed live execution.

It does not redo Phase 14A through Phase 14V. Phase 14V baseline:

```text
34a60f2 Add Phase 14V image policy evidence verifier
```

## Current state

Target item:

```json
{
  "item_id": "206288370789",
  "failed_request_id": 5
}
```

`request_id=5` failed after reaching eBay exactly once through `ReviseFixedPriceItem`.

eBay rejected the revise because the existing image was below policy:

```text
Error 21919137 — existing picture does not meet eBay minimum 500px longest-side picture policy.
```

Phase 14V verified URL-derived evidence:

```text
/s/MTgwWDE4MA==/ -> 180X180
```

The failed request must not be reused.

## Operator-supplied replacement candidate

```text
/Users/parksungmin/Downloads/torune.jpeg
```

Expected local precheck:

```json
{
  "format": "jpeg",
  "width": 512,
  "height": 512,
  "longest_side": 512
}
```

The candidate satisfies the eBay minimum longest-side requirement of at least 500px.

## Commands

Validate candidate, read-only:

```bash
npm run hermes:agent -- ebay-listing-quality-image-candidate-validate --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
```

Register candidate internally only:

```bash
npm run hermes:agent -- ebay-listing-quality-image-candidate-register --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
```

Confirm readiness:

```bash
npm run hermes:agent -- ebay-listing-quality-image-candidate-readiness --item-id=206288370789
```

## Internal registry

The candidate registration writes internal metadata only to:

```text
data/hermes-image-candidates.json
```

The registry records:

- item id
- local image path
- filename
- file size
- sha256
- format and MIME type
- width and height
- longest side
- whether the image satisfies the 500px policy
- that the candidate replaces failed request 5
- that no marketplace upload/write was performed

## Safety guarantees

Phase 14W does not:

- retry `request_id=5`
- create a new live execution request
- call `ReviseFixedPriceItem`
- upload images to eBay
- perform marketplace writes
- change title
- change item specifics
- change description
- change price
- change inventory
- change quantity
- change category
- change shipping
- change payment
- change returns
- change images
- call AI
- push commits

Internal candidate metadata write is allowed and is the only write performed by the registration command.

## What must happen before any future live attempt

1. Keep `request_id=5` non-retryable.
2. Use the registered image candidate only as internal remediation evidence.
3. A later phase may create a new request and packet for a future remediation attempt.
4. That future request/packet must go through explicit human approval.
5. No future live attempt may occur without separate explicit approval.

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-remediation-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-candidate-validate --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
npm run hermes:agent -- ebay-listing-quality-image-candidate-register --item-id=206288370789 --image-path=/Users/parksungmin/Downloads/torune.jpeg
npm run hermes:agent -- ebay-listing-quality-image-candidate-readiness --item-id=206288370789
git diff --stat
```
