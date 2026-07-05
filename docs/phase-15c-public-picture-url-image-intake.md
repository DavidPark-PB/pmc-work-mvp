# Hermes Phase 15C — Public PictureURL Image Intake

## Purpose

Phase 15C implements read-only public PictureURL image intake and URL validation commands for the selected Phase 15B controlled rollout candidate.

Phase 15C does not create packets, approvals, execution requests, database writes, marketplace writes, or eBay calls.

## Baseline

Do not redo Phase 14, Phase 15A, or Phase 15B.

```text
c36703d Add Phase 15B public PictureURL candidate selection
```

## Selected candidate

```json
{
  "item_id": "206284142714",
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "allowed_changes": ["images"],
  "blocked_changes": [
    "title",
    "item_specifics",
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

Supplied public image URL:

```text
https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg
```

The earlier direct command failure for `ebay-public-picture-url-validate-candidate-url` was expected because the command did not exist before Phase 15C. That failure is not treated as a URL validation failure.

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-selected-candidate --item-id=206284142714

npm run hermes:agent -- ebay-public-picture-url-image-intake-checklist --item-id=206284142714

npm run hermes:agent -- ebay-public-picture-url-validate-candidate-url --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
```

## Selected candidate output

The selected candidate command confirms:

```json
{
  "phase": "15C",
  "operation": "public_picture_url_selected_candidate",
  "selected": true,
  "item_id": "206284142714",
  "expected_item_id": "206284142714",
  "item_id_matches_selected_candidate": true,
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "allowed_changes": ["images"],
  "change_scope": "images_only",
  "change_scope_remains_images_only": true,
  "ready_for_image_url_intake": true,
  "ready_for_packet_creation": false,
  "marketplace_write": false
}
```

The command includes the Phase 15B cached candidate detail for context, but performs no writes.

## Image intake checklist

The image intake checklist confirms:

- selected candidate item_id matches `206284142714`;
- title reviewed from cached/internal evidence;
- allowed change scope is images only;
- public URL should use HTTPS;
- public URL host must not be localhost/private/internal;
- URL path should look like an image URL (`.jpg`, `.jpeg`, `.png`, or `.webp`);
- converted sRGB baseline JPG is preferred for future eBay public PictureURL packet readiness;
- title, item_specifics, price, inventory, quantity, description, category, shipping, payment, and returns remain blocked;
- no packet creation occurs in Phase 15C.

## URL validation rules

The validation command accepts the supplied URL when all of these are true:

```json
{
  "url_is_https": true,
  "url_host_is_not_localhost_or_private": true,
  "url_looks_like_image_url": true,
  "item_id_matches_selected_candidate": true,
  "change_scope_remains_images_only": true
}
```

Accepted validation result:

```json
{
  "valid": true,
  "item_id": "206284142714",
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg",
  "url_is_https": true,
  "url_host_is_not_localhost_or_private": true,
  "url_looks_like_image_url": true,
  "allowed_changes": ["images"],
  "ready_for_packet_creation": false,
  "marketplace_write": false
}
```

The validator is intentionally syntactic/read-only. It does not fetch the URL, call eBay, call GetItem, create a packet, or write to the database.

## Safety

Phase 15C did not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- perform database writes;
- create execution requests;
- create packets;
- call AI;
- change title, item specifics, price, inventory, quantity, description, category, shipping, payment, or returns;
- push commits.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-selected-candidate --item-id=206284142714
npm run hermes:agent -- ebay-public-picture-url-image-intake-checklist --item-id=206284142714
npm run hermes:agent -- ebay-public-picture-url-validate-candidate-url --item-id=206284142714 --url="https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg"
git diff --stat
```
