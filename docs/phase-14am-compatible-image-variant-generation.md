# Hermes Phase 14AM — Compatible Image Variant Generation

## Purpose

Phase 14AM creates materially different local JPEG candidates from the Phase 14AI sanitized baseline candidate using stricter eBay-compatible encoding profiles.

It does not redo Phase 14A through Phase 14AL. Phase 14AL baseline:

```text
36fa797 Add Phase 14AL image upload payload audit
```

## Current state

Target:

```json
{
  "item_id": "206288370789"
}
```

Known failures:

```json
[
  {
    "phase": "14AH",
    "candidate": "original",
    "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
    "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
    "ebay_error": "21916550"
  },
  {
    "phase": "14AK",
    "candidate": "sanitized_baseline",
    "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
    "candidate_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
    "ebay_error": "21916550"
  }
]
```

Phase 14AL ruled out local PictureData corruption:

- PictureData is base64 encoded.
- Decoded payload bytes match the sanitized file bytes.
- JPEG magic bytes survive payload roundtrip.
- XML escaping does not alter base64.
- Token/auth is not the blocker.

## Scope

Phase 14AM is local candidate generation and internal metadata registration only.

It does not:

- retry image upload
- call `UploadSiteHostedPictures`
- call `ReviseFixedPriceItem`
- perform marketplace writes
- create listing execution requests
- create listing revise packets
- change eBay listing fields
- mutate original image files
- mutate the sanitized baseline image
- call AI
- push commits

## Variant generation command

```bash
npm run hermes:agent -- ebay-listing-quality-image-generate-compatible-variants --item-id=206288370789
```

The command generates local variants under:

```text
data/hermes-compatible-image-variants/
```

Internal variant metadata is registered in:

```text
data/hermes-image-compatible-variants.json
```

The `data/` path is gitignored. This is intentional because these are local/generated artifacts and internal metadata, not source code.

## Generated variants

Three variants were generated from the sanitized baseline candidate:

```json
[
  {
    "variant_id": "srgb-white-800-q90-420-baseline",
    "local_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
    "sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
    "width": 800,
    "height": 800,
    "longest_side": 800,
    "format": "jpeg",
    "color_space": "srgb",
    "progressive": false,
    "baseline_jpeg_detected": true,
    "chroma_subsampling": "4:2:0",
    "metadata_stripped": true,
    "eligible_for_ebay_picture_policy": true
  },
  {
    "variant_id": "srgb-white-1000-q90-420-baseline",
    "local_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-1000-q90-420-baseline.jpg",
    "sha256": "sha256:9c7c66cace6528b7356a04f6f90dfb06834696d72eb817aed9584f35083f8ff4",
    "width": 1000,
    "height": 1000,
    "longest_side": 1000,
    "format": "jpeg",
    "color_space": "srgb",
    "progressive": false,
    "baseline_jpeg_detected": true,
    "chroma_subsampling": "4:2:0",
    "metadata_stripped": true,
    "eligible_for_ebay_picture_policy": true
  },
  {
    "variant_id": "srgb-white-800-q92-444-baseline",
    "local_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q92-444-baseline.jpg",
    "sha256": "sha256:ed999fd7475dddd02a2322f44ed5df2be739f4b77c6ca0fac862ed297b0d18d5",
    "width": 800,
    "height": 800,
    "longest_side": 800,
    "format": "jpeg",
    "color_space": "srgb",
    "progressive": false,
    "baseline_jpeg_detected": true,
    "chroma_subsampling": "4:4:4",
    "metadata_stripped": true,
    "eligible_for_ebay_picture_policy": true
  }
]
```

## Preferred candidate

Preferred candidate:

```json
{
  "variant_id": "srgb-white-800-q90-420-baseline",
  "local_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "width": 800,
  "height": 800,
  "longest_side": 800,
  "color_space": "srgb",
  "progressive": false,
  "baseline_jpeg_detected": true,
  "chroma_subsampling": "4:2:0",
  "metadata_stripped": true,
  "eligible_for_ebay_picture_policy": true
}
```

Why this candidate is materially different from the failed sanitized baseline:

- sha256 differs from the sanitized baseline
- dimensions changed from 512x512 to 800x800
- sRGB color space confirmed
- no alpha channel
- metadata stripped
- baseline/non-progressive JPEG
- white background
- no CMYK
- no ICC/exotic color profile detected
- 4:2:0 chroma subsampling, a conservative web JPEG profile

## Variant audit command

```bash
npm run hermes:agent -- ebay-listing-quality-image-compatible-variant-audit --item-id=206288370789
```

Audit result:

```json
{
  "original_failed_ebay_21916550": true,
  "sanitized_failed_ebay_21916550": true,
  "token_auth_ruled_out": true,
  "payload_roundtrip_valid": true,
  "generated_variant_count": 3,
  "eligible_variant_count": 3,
  "ready_for_new_upload_approval_checklist": true,
  "blockers": []
}
```

## Next safe action

A later phase may create an explicit upload approval checklist for exactly one `UploadSiteHostedPictures` attempt using the preferred compatible variant.

Phase 14AM itself does not approve or execute that upload.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-image-upload-payload-audit --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-generate-compatible-variants --item-id=206288370789
npm run hermes:agent -- ebay-listing-quality-image-compatible-variant-audit --item-id=206288370789
git diff --stat
```
