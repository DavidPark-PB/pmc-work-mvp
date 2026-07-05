# Hermes Phase 14AV — Public PictureURL Live Revise Closeout

## Purpose

Phase 14AV closeout preserves the already-added live command and persistence fix, then adds read-only audit and record-only reconciliation approval checklist commands.

This closeout phase does not rerun live execution.

## Baseline

Do not redo Phase 14A–14AU. Phase 14AU baseline:

```text
ea59d16 Add Phase 14AU public PictureURL final approval
```

## Current state

```json
{
  "request_id": 6,
  "packet_id": 5,
  "item_id": "206288370789",
  "one_live_revise_attempt_already_occurred": true,
  "started_event_id": 15,
  "current_db_status": "pending_approval",
  "executed_at": null,
  "execution_result": null,
  "hermes_db_unreconciled": true
}
```

The live attempt failed to persist completion because the previous implementation attempted to write string `operator` into the integer `executed_by` column:

```text
invalid input syntax for type integer: "operator"
```

The closeout keeps the fix that removes the invalid `executed_by: 'operator'` write.

## Commands added

```bash
npm run hermes:agent -- ebay-public-picture-url-approved-live-revise --request-id=6 --write --approval-text="<exact Phase 14AU approval text>"
npm run hermes:agent -- ebay-public-picture-url-post-live-audit --request-id=6
npm run hermes:agent -- ebay-public-picture-url-record-reconciliation-readiness --request-id=6
npm run hermes:agent -- ebay-public-picture-url-record-reconciliation-approval-checklist --request-id=6
```

The first command is the already-used guarded live command and must not be run again for this request.

## Post-live audit result

The read-only post-live audit reports:

```json
{
  "request_id": 6,
  "packet_id": 5,
  "item_id": "206288370789",
  "existing_started_event_count": 1,
  "existing_started_event_id": 15,
  "current_db_status": "pending_approval",
  "executed_at": null,
  "execution_result": null,
  "final_approval_status": "not_requested",
  "confirmation_status": "not_confirmed",
  "get_item_ack": "Success",
  "listing_appears_updated": true,
  "hermes_db_unreconciled": true,
  "no_marketplace_writes": true
}
```

Read-only GetItem evidence:

```json
{
  "ack": "Success",
  "item_id": "206288370789",
  "title": "Torune Dolphin Sea Friend Food Picks 8pc Bento Lunch Decoration Picks",
  "picture_urls": [
    "https://i.ebayimg.com/00/s/ODAwWDgwMA==/z/0KQAAeSwNlxqSbcV/$_1.JPG?set_id=8800005007"
  ],
  "item_specifics": [
    { "Name": "Type", "Value": ["Food Pick"] },
    { "Name": "Brand", "Value": ["Torune"] },
    { "Name": "Theme", "Value": ["Dolphin Sea Friend"] },
    { "Name": "Number in Pack", "Value": ["8"] }
  ]
}
```

The requested public PictureURL was accepted by the live revise and is now represented by eBay as an `i.ebayimg.com` hosted URL in GetItem. The audit treats this as image-present/listing-updated evidence while explicitly reporting that the requested public URL was not retained verbatim:

```json
{
  "title_updated": true,
  "item_specifics_updated": true,
  "picture_present": true,
  "requested_picture_url_retained": false,
  "picture_url_transformed_to_ebay_hosted": true,
  "listing_appears_updated": true
}
```

## Reconciliation readiness

```json
{
  "ready_for_record_only_reconciliation_approval": true,
  "blockers": [],
  "audit_summary": {
    "existing_started_event_id": 15,
    "current_db_status": "pending_approval",
    "executed_at": null,
    "execution_result_present": false,
    "listing_appears_updated": true,
    "hermes_db_unreconciled": true,
    "get_item_ack": "Success"
  }
}
```

Allowed only in a future explicitly approved reconciliation phase:

```json
[
  "mark request_id=6 executed",
  "attach execution_result from post-live audit",
  "create completion event"
]
```

## Exact reconciliation approval text

The checklist emits exactly:

```text
Record-only Hermes reconciliation approval for already-executed public PictureURL live revise.
request_id=6 only.
packet_id=5 only.
item_id=206288370789 only.
No eBay calls.
Do not call ReviseFixedPriceItem.
Do not call UploadSiteHostedPictures.
No marketplace writes.
Allowed internal DB writes only: mark request_id=6 executed, attach execution_result from post-live audit, create completion event.
Forbidden changes: listing fields, price, inventory, quantity, description, category, shipping, payment, returns.
One record-only reconciliation attempt only.
Do not push.
```

## Safety

Phase 14AV closeout did not:

- call `ReviseFixedPriceItem` again;
- call `UploadSiteHostedPictures`;
- perform marketplace writes;
- execute record-only reconciliation;
- retry or rephrase the previously denied DB repair command;
- change listing fields, price, inventory, quantity, description, category, shipping, payment, or returns;
- call AI;
- push commits.

It did perform read-only GetItem audits for evidence.

## Validation

```bash
node --check src/api/ebayAPI.js
node --check src/services/hermesExecutionApproval.js
node --check scripts/hermes-agent.js
npm run hermes:agent -- ebay-public-picture-url-post-live-audit --request-id=6
npm run hermes:agent -- ebay-public-picture-url-record-reconciliation-readiness --request-id=6
npm run hermes:agent -- ebay-public-picture-url-record-reconciliation-approval-checklist --request-id=6
git diff --stat
```
