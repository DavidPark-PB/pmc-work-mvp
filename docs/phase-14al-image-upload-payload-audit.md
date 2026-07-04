# Hermes Phase 14AL — Image Upload Payload Audit

## Purpose

Phase 14AL audits the local `UploadSiteHostedPictures` payload construction after both eBay Picture Services attempts returned `21916550`.

It does not redo Phase 14A through Phase 14AK. Phase 14AK baseline:

```text
5e617d4 Add Phase 14AK sanitized image upload execution
```

## Scope

Phase 14AL is local payload inspection and dry-run only.

It does not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change listing fields
- call AI
- push commits

## Prior upload failures

Original candidate upload reached eBay after token refresh and failed:

```json
{
  "phase": "14AH",
  "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
  "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
  "ebay_ack": "Failure",
  "error_code": "21916550",
  "short_message": "File has corrupt image data",
  "picture_url": null
}
```

Sanitized baseline JPEG upload also reached eBay and failed with the same error:

```json
{
  "phase": "14AK",
  "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
  "candidate_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
  "ebay_ack": "Failure",
  "error_code": "21916550",
  "short_message": "File has corrupt image data",
  "picture_url": null
}
```

## Why token/auth is ruled out

Phase 14AC previously showed a token/auth failure (`21916984 Invalid IAF token`). After token refresh, Phase 14AH and Phase 14AK both reached eBay Picture Services and returned `21916550`, not an auth/token error.

That means the current blocker is not token transport. It is at or after Picture Services processing of the uploaded image payload.

## Commands

Payload audit:

```bash
npm run hermes:agent -- ebay-image-upload-payload-audit --item-id=206288370789
```

Local payload roundtrip:

```bash
npm run hermes:agent -- ebay-image-upload-payload-roundtrip --item-id=206288370789
```

## Payload encoding findings

The current local payload uses:

```json
{
  "transport": "PictureData",
  "picture_url_transport_used": false,
  "picture_data_base64_encoded": true,
  "binary_file_length": 28546,
  "base64_length": 38064,
  "payload_content_length": 38358,
  "detected_jpeg_magic_bytes_before_encoding": "ffd8ffdb0043000201010101",
  "decoded_payload_bytes_match_sanitized_file_bytes": true,
  "decoded_payload_sha256_matches_sanitized_image": true,
  "jpeg_magic_bytes_survive_roundtrip": true,
  "xml_escaping_may_alter_base64": false
}
```

The redacted request shape is:

```xml
<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>hermes-206288370789-sanitized-replacement-image</PictureName>
  <PictureSet>Supersize</PictureSet>
  <PictureData>[base64 omitted; length=38064]</PictureData>
</UploadSiteHostedPicturesRequest>
```

No token values or secrets are included in the audit output.

## Fix added in this phase

The upload payload builder is now centralized in `src/api/ebayAPI.js`:

- `EbayAPI.escapeXml(value)` safely escapes XML metadata fields.
- `EbayAPI.buildUploadSiteHostedPicturesPayload(...)` builds local `PictureData` payloads from file bytes using base64.
- `uploadSiteHostedPicture(...)` now uses the same payload builder as the local audit/roundtrip commands.

This removes ambiguity between live payload construction and local payload inspection.

## Likely payload issue

Local roundtrip passed. Hermes is not embedding raw binary into XML, and the local `PictureData` base64 decodes back to bytes that exactly match the sanitized JPEG.

Therefore the repeated `21916550` is not explained by local raw-binary embedding, XML escaping corruption, or base64 roundtrip corruption.

Most likely causes remaining:

1. eBay Picture Services rejects the actual JPEG content/encoding profile even though local decoders accept it.
2. eBay Picture Services has stricter JPEG constraints than the local checks cover.
3. A later explicit phase may need to test a materially different JPEG render, or a different approved transport strategy.

## Disabled future strategy

No alternate transport is enabled in Phase 14AL.

Possible future strategies, only after a new explicit approval:

- Create a materially different JPEG from pixels using a different encoder/settings and audit it locally before upload.
- Test `UploadSiteHostedPictures` with a public HTTPS `PictureURL` instead of `PictureData`, if eBay docs/support indicate that route is safer for this image.
- Prototype multipart/EPS upload transport in disabled local-only code before any live attempt.

## Why no upload retry occurred

Phase 14AK already used the approved one sanitized upload attempt. Phase 14AL has no approval to make another eBay call. The duplicate guard also records the sanitized attempt as used.

Phase 14AL only builds and decodes the intended XML payload locally.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-listing-quality-image-upload-result --item-id=206288370789
npm run hermes:agent -- ebay-image-upload-payload-audit --item-id=206288370789
npm run hermes:agent -- ebay-image-upload-payload-roundtrip --item-id=206288370789
git diff --stat
```
