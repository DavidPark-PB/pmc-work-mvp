# Hermes Phase 16B — Public PictureURL Mini-Batch Image Intake

## Purpose

Phase 16B prepares image URL intake and URL validation for the low-risk Phase 16A mini-batch candidates.

This phase is read-only. It does not call eBay, call `GetItem`, create packets, create execution requests, perform DB writes, execute live, or perform marketplace writes.

## Baseline

Do not redo Phase 14, Phase 15, or Phase 16A.

```text
a3db4bf Add Phase 16A public PictureURL mini-batch planner
```

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-image-intake-checklist --limit=5
npm run hermes:agent -- ebay-public-picture-url-mini-batch-url-template --limit=5
npm run hermes:agent -- ebay-public-picture-url-mini-batch-validate-urls --url-map='{}'
```

## Intake readiness

Phase 16B marks only the low-risk Phase 16A candidates as ready for URL intake:

```json
{
  "mini_batch_url_intake_ready": true,
  "ready_item_ids": ["206332929888", "206371786121", "206387679082"],
  "blocked_item_ids": ["206273302162", "206273302295"],
  "ready_for_packet_creation": false,
  "marketplace_write": false
}
```

Ready candidates:

```json
[
  {
    "item_id": "206332929888",
    "title": "NIKKE Nivel Arena TCG BT07 Stellar Blade EVE Protocol Booster Box Sealed Korean",
    "risk_level": "low",
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_url_intake": true,
    "ready_for_packet_creation": false
  },
  {
    "item_id": "206371786121",
    "title": "TELECA fromis_9 MIIMCA Fan Box Trading Card Box lIMITED EDITION",
    "risk_level": "low",
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_url_intake": true,
    "ready_for_packet_creation": false
  },
  {
    "item_id": "206387679082",
    "title": "Pokemon Card Game Abyss Eye Booster Box MEGA M5 Sealed Korean ver.",
    "risk_level": "low",
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_url_intake": true,
    "ready_for_packet_creation": false
  }
]
```

Blocked high-risk candidates:

```json
[
  {
    "item_id": "206273302162",
    "title": null,
    "risk_level": "high",
    "ready_for_url_intake": false,
    "ready_for_packet_creation": false,
    "blocked_until_cached_evidence_refreshed": true
  },
  {
    "item_id": "206273302295",
    "title": null,
    "risk_level": "high",
    "ready_for_url_intake": false,
    "ready_for_packet_creation": false,
    "blocked_until_cached_evidence_refreshed": true
  }
]
```

The high-risk candidates are blocked from packet creation until cached listing evidence is refreshed and reviewed.

## URL template

The URL template command outputs this operator-fillable structure:

```json
{
  "206332929888": "",
  "206371786121": "",
  "206387679082": ""
}
```

The operator should fill each value with one public HTTPS image URL, then pass the JSON to:

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-validate-urls --url-map='<FILLED_JSON>'
```

## URL validation rules

The URL validator accepts a JSON object via `--url-map`.

Each supplied URL is checked for:

- HTTPS only;
- host is not localhost/private/internal;
- path looks like an image URL (`.jpg`, `.jpeg`, `.png`, `.webp`);
- item_id is in the approved low-risk mini-batch list;
- allowed changes remain exactly `["images"]`.

Validation remains syntactic/read-only. It does not fetch URLs, call eBay, call `GetItem`, create packets, create execution requests, or write DB rows.

Operator-supplied URL map validated in this phase:

```json
{
  "206332929888": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg",
  "206371786121": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg",
  "206387679082": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"
}
```

Validation output includes the required compact `validated_urls` map:

```json
{
  "mini_batch_url_intake_ready": true,
  "ready_item_ids": ["206332929888", "206371786121", "206387679082"],
  "blocked_item_ids": ["206273302162", "206273302295"],
  "validated_urls": {
    "206332929888": {
      "valid": true,
      "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206332929888.jpg"
    },
    "206371786121": {
      "valid": true,
      "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206371786121.jpg"
    },
    "206387679082": {
      "valid": true,
      "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/206387679082.jpg"
    }
  },
  "all_supplied_urls_valid": true,
  "ready_for_packet_creation": false,
  "marketplace_write": false
}
```

Validation with an empty map remains available as a preparation check; it reports missing ready item ids and `all_supplied_urls_valid=false` without writes.

## Safety

Phase 16B did not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- perform DB writes;
- create execution requests;
- create packets;
- call AI;
- push commits.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-mini-batch-plan --limit=5
npm run hermes:agent -- ebay-public-picture-url-mini-batch-image-intake-checklist --limit=5
npm run hermes:agent -- ebay-public-picture-url-mini-batch-url-template --limit=5
npm run hermes:agent -- ebay-public-picture-url-mini-batch-validate-urls --url-map='{}'
git diff --stat
```
