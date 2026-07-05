# Hermes Phase 15H — Public PictureURL Final Closeout

## Purpose

Phase 15H is the final read-only closeout for the second public PictureURL live rollout.

This phase verifies that request `7` / packet `7` is complete, that no reconciliation remains, and that future public PictureURL candidate planning excludes the completed rollout artifacts.

## Baseline

Do not redo Phase 15A through Phase 15G.

```text
9e44b3f Add Phase 15G public PictureURL post-live audit
```

## Completed rollout

```json
{
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "title": "Solo Leveling SL3E Card SEALED Store Promo Collection Set",
  "change_scope": ["images"],
  "picture_url": "https://pub-cac9dbf5e5f04a9c83d2788169df18e5.r2.dev/s-l1600.jpg",
  "execution_result_recorded": true,
  "listing_image_appears_updated": true,
  "reconciliation_already_complete": true,
  "record_only_reconciliation_needed": false
}
```

## Command added

```bash
npm run hermes:agent -- ebay-public-picture-url-rollout-closeout --request-id=7
```

The command is read-only. It does not call eBay or `GetItem`; it uses Hermes DB request/packet/event state and the already-recorded Phase 15F execution result.

## Closeout result

```json
{
  "request_id": 7,
  "packet_id": 7,
  "item_id": "206284142714",
  "phase_15_complete": true,
  "listing_image_appears_updated": true,
  "reconciliation_complete": true,
  "duplicate_guard_active": true,
  "no_further_live_action_required": true
}
```

Additional closeout facts:

```json
{
  "request_status": "executed",
  "packet_status": "packet_recorded",
  "packet_status_terminal_or_equivalent": true,
  "started_event_id": 18,
  "started_event_exists": true,
  "completion_event_id": 19,
  "completion_event_exists": true,
  "execution_result_recorded": true,
  "ebay_response_ack": "Warning",
  "ebay_response_ack_success_or_warning": true,
  "record_only_reconciliation_needed": false,
  "no_additional_live_revise_attempt_needed": true
}
```

`packet_recorded` is treated as terminal-equivalent because `hermes_execution_requests.id=7` is executed and contains the recorded execution result, with started/completion events present.

## Duplicate guard

Future public PictureURL candidate planning now excludes the completed Phase 14 and Phase 15 rollout artifacts:

```json
{
  "excluded_request_ids": [6, 7],
  "excluded_packet_ids": [5, 7],
  "excluded_item_ids": ["206288370789", "206284142714"],
  "request_id_7_excluded": true,
  "packet_id_7_excluded": true,
  "item_id_206284142714_excluded": true
}
```

Validation command:

```bash
npm run hermes:agent -- ebay-public-picture-url-next-candidate-plan --limit=10
```

The returned plan includes:

```json
{
  "exclusions": {
    "excluded_request_ids": [6, 7],
    "excluded_packet_ids": [5, 7],
    "excluded_item_ids": ["206288370789", "206284142714"],
    "exclude_phase_14_executed_item_id_206288370789": true,
    "exclude_phase_15_executed_item_id_206284142714": true,
    "exclude_already_executed_public_picture_url_successes": true
  }
}
```

The candidate rows returned by the plan do not include `item_id=206284142714`.

## Safety

Phase 15H did not:

- call eBay;
- call `GetItem`;
- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- execute live;
- perform DB writes;
- call AI;
- push commits.

It only changed local app code and documentation to add the read-only closeout command and harden candidate-plan duplicate guards.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-rollout-closeout --request-id=7
npm run hermes:agent -- ebay-public-picture-url-next-candidate-plan --limit=10
git diff --stat
```
