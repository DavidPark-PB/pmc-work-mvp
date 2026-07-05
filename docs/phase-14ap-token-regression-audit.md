# Hermes Phase 14AP — eBay Token Regression Audit

## Purpose

Phase 14AP is a read-only token/auth regression audit after Phase 14AO returned eBay `21916984 Invalid IAF token`.

It does not redo Phase 14A through Phase 14AO. Phase 14AO baseline:

```text
96b2eec Add Phase 14AO compatible image upload execution
```

## Scope

Phase 14AP does not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- modify token values
- print token secrets
- create listing execution requests
- create listing revise packets
- call AI
- push commits

## Commands added

```bash
npm run hermes:agent -- ebay-token-regression-audit --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-current-health --operation=UploadSiteHostedPictures
```

Both commands are read-only and print only token source/shape/metadata, never token values.

## Phase 14AF refresh success

Phase 14AF documented a successful auth-only refresh/rotation:

```text
/Users/parksungmin/pmc-work-mvp/docs/phase-14af-ebay-token-refresh-rotation.md
```

No-secret evidence recorded there:

- `token_refresh_attempted=true`
- `token_refresh_succeeded=true`
- `token_store_write_attempted=true`
- `actual_oauth_network_call=true`
- `actual_database_write=true`
- selected token source remained `database_platform_tokens`
- token shape remained OAuth/IAF-like
- database token `expires_at` moved from expired to future
- database token `updated_at` changed

## Phase 14AH / 14AK accepted-auth evidence

Local upload result registry contains two accepted-auth image-upload failures after Phase 14AF:

```json
[
  {
    "phase": "14AH",
    "timestamp": "2026-07-04T14:52:48.822Z",
    "ebay_ack": "Failure",
    "error_codes": ["21916550"],
    "picture_url": null
  },
  {
    "phase": "14AK",
    "timestamp": "2026-07-04T15:11:40.819Z",
    "ebay_ack": "Failure",
    "error_codes": ["21916550"],
    "picture_url": null
  }
]
```

Inference: eBay Picture Services returned image-corruption error `21916550`, not auth error `21916984`, so auth was accepted far enough to reach the Picture Services validation layer for those attempts.

This also means Phase 14AF refresh did persist well enough for at least one subsequent eBay Picture Services request.

## Phase 14AO Invalid IAF token regression

Phase 14AO executed exactly one compatible variant upload attempt and eBay returned:

```json
{
  "phase": "14AO",
  "timestamp": "2026-07-05T00:07:21.866Z",
  "ebay_ack": "Failure",
  "error_codes": ["21916984"],
  "invalid_iaf_token_present": true,
  "picture_url": null,
  "upload_succeeded": false,
  "compatible_variant_upload_attempt": true,
  "listing_revise_performed": false,
  "revise_fixed_price_item_called": false
}
```

This is an auth/token regression, not an image payload result. The compatible variant was not accepted or rejected by Picture Services because auth failed first.

## Current token source and health

Read-only audit output at Phase 14AP showed:

```json
{
  "selected_token_source": "database_platform_tokens",
  "token_source_precedence": [
    "database_platform_tokens.access_token",
    "environment_EBAY_USER_TOKEN"
  ],
  "token_environment": "production",
  "endpoint_environment": "production",
  "updated_at": "2026-07-05T00:11:14.392",
  "expires_at": "2026-07-05T02:11:14.392",
  "current_time": "2026-07-05T00:19:07.774Z",
  "seconds_until_expiry": 6726,
  "stale_or_expired": false,
  "database_token_still_overrides_env_token": true,
  "refresh_token_available": true,
  "safe_to_refresh_with_existing_path": true,
  "explicit_approval_required_before_refresh": true
}
```

Important nuance: current token metadata was updated after the Phase 14AO failure timestamp. Therefore current health may not be the exact token state used by the Phase 14AO request.

## Same token selection path

The upload command and token audit use the same DB-first token selection order:

```text
database_platform_tokens.access_token -> environment_EBAY_USER_TOKEN
```

Evidence:

- `EbayAPI.callTradingAPI()` invokes `_ensureToken()` before Trading API calls.
- `_ensureToken()` loads `tokenStore.loadToken('ebay')` first and falls back to env only if DB token is absent.
- Phase 14AP token audit reads the same `platform_tokens` source first and reports env fallback only if DB token is absent.

## Possible causes

Phase 14AP cannot prove a single cause without printing token values or retrying eBay. Read-only evidence supports these possibilities:

1. The token used by Phase 14AO was invalid, stale, revoked, or not yet refreshed at the moment of that request.
2. The current database token was updated after Phase 14AO, so current health may reflect a later token state rather than the failed request's token state.
3. `database_platform_tokens` continues to override `EBAY_USER_TOKEN`, so any stale DB token wins over a possibly valid env token.
4. eBay returned `21916984 Invalid IAF token` in a normal Trading API response body. Existing automatic refresh logic may not have refreshed if that exact response body/status shape was not matched as an invalid-token signal.
5. Phase 14AF refresh persistence is not the primary suspect because Phase 14AH/14AK accepted-auth evidence proves the refreshed token path worked after Phase 14AF.

## Why no upload retry is allowed

Phase 14AO approval allowed exactly one compatible variant upload attempt only. That attempt was consumed and recorded. Re-running `UploadSiteHostedPictures` would violate the approval boundary.

Phase 14AP is audit-only. It must not upload, revise listings, mutate token values, or perform marketplace writes.

## Next safe action

Recommended next safe action:

1. Do not retry image upload.
2. Use a separate explicit auth-only approval if token refresh/rotation is needed.
3. Run read-only token source/current-health audits after any authorized auth-only refresh.
4. Require a new explicit upload approval before any future `UploadSiteHostedPictures` attempt.
5. Consider updating Trading API invalid-token detection to recognize `Invalid IAF token` / `21916984` response bodies as refresh-triggering auth failures, but validate that change separately without performing uploads.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-token-source-audit --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-regression-audit --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-token-current-health --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
git diff --stat
```
