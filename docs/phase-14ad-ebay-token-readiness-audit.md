# Hermes Phase 14AD — eBay Token Readiness Audit

## Purpose

Phase 14AD adds read-only token/auth readiness audits for eBay Trading API image upload operations after the Phase 14AC corrected upload reached eBay and failed with an auth error.

It does not redo Phase 14A through Phase 14AC. Phase 14AC baseline:

```text
1f860b1 Add Phase 14AC corrected image upload execution
```

## What failed in Phase 14AC

The corrected image upload attempt for:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "operation": "UploadSiteHostedPictures"
}
```

reached eBay and returned:

```json
{
  "Ack": "Failure",
  "ErrorCode": "21916984",
  "ShortMessage": "Invalid IAF token.",
  "LongMessage": "IAF token supplied is invalid."
}
```

No `PictureURL` was produced.

## Why this is an auth/token issue

The current Trading API code selects auth shape based on token form:

- OAuth/IAF-like token: sends `X-EBAY-API-IAF-TOKEN` header.
- Legacy token-like value: sends `RequesterCredentials/eBayAuthToken` in XML body.

Phase 14AC received eBay error `21916984 Invalid IAF token`, which means the upload request reached eBay but the token supplied through the IAF auth path was rejected. Likely causes include:

- stale or revoked OAuth user token
- wrong token source winning precedence between DB token store and environment
- production/sandbox mismatch
- refresh token not valid for the expected environment/account
- current token refresh path not triggered by this XML-level `Ack=Failure` response

## Why no listing changed

Phase 14AC called only `UploadSiteHostedPictures` and did not produce a usable `PictureURL`.

It did not call:

```text
ReviseFixedPriceItem
```

It did not create a listing execution request or a listing revise packet.

It did not change:

- title
- item_specifics
- description
- price
- inventory
- quantity
- category
- shipping
- payment
- returns
- images

## Why retry is blocked

The corrected Phase 14AC attempt was explicitly approved as one corrected upload attempt only. It reached eBay and failed with an auth error. The duplicate guard now blocks additional upload attempts for the same item/candidate.

Any future upload attempt requires corrected token/auth state and a new explicit operator approval phase.

## Token/auth state that must be fixed before future upload

Before any future upload attempt, the operator must verify and correct the eBay Trading API token source without printing secrets:

- confirm `EBAY_APP_ID`, `EBAY_CERT_ID`, and `EBAY_DEV_ID` are present for the intended environment
- confirm the selected access token source: DB `platform_tokens` vs `EBAY_USER_TOKEN`
- confirm whether the selected token is OAuth/IAF-like or legacy-token-like
- ensure production/sandbox environment matches the token
- refresh or replace OAuth user access/refresh token through the existing secure token path
- do not paste token values into docs, CLI output, or chat

## Safe next operator action

Run read-only audits:

```bash
npm run hermes:agent -- ebay-trading-token-readiness --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-listing-quality-image-upload-auth-failure-audit --item-id=206288370789
```

Then fix token/auth state out-of-band using the existing secure token management flow. After the token state is corrected, use a new phase to request explicit approval before any future `UploadSiteHostedPictures` attempt.

## Safety guarantees

Phase 14AD does not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- print token secrets
- modify token values
- call AI
- push commits

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check src/adapters/ebayListingQualityExecutionAdapter.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-trading-token-readiness --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-listing-quality-image-upload-auth-failure-audit --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
git diff --stat
```
