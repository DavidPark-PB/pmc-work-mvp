'use strict';
/**
 * executionEvents.js — B2C · Phase 6 · Execution event structured logging.
 *
 * Owner spec §17 · 이벤트 명명 확정:
 *   PILOT_ELIGIBILITY_ACTIVATED
 *   QUEUE_REFILL_EXECUTED
 *   TASK_AUTO_ASSIGNED
 *   TASK_MANUALLY_ASSIGNED
 *   TASK_STARTED
 *   TASK_COMPLETED
 *   QC_FAILED
 *   CHANNEL_LIVE
 *
 * 신규 audit 테이블 만들지 않음 · structured console.log 로 시작.
 * 향후 필요 시 team_task_recipients / audit_log 기존 인프라 재사용 가능.
 */

const EVENT_TYPES = [
  //   Phase 6 · 초기 이벤트
  'PILOT_ELIGIBILITY_ACTIVATED',
  'QUEUE_REFILL_EXECUTED',
  'TASK_AUTO_ASSIGNED',
  'TASK_MANUALLY_ASSIGNED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'QC_FAILED',
  'CHANNEL_LIVE',
  //   Phase 7 · lifecycle 세부
  'TASK_CREATED',
  'TASK_SUBMITTED',
  'TASK_BLOCKED',
  'QC_PASSED',
  'QC_RESUBMITTED',
  //   Phase 7.5 · SoT + verification + Wave
  'LISTING_SOT_WRITTEN',
  'LISTING_SOT_WRITE_FAILED',
  'CHANNEL_LIVE_VERIFIED',
  'CHANNEL_LIVE_VERIFICATION_FAILED',
  'QC_PASS_IDEMPOTENT_NOOP',
  'PILOT_WAVE_ACTIVATED',
  'PILOT_ACTIVATION_DRIFT_SKIP',
];

function log(eventType, payload = {}) {
  if (!EVENT_TYPES.includes(eventType)) {
    console.warn('[b2c.event] unknown event type:', eventType);
  }
  const record = {
    event: eventType,
    at: new Date().toISOString(),
    ...payload,
  };
  //   grep 하기 쉬운 prefix
  console.log(`[b2c.event] ${eventType}`, JSON.stringify(record));
  return record;
}

module.exports = { EVENT_TYPES, log };
