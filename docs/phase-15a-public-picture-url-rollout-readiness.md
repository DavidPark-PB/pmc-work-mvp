# Hermes Phase 15A — Public PictureURL Rollout Readiness

## Purpose

Phase 15A prepares controlled rollout readiness for the successful Phase 14 public PictureURL listing quality workflow.

This phase is read-only. It does not call eBay, create packets, create live execution requests, perform marketplace writes, or change listings.

## Baseline

Do not redo Phase 14. Phase 14AX baseline:

```text
6bf3c21 Add Phase 14AX final closeout
```

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-rollout-readiness
npm run hermes:agent -- ebay-public-picture-url-next-candidate-plan --limit=10
```

## Rollout readiness result

The rollout readiness command reports:

```json
{
  "phase": "15A",
  "operation": "public_picture_url_rollout_readiness",
  "request_id_6_executed": true,
  "duplicate_guard_active": true,
  "public_picture_url_path_proven": true,
  "picture_data_upload_path_not_recommended": true,
  "ready_for_next_controlled_candidate_selection": true
}
```

Phase 14 success summary:

```json
{
  "successful_item_id": "206288370789",
  "successful_request_id": 6,
  "successful_packet_id": 5,
  "request_id_6_executed": true,
  "executed_at": "2026-07-05T02:06:38.157",
  "completion_event_id": 16,
  "listing_appears_updated": true,
  "public_picture_url_path_proven": true,
  "ebay_hosted_image_transformation_observed": true,
  "no_unreconciled_state_remains": true
}
```

## PictureData upload path is not recommended

The Phase 14 PictureData path should not be preferred for this workflow because:

- `UploadSiteHostedPictures` / PictureData had repeated token and image payload failure modes;
- sanitized and compatible local JPEG variants still encountered eBay image payload rejection;
- the final successful route was an operator-supplied public HTTPS PictureURL;
- eBay accepted the public URL path through one approved live revise attempt and represented the image as an eBay-hosted URL.

The successful image evidence remains:

```text
https://i.ebayimg.com/00/s/ODAwWDgwMA==/z/0KQAAeSwNlxqSbcV/$_1.JPG?set_id=8800005007
```

## Required operator inputs for next SKU

Before any future packet creation or live execution, the operator must provide/review:

- target SKU or eBay item_id selected from read-only candidate planning;
- human review that title/item_specific/image improvements are appropriate;
- public HTTPS image URL for the candidate image, if image replacement/addition is needed;
- explicit confirmation that price, inventory, quantity, description, category, shipping, payment, and returns are out of scope;
- separate future approval before packet creation or live execution.

## Next candidate plan

The next candidate command is read-only and uses cached/internal candidate sources. It excludes the Phase 14 success record:

```json
{
  "excluded_request_ids": [6],
  "excluded_item_ids": ["206288370789"],
  "exclude_already_executed_phase_14_success": true,
  "exclude_any_executed_request_or_execution_result_from_source_plan": true
}
```

The command returned 10 candidate listing rows requiring human review before any packet creation. Candidate rows are sourced from cached internal evidence and include improvement reasons such as:

- `image_improvement_or_cache_review_needed`
- `item_specifics_improvement_or_cache_review_needed`
- `title_improvement_or_cache_review_needed`
- `needs_read_only_evidence_refresh_before_packet`

Example candidate IDs returned in validation:

```json
[
  "206273508304",
  "206284142714",
  "206286078077",
  "206332929888",
  "206371786121",
  "206387679082",
  "206273500196",
  "206273302162",
  "206273302295",
  "206273369517"
]
```

The plan explicitly records:

```json
{
  "require_human_review_before_any_packet_creation": true,
  "no_writes_performed": true,
  "ready_for_human_candidate_review": true
}
```

## Forbidden in Phase 15A

```json
[
  "ReviseFixedPriceItem",
  "UploadSiteHostedPictures",
  "marketplace_writes",
  "listing_changes",
  "live_execution_request_creation",
  "packet_creation",
  "ai_calls"
]
```

## Safety

Phase 15A did not:

- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- call `GetItem`;
- call eBay;
- perform marketplace writes;
- change listings;
- create packets;
- create live execution requests;
- perform DB writes;
- call AI;
- push commits.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-final-closeout --request-id=6
npm run hermes:agent -- ebay-public-picture-url-duplicate-guard --request-id=6
npm run hermes:agent -- ebay-public-picture-url-rollout-readiness
npm run hermes:agent -- ebay-public-picture-url-next-candidate-plan --limit=10
git diff --stat
```
