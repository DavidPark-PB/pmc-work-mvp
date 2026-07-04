# Hermes Phase 14AF — eBay Token Refresh Rotation

## Purpose

Phase 14AF consumes the exact Phase 14AE operator approval and performs one eBay OAuth token refresh/rotation attempt for `UploadSiteHostedPictures` authentication only.

It does not redo Phase 14A through Phase 14AE. Phase 14AE baseline:

```text
33165be Add Phase 14AE eBay token refresh readiness
```

## Approved scope

The approved scope is auth-only:

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

## What this phase may do

This phase may invoke the existing eBay OAuth refresh path:

- `EbayAPI.refreshAccessToken()`
- `tokenStore.saveToken('ebay', ...)`

It may update only the existing eBay token store/environment auth entry.

## What this phase must not do

This phase must not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- print token secrets
- call AI
- push commits

## Command

```bash
npm run hermes:agent -- ebay-token-refresh-rotate --operation=UploadSiteHostedPictures --write --approval-text='<exact approval text>'
```

## Result shape

The result reports only no-secret metadata:

- token refresh attempted/succeeded
- OAuth network call attempted
- token store write attempted/succeeded
- selected token source before/after
- token shape before/after
- expires_at and updated_at before/after if available
- no token values

## Execution result

The approved Phase 14AF token refresh/rotation command completed successfully.

No token values were printed. Only no-secret metadata was reported:

- token_refresh_attempted=true
- token_refresh_succeeded=true
- token_store_write_attempted=true
- actual_oauth_network_call=true
- actual_database_write=true
- selected token source remained `database_platform_tokens`
- token shape remained OAuth/IAF-like
- database token `expires_at` moved from an expired timestamp to a fresh future timestamp
- database token `updated_at` was updated

## Upload retry remains blocked

Refreshing the token does not authorize another image upload attempt. The previous image upload duplicate guard still blocks further upload attempts until a later phase creates a new explicit upload approval.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-token-refresh-readiness --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-refresh-approval-checklist --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-source-audit --operation=UploadSiteHostedPictures
git diff --stat
```
