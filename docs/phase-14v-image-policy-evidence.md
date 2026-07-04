# Hermes Phase 14V — Image Policy Evidence Verifier

## Purpose

Phase 14V adds a read-only image policy evidence verifier for the failed Phase 14T seed live execution.

It does not redo Phase 14A through Phase 14U. Phase 14U baseline:

```text
c522107 Add Phase 14U seed live failure audit
```

## Phase 14T failure

Target tuple:

```json
{
  "approval_id": 37,
  "request_id": 5,
  "packet_id": 4,
  "item_id": "206288370789"
}
```

Phase 14T reached eBay exactly once through `ReviseFixedPriceItem`.

eBay returned:

```text
Ack=Failure
Error 21919137 — The resolution for provided picture(s) does not meet eBay's Picture Policy requirements. Please only use pictures that are at least 500 pixels on the longest side.
```

Because the eBay response was `Failure`, the listing was not changed.

## Phase 14U audit conclusion

Phase 14U confirmed:

- `request_id=5` is failed.
- `marketplace_write_performed=false`.
- `listing_changed=false`.
- The failed mutation fields were only `title` and `item_specifics`.
- Forbidden mutation fields were absent.
- Retry is blocked by:

```json
[
  "request_executed_at_present",
  "request_execution_result_present",
  "metadata_external_action_executed_not_false",
  "metadata_marketplace_execution_approved_not_false"
]
```

## Image policy blocker

eBay rejected the listing revise because an existing image did not satisfy eBay picture policy.

Minimum policy requirement:

```text
longest side >= 500px
```

Phase 14V treats this as a blocking issue for any future `ReviseFixedPriceItem` attempt until image evidence is remediated.

## Evidence sources

Phase 14V uses read-only cached and URL-derived evidence only:

- `listing_images` cached rows
- `ebay_products.image_url`
- `listing_details.raw_data` image references, if present
- `request_id=5` captured eBay failure raw response, for the already-recorded error URL

Phase 14V does not call eBay, does not download images, and does not mutate images.

For eBay image URLs, Phase 14V parses URL-derived dimension hints where available.

Example:

```text
/s/MTgwWDE4MA==/
```

Base64-decoded value:

```text
180X180
```

This indicates a 180px longest side hint, which is below the 500px requirement.

URL variants such as:

```text
s-l140.jpg
```

are treated as thumbnail or derivative evidence only. They are not treated as original image proof by themselves.

## Commands

Image policy evidence verifier:

```bash
npm run hermes:agent -- ebay-listing-quality-image-policy-evidence --item-id=206288370789
```

Remediation readiness check:

```bash
npm run hermes:agent -- ebay-listing-quality-image-remediation-readiness --item-id=206288370789
```

## Why no retry is allowed

`request_id=5` already reached eBay once. Even though eBay rejected the revise, that request is now a completed failed live attempt and must remain non-retryable.

Automatic retry is forbidden because retrying the same request after image remediation could perform a marketplace write without a new explicit approval cycle.

## What must happen before any future live attempt

Before any future live attempt:

1. Do not reuse `request_id=5`.
2. Resolve the image policy issue outside the failed request.
3. Verify replacement image evidence with longest side at least 500px.
4. Create a new request and packet after remediation.
5. Route the new request/packet through explicit human approval.
6. Only then may a future live attempt be considered.

## Safety guarantees

Phase 14V does not:

- retry `request_id=5`
- create a new execution request
- call `ReviseFixedPriceItem`
- call `GetItem`
- perform marketplace writes
- perform database writes
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
- download images
- mutate images
- call AI
- push commits

## Validation

Required non-piped validation commands:

```bash
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-policy-evidence --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-remediation-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-seed-live-failure-audit --request-id=5
git diff --stat
```
