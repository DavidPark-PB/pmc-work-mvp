# Hermes Phase 16F — Public PictureURL Mini-Batch Post-Live Audit

## Purpose

Phase 16F performs a read-only post-live audit and final closeout for the Phase 16E public PictureURL mini-batch live revise.

No further live `ReviseFixedPriceItem` attempt is allowed for request_ids `8,9,10`.

## Baseline

Do not redo Phase 16A through Phase 16E.

```text
64a588e Add Phase 16E public PictureURL mini-batch live revise
```

## Command added

```bash
npm run hermes:agent -- ebay-public-picture-url-mini-batch-post-live-audit --request-ids=8,9,10
```

The command is read-only. It may perform safe read-only `GetItem` verification. It must not call `ReviseFixedPriceItem` or `UploadSiteHostedPictures`.

## Required closeout summary

The audit returned:

```json
{
  "phase_16_complete": true,
  "audited_request_ids": [8, 9, 10],
  "success_count": 3,
  "failure_count": 0,
  "reconciliation_complete": true,
  "duplicate_guard_active": true,
  "no_further_live_action_required": true
}
```

## Per-request audit

### request_id=8 / packet_id=8 / item_id=206332929888

```json
{
  "success": true,
  "request_status": "executed",
  "packet_status": "packet_recorded",
  "packet_status_terminal_or_equivalent": true,
  "started_event_id": 23,
  "completion_event_id": 24,
  "execution_result_recorded": true,
  "ebay_response_ack": "Warning",
  "ebay_response_ack_success_or_warning": true,
  "listing_image_appears_updated": true,
  "get_item_read_only_call_performed": true,
  "no_additional_live_revise_attempt_needed": true,
  "no_additional_live_revise_attempt_allowed": true,
  "record_only_reconciliation_needed": false,
  "reconciliation_already_complete": true
}
```

Read-only `GetItem` evidence:

```json
{
  "ack": "Success",
  "item_id": "206332929888",
  "picture_url_transformed_to_ebay_hosted": true,
  "requested_picture_url_retained": false,
  "picture_present": true
}
```

### request_id=9 / packet_id=9 / item_id=206371786121

```json
{
  "success": true,
  "request_status": "executed",
  "packet_status": "packet_recorded",
  "packet_status_terminal_or_equivalent": true,
  "started_event_id": 25,
  "completion_event_id": 26,
  "execution_result_recorded": true,
  "ebay_response_ack": "Warning",
  "ebay_response_ack_success_or_warning": true,
  "listing_image_appears_updated": true,
  "get_item_read_only_call_performed": true,
  "no_additional_live_revise_attempt_needed": true,
  "no_additional_live_revise_attempt_allowed": true,
  "record_only_reconciliation_needed": false,
  "reconciliation_already_complete": true
}
```

Read-only `GetItem` evidence:

```json
{
  "ack": "Success",
  "item_id": "206371786121",
  "picture_url_transformed_to_ebay_hosted": true,
  "requested_picture_url_retained": false,
  "picture_present": true
}
```

### request_id=10 / packet_id=10 / item_id=206387679082

```json
{
  "success": true,
  "request_status": "executed",
  "packet_status": "packet_recorded",
  "packet_status_terminal_or_equivalent": true,
  "started_event_id": 27,
  "completion_event_id": 28,
  "execution_result_recorded": true,
  "ebay_response_ack": "Warning",
  "ebay_response_ack_success_or_warning": true,
  "listing_image_appears_updated": true,
  "get_item_read_only_call_performed": true,
  "no_additional_live_revise_attempt_needed": true,
  "no_additional_live_revise_attempt_allowed": true,
  "record_only_reconciliation_needed": false,
  "reconciliation_already_complete": true
}
```

Read-only `GetItem` evidence:

```json
{
  "ack": "Success",
  "item_id": "206387679082",
  "picture_url_transformed_to_ebay_hosted": false,
  "requested_picture_url_retained": true,
  "picture_present": true
}
```

## Duplicate guard

Phase 16F verifies the completed mini-batch remains excluded from future candidate/mini-batch planning:

```json
{
  "excluded_request_ids": [8, 9, 10],
  "excluded_packet_ids": [8, 9, 10],
  "excluded_item_ids": ["206332929888", "206371786121", "206387679082"],
  "request_ids_8_9_10_excluded": true,
  "packet_ids_8_9_10_excluded": true,
  "item_ids_206332929888_206371786121_206387679082_excluded": true
}
```

The Phase 16A mini-batch planner exclusion list was also extended to include these executed request, packet, and item IDs.

## Record-only reconciliation

Record-only reconciliation is not needed:

```json
{
  "record_only_reconciliation_needed": false,
  "record_only_reconciliation_noop": true,
  "exact_record_only_reconciliation_approval_text": null
}
```

If future evidence ever shows an unreconciled Phase 16E record, the audit command can emit exact record-only reconciliation approval text, but it must not execute reconciliation without explicit approval.

## Safety

Phase 16F did not:

- call `ReviseFixedPriceItem`;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- perform live execution;
- change title;
- change item specifics;
- change price;
- change inventory;
- change quantity;
- change description;
- change category;
- change shipping/payment/returns;
- perform database writes;
- call AI;
- push commits.

Phase 16F did perform safe read-only `GetItem` verification for item_ids `206332929888`, `206371786121`, and `206387679082`.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-mini-batch-post-live-audit --request-ids=8,9,10
npm run hermes:agent -- ebay-public-picture-url-mini-batch-plan --limit=5
git diff --stat
```
