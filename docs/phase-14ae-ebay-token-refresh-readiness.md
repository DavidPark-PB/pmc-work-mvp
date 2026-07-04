# Hermes Phase 14AE — eBay Token Refresh Readiness

## Purpose

Phase 14AE creates a no-secret eBay token source audit and refresh/rotation readiness workflow for the Trading API auth issue found after the corrected image upload attempt.

It does not redo Phase 14A through Phase 14AD. Phase 14AD baseline:

```text
75ebe2b Add Phase 14AD eBay token readiness audit
```

## What failed in Phase 14AC

Phase 14AC performed one explicitly approved corrected `UploadSiteHostedPictures` attempt for:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47"
}
```

The request reached eBay, but eBay returned:

```json
{
  "Ack": "Failure",
  "ErrorCode": "21916984",
  "ShortMessage": "Invalid IAF token.",
  "LongMessage": "IAF token supplied is invalid."
}
```

No `PictureURL` was produced.

## What Phase 14AD confirmed

Phase 14AD confirmed:

- required token/config keys are present
- selected token source is `database_platform_tokens`
- the selected token shape appears OAuth/IAF-like
- the Trading API auth path uses the `X-EBAY-API-IAF-TOKEN` header
- previous `21916984 Invalid IAF token` is present
- no token values were printed or modified

## Why this is a token/auth issue

The request reached eBay and received an eBay Trading API XML failure response. The failure was not an image file validation failure and not a listing revise failure.

The current Trading API code chooses auth transport by token shape:

- OAuth/IAF-like token: `X-EBAY-API-IAF-TOKEN` header
- legacy token-like value: `RequesterCredentials/eBayAuthToken` XML body

The eBay response specifically rejected the IAF token. Likely causes include stale/revoked access token, wrong database-vs-environment token source, production/sandbox mismatch, or a refresh token state that has not produced a valid current access token.

## Token source precedence

The current runtime token precedence is:

1. database `platform_tokens.access_token`
2. environment `EBAY_USER_TOKEN`

If a database token exists, it wins over the environment token. A token source audit must therefore report both sources without printing token values.

## Refresh or manual re-auth

The code already contains an existing OAuth refresh path:

- `EbayAPI.refreshAccessToken()`
- `tokenStore.saveToken('ebay', ...)`

A refresh can be performed by existing code only if required app credentials and a refresh token are available. Since a refresh/rotation writes new token values to token storage and process environment, it requires a separate explicit operator approval.

Manual eBay OAuth re-auth may be required if the refresh token is missing, revoked, wrong-environment, or otherwise invalid.

## Why upload retry remains blocked

The corrected image upload attempt was approved for one corrected upload attempt only. It reached eBay and failed with an auth error. The duplicate guard now blocks future upload attempts for the same item/candidate.

Fixing token state does not itself authorize another image upload. Any future upload attempt still requires a new explicit approval phase.

## Exact future token refresh/rotation approval text

The operator must copy this exact text in a later phase before any token refresh/rotation can run:

```text
eBay token refresh/rotation approval for operation=UploadSiteHostedPictures auth only.
No image upload.
Do not call UploadSiteHostedPictures.
Do not call ReviseFixedPriceItem.
No listing changes.
Token secrets must not be printed.
Allow updating only the existing eBay token store/environment entry.
One token refresh/rotation attempt only.
```

## Commands

No-secret token source audit:

```bash
npm run hermes:agent -- ebay-token-source-audit --operation=UploadSiteHostedPictures
```

Token refresh readiness:

```bash
npm run hermes:agent -- ebay-token-refresh-readiness --operation=UploadSiteHostedPictures
```

Token refresh approval checklist:

```bash
npm run hermes:agent -- ebay-token-refresh-approval-checklist --operation=UploadSiteHostedPictures
```

## Safety guarantees

Phase 14AE does not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- modify token values
- print token secrets
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- call AI
- push commits

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-trading-token-readiness --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-source-audit --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-refresh-readiness --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-refresh-approval-checklist --operation=UploadSiteHostedPictures
git diff --stat
```
