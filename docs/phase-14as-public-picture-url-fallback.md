# Hermes Phase 14AS — Public PictureURL Fallback Planning

## Purpose

Phase 14AS creates a safe planning path for using an operator-supplied public HTTPS `PictureURL` after repeated `UploadSiteHostedPictures` PictureData uploads failed with eBay `21916550 File has corrupt image data`.

This phase is local/public URL planning only. It does not revise the eBay listing.

## Baseline

Do not redo Phase 14A–14AR. Phase 14AR baseline:

```text
1be2d35 Add Phase 14AR token-stable compatible upload execution
```

## Why the PictureData upload path is exhausted

The local upload registry shows repeated eBay Picture Services failures for the same item:

```json
[
  {
    "phase": "14AH",
    "image_path": "/Users/parksungmin/Downloads/torune.jpeg",
    "candidate_sha256": "sha256:16883e4cb7af5ebb12b6948285742faff7d83bdd501600f5fee01428620a1f47",
    "error_codes": ["21916550"],
    "picture_url": null
  },
  {
    "phase": "14AK",
    "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-sanitized-images/206288370789-16883e4cb7af5ebb-baseline.jpg",
    "candidate_sha256": "sha256:98542bad69eed4a599263d2b4d779f9a2a9c8f4e27fc606040c62fd48b0f1f5f",
    "error_codes": ["21916550"],
    "picture_url": null
  },
  {
    "phase": "14AR",
    "image_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
    "candidate_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
    "error_codes": ["21916550"],
    "picture_url": null
  }
]
```

Phase 14AL confirmed the local `PictureData` base64/XML roundtrip is valid. Phase 14AR confirmed token/auth is not the current blocker because eBay returned `21916550`, not `21916984 Invalid IAF token`, during the token-stable compatible variant attempt.

Therefore the direct PictureData path is exhausted or not recommended for the current candidate set.

## Why public HTTPS PictureURL is the next safe strategy

A public HTTPS `PictureURL` lets a later listing-image packet reference an externally hosted image URL rather than sending image bytes through `UploadSiteHostedPictures` PictureData again.

This is safer as the next planning step because:

- it avoids another live PictureData upload attempt;
- it keeps Phase 14AS read-only with respect to eBay;
- it requires explicit operator-supplied URL intake before any packet can be created;
- it preserves the one-way gate: no public URL means no image-aware packet and no listing revise;
- it avoids reusing request_id=5 or previous upload attempts.

## Commands added

```bash
npm run hermes:agent -- ebay-picture-url-fallback-readiness --item-id=206288370789
npm run hermes:agent -- ebay-picture-url-candidate-validate --item-id=206288370789 --picture-url=<HTTPS_URL>
npm run hermes:agent -- ebay-picture-url-candidate-readiness --item-id=206288370789
```

## Fallback readiness result

Observed readiness summary:

```json
{
  "phase": "14AS",
  "item_id": "206288370789",
  "repeated_upload_site_hosted_pictures_failure_count": 3,
  "failure_coverage": {
    "original_image_failed_21916550": true,
    "sanitized_baseline_image_failed_21916550": true,
    "compatible_800_srgb_baseline_variant_failed_21916550": true
  },
  "latest_upload_phase": "14AR",
  "latest_error_code": "21916550",
  "picturedata_strategy_exhausted_or_not_recommended": true,
  "preferred_local_compatible_image_candidate_path": "/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg",
  "preferred_local_compatible_image_sha256": "sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b",
  "public_https_hosted_url_exists": false,
  "public_picture_url_candidate": null,
  "public_url_required_before_listing_revise_can_proceed": true,
  "ready_for_public_picture_url_intake": true,
  "ready_for_image_aware_packet_creation": false,
  "blockers": ["operator_supplied_public_https_image_url_required"]
}
```

## Public URL requirements

The candidate validation command accepts a URL only when:

- URL parses successfully;
- URL uses `https:`;
- host is not localhost;
- host is not private/internal/link-local;
- URL path looks like an image URL (`.jpg`, `.jpeg`, `.png`, or `.webp`).

Phase 14AS does not require the URL to exist yet. If no valid URL exists, readiness remains blocked with:

```text
operator_supplied_public_https_image_url_required
```

If a valid URL is supplied later, it is recorded only as local candidate metadata in:

```text
data/hermes-public-picture-url-candidates.json
```

No database writes or marketplace writes are performed by this phase.

## Candidate readiness without URL

Current candidate readiness:

```json
{
  "candidate_picture_url_exists": false,
  "candidate_picture_url": null,
  "source_type": "operator_supplied_public_https_url",
  "ready_for_image_aware_packet_creation": false,
  "request_id_5_must_not_be_reused": true,
  "previous_upload_attempts_must_not_be_reused": true,
  "blockers": ["operator_supplied_public_https_image_url_required"]
}
```

## Why no listing revise occurs in this phase

Phase 14AS is a planning/intake phase only. It explicitly does not:

- upload images to eBay;
- call `UploadSiteHostedPictures`;
- call `ReviseFixedPriceItem`;
- perform marketplace writes;
- create listing execution requests;
- create listing revise packets;
- change title, item specifics, description, price, inventory, quantity, category, shipping, payment, returns, or images;
- print or modify token values;
- call AI;
- push commits.

A later phase must separately create/approve any image-aware packet and must still preserve all marketplace-write gates.

## Exact next operator action

Host the exact preferred compatible image at a public HTTPS image URL:

```text
/Users/parksungmin/pmc-work-mvp/data/hermes-compatible-image-variants/206288370789-98542bad69eed4a5-srgb-white-800-q90-420-baseline.jpg
```

Expected sha256:

```text
sha256:0c2a7b19e92af9e4762c879e6766864bac4c83c60e2f7ca6e8786abe234a6a6b
```

Then run:

```bash
npm run hermes:agent -- ebay-picture-url-candidate-validate --item-id=206288370789 --picture-url=<HTTPS_URL>
```

After validation, run:

```bash
npm run hermes:agent -- ebay-picture-url-candidate-readiness --item-id=206288370789
```

Do not create a packet or revise the listing until a later explicitly approved phase.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-picture-url-fallback-readiness --item-id=206288370789
npm run hermes:agent -- ebay-picture-url-candidate-readiness --item-id=206288370789
git diff --stat
```
