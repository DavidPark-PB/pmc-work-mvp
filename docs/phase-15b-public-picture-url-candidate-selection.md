# Hermes Phase 15B — Public PictureURL Candidate Selection

## Purpose

Phase 15B creates a read-only candidate selection and human review step for the next controlled eBay listing quality rollout using the proven public PictureURL workflow.

Phase 15B does not create packets, approvals, execution requests, or marketplace writes.

## Baseline

Do not redo Phase 14 or Phase 15A.

```text
5c47554 Add Phase 15A public PictureURL rollout readiness
```

## Candidate input list

Phase 15B uses the Phase 15A candidate list as explicit input:

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

The Phase 14 successful item remains excluded:

```json
{
  "excluded_request_ids": [6],
  "excluded_packet_ids": [5],
  "excluded_item_ids": ["206288370789"]
}
```

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-candidate-shortlist --limit=10
npm run hermes:agent -- ebay-public-picture-url-candidate-detail --item-id=<ITEM_ID>
npm run hermes:agent -- ebay-public-picture-url-candidate-review-checklist --item-id=<ITEM_ID>
```

All commands are read-only and use cached/internal evidence only.

## Shortlist ranking

The shortlist command ranks candidates using:

- listing quality issue severity;
- image improvement need;
- availability of cached listing evidence;
- low risk of accidental price/inventory/category/description change;
- no previous executed public PictureURL request;
- no duplicate with `item_id=206288370789`;
- no duplicate with `request_id=6 / packet_id=5`.

Validation selected the top candidate as:

```json
{
  "rank": 1,
  "item_id": "206284142714",
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "rollout_rank_score": 250,
  "public_picture_url_needed": true,
  "ready_for_human_review": true,
  "ready_for_packet_creation": false,
  "recommended_allowed_changes": ["images"],
  "blocked_changes": [
    "price",
    "inventory",
    "quantity",
    "description",
    "category",
    "shipping",
    "payment",
    "returns"
  ]
}
```

The ranking intentionally favors candidates with sufficient cached evidence and low risk for controlled rollout, even when other candidates have more severe issues but incomplete cached evidence.

## Candidate detail format

The detail command emits the required review structure. Example for `item_id=206273508304`:

```json
{
  "item_id": "206273508304",
  "title": "Baby Shark Dancing Cute Buddy Korea Toy",
  "current_listing_summary": {
    "sku": "206273508304",
    "item_id": "206273508304",
    "title": "Baby Shark Dancing Cute Buddy Korea Toy",
    "listing_status": "Active",
    "category_id": "261068",
    "category_name": "Toys & Hobbies:Action Figures & Accessories:Action Figures",
    "condition": "New",
    "cached_internal_data_only": true
  },
  "image_status": {
    "image_count": 6,
    "image_improvement_needed": false,
    "public_picture_url_needed": true
  },
  "listing_quality_issues": [
    { "type": "title_short", "severity": "medium" },
    { "type": "item_specifics_sparse", "severity": "medium" },
    { "type": "cached_description_missing", "severity": "low" }
  ],
  "recommended_allowed_changes": ["title", "item_specifics"],
  "blocked_changes": [
    "price",
    "inventory",
    "quantity",
    "description",
    "category",
    "shipping",
    "payment",
    "returns"
  ],
  "public_picture_url_needed": true,
  "ready_for_human_review": true,
  "ready_for_packet_creation": false,
  "reasoning": "Cached evidence score 60; issue severity score 35; image need score 0. No previous executed public PictureURL request was found for this item in cached Hermes records. Risk is low because cached listing evidence is sufficient and Phase 15B blocks non-quality fields. Phase 15B is a review step only; packet creation remains false by design."
}
```

`public_picture_url_needed` remains true as a rollout readiness input because the next packet phase must use the proven public HTTPS PictureURL path if image changes are included. If cached image count is sufficient, the command explains that image improvement is not currently required but the public PictureURL input remains part of future packet readiness.

## Review checklist

The review checklist command produces a human-readable checklist covering:

- read-only scope confirmation;
- no eBay/GetItem calls;
- no ReviseFixedPriceItem;
- no UploadSiteHostedPictures;
- no execution request or packet creation in Phase 15B;
- title, image status, listing quality issues, and allowed changes;
- blocked price/inventory/quantity/description/category/shipping/payment/returns changes;
- duplicate guard checks against item_id `206288370789`, request_id `6`, and packet_id `5`;
- future packet approval decision only after human review.

## Safety

Phase 15B did not:

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
npm run hermes:agent -- ebay-public-picture-url-rollout-readiness
npm run hermes:agent -- ebay-public-picture-url-next-candidate-plan --limit=10
npm run hermes:agent -- ebay-public-picture-url-candidate-shortlist --limit=10
npm run hermes:agent -- ebay-public-picture-url-candidate-detail --item-id=206273508304
npm run hermes:agent -- ebay-public-picture-url-candidate-review-checklist --item-id=206273508304
git diff --stat
```
