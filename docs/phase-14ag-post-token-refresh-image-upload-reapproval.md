# Hermes Phase 14AG — Post-Token-Refresh Image Upload Reapproval

## Purpose

Phase 14AG creates a read-only readiness audit and a new explicit approval checklist for one future `UploadSiteHostedPictures` attempt after the eBay token refresh/rotation succeeded.

It does not redo Phase 14A through Phase 14AF. Phase 14AF baseline:

```text
e383b26 Add Phase 14AF eBay token refresh rotation
```

## Token refresh success

Phase 14AF completed one approved auth-only token refresh/rotation attempt.

No token values were printed. The no-secret metadata showed:

- token_refresh_attempted=true
- token_refresh_succeeded=true
- token_store_write_attempted=true
- actual_oauth_network_call=true
- actual_database_write=true
- selected token source remained `database_platform_tokens`
- token environment remained production
- API endpoint environment remained production
- refreshed token expiry advanced to a future timestamp

## Why the previous image upload failed

Phase 14AC performed one explicitly approved corrected `UploadSiteHostedPictures` attempt for:

```json
{
  "item_id": "206288370789",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47"
}
```

That request reached eBay, but eBay returned:

```json
{
  "Ack": "Failure",
  "ErrorCode": "21916984",
  "ShortMessage": "Invalid IAF token.",
  "LongMessage": "IAF token supplied is invalid."
}
```

No `PictureURL` was produced.

## Why new explicit image upload approval is required

The token refresh only corrected auth state. It did not approve a new marketplace image upload.

`UploadSiteHostedPictures` is still an eBay API operation that may create marketplace-hosted image state, so it requires a new explicit operator approval after token refresh.

The previous corrected upload attempt was one-attempt-only. The duplicate guard remains active until a future upload phase consumes the exact new post-token-refresh approval.

## Exact future approval text

The operator must copy this exact text in a later phase before any post-token-refresh upload transport can run:

```text
Post-token-refresh eBay image upload transport approval.
item_id=206288370789 only.
image_path=/Users/parksungmin/Downloads/torune.jpeg only.
candidate_sha256=sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47 exact match only.
Allowed operation: UploadSiteHostedPictures only.
Forbidden operation: ReviseFixedPriceItem.
Forbidden changes: title, item_specifics, description, price, inventory, quantity, category, shipping, payment, returns.
One post-token-refresh upload attempt only.
Record returned PictureURL only.
No listing revise in the upload phase.
```

## Safety gates

A future post-token-refresh upload phase must require:

```json
{
  "token_refresh_succeeded": true,
  "token_source": "database_platform_tokens",
  "token_environment": "production",
  "api_endpoint_environment": "production",
  "picture_url_available": false,
  "upload_succeeded": false,
  "new_explicit_operator_approval": true,
  "dedicated_environment_flag": "HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true",
  "exact_item_id_match": "206288370789",
  "exact_image_path_match": "/Users/parksungmin/Downloads/torune.jpeg",
  "exact_candidate_sha256_match": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "allowed_operation": "UploadSiteHostedPictures",
  "forbidden_operation": "ReviseFixedPriceItem",
  "one_post_token_refresh_upload_attempt_only": true,
  "record_returned_picture_url_only": true,
  "no_listing_revise_in_upload_phase": true
}
```

## No listing revise in this phase

Phase 14AG does not:

- upload images
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images
- call AI
- push commits

## Commands

Post-token-refresh upload readiness:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-post-token-refresh-readiness --item-id=206288370789
```

Post-token-refresh approval checklist:

```bash
npm run hermes:agent -- ebay-listing-quality-image-upload-post-token-refresh-approval-checklist --item-id=206288370789
```

Future placeholder only, still blocked until exact new approval is provided:

```bash
HERMES_EBAY_IMAGE_UPLOAD_ENABLED=true npm run hermes:agent -- ebay-listing-quality-image-upload-transport --item-id=206288370789 --write --approval-text="<exact post-token-refresh approval text>"
```

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-token-source-audit --operation=UploadSiteHostedPictures
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-post-token-refresh-readiness --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-upload-post-token-refresh-approval-checklist --item-id=206288370789
git diff --stat
```
