# Hermes Phase 16A — Public PictureURL Mini-Batch Plan

## Purpose

Phase 16A creates a controlled mini-batch planner for the next public PictureURL rollout candidates.

This phase is read-only. It does not call eBay, call `GetItem`, create packets, create execution requests, perform DB writes, execute live, or perform marketplace writes.

## Baseline

Do not redo Phase 14 or Phase 15.

```text
3261de0 Add Phase 15H public PictureURL rollout closeout
```

Completed public PictureURL live rollouts remain excluded:

```json
{
  "completed_rollouts": [
    { "item_id": "206288370789", "request_id": 6, "packet_id": 5 },
    { "item_id": "206284142714", "request_id": 7, "packet_id": 7 }
  ]
}
```

## Command added

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-plan --limit=5
```

The command uses cached/internal Hermes evidence only. It does not fetch live marketplace state.

## Required exclusions

The mini-batch planner hard-codes the completed public PictureURL rollouts out of selection:

```json
{
  "excluded_request_ids": [6, 7],
  "excluded_packet_ids": [5, 7],
  "excluded_item_ids": ["206288370789", "206284142714"]
}
```

The existing public PictureURL candidate detail and shortlist duplicate guards were also hardened so candidate selection excludes completed rollouts rather than only the Phase 14 item.

## Ranking factors

Phase 16A ranks candidates with:

- listing quality issue severity;
- image improvement need;
- cached listing evidence availability;
- low risk of accidental non-image changes;
- no previous executed public PictureURL request;
- candidate suitable for an images-only update;
- human review readiness.

Each candidate remains `ready_for_packet_creation=false`; this phase only prepares operator review.

## Validation output summary

Command:

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-plan --limit=5
```

Result shape:

```json
{
  "mini_batch_ready": true,
  "limit": 5,
  "excluded_request_ids": [6, 7],
  "excluded_packet_ids": [5, 7],
  "excluded_item_ids": ["206288370789", "206284142714"],
  "marketplace_write": false
}
```

Selected mini-batch:

```json
[
  {
    "rank": 1,
    "item_id": "206332929888",
    "title": "NIKKE Nivel Arena TCG BT07 Stellar Blade EVE Protocol Booster Box Sealed Korean",
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_human_review": true,
    "ready_for_packet_creation": false,
    "risk_level": "low"
  },
  {
    "rank": 2,
    "item_id": "206371786121",
    "title": "TELECA fromis_9 MIIMCA Fan Box Trading Card Box lIMITED EDITION",
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_human_review": true,
    "ready_for_packet_creation": false,
    "risk_level": "low"
  },
  {
    "rank": 3,
    "item_id": "206387679082",
    "title": "Pokemon Card Game Abyss Eye Booster Box MEGA M5 Sealed Korean ver.",
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_human_review": true,
    "ready_for_packet_creation": false,
    "risk_level": "low"
  },
  {
    "rank": 4,
    "item_id": "206273302162",
    "title": null,
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_human_review": true,
    "ready_for_packet_creation": false,
    "risk_level": "high"
  },
  {
    "rank": 5,
    "item_id": "206273302295",
    "title": null,
    "recommended_allowed_changes": ["images"],
    "public_picture_url_needed": true,
    "ready_for_human_review": true,
    "ready_for_packet_creation": false,
    "risk_level": "high"
  }
]
```

The first three candidates have stronger cached listing evidence and low risk. The fourth and fifth entries remain review-only because cached title/image evidence is incomplete; their high severity and image need make them useful for operator review, not packet creation.

## Safety

Phase 16A did not:

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
git diff --stat
```
