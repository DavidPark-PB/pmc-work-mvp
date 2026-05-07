/**
 * src/lib/redact.js — secret/PII 마스킹 유틸 (Phase 1)
 *
 * 사용처:
 *   - team_tasks.context (자동 예외 카드 payload)
 *   - notifications/SSE payload (DB + 외부 채널)
 *   - 카카오톡 메시지 (Phase 2 도입 예정)
 *   - automation_runs.input_snapshot / output_snapshot
 *
 * 동작:
 *   1) key 이름이 secret 패턴이면 값 통째로 '[REDACTED]' 치환.
 *   2) string 값 안의 email / 한국 휴대전화 / 국제 전화 부분 마스킹.
 *   3) 객체/배열은 재귀. Date / Buffer 는 그대로 통과.
 *   4) 원본 비파괴 — 새 객체/배열을 반환.
 *
 * 정책:
 *   - 과마스킹은 OK, 누설은 NOT OK.
 *   - 본 모듈은 외부 의존성 없음 (Node 빌트인만).
 *   - secret 값 자체를 로그/문서/콘솔에 인쇄하지 않는다.
 */
'use strict';

const REDACTED = '[REDACTED]';

// 키 이름 기반 전체 마스킹 패턴.
// 키 전체 또는 일부에 secret-ish 단어가 있으면 매칭.
const SECRET_KEY_RE =
  /token|secret|password|passwd|credential|api[-_]?key|access[-_]?(?:key|token)|service[-_]?role|cookie|session|authorization|bearer|^key$|^auth$/i;

// string 값 내부 패턴 — 부분 마스킹.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KR_MOBILE_RE = /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const INTL_PHONE_RE = /\+\d{1,3}[-\s]?\d{1,4}[-\s]?\d{3,4}[-\s]?\d{3,4}/g;

function maskEmail(s) {
  return s.replace(EMAIL_RE, (m) => {
    const at = m.indexOf('@');
    if (at <= 1) return '[EMAIL]';
    return m[0] + '***@' + m.slice(at + 1);
  });
}

function maskPhone(s) {
  return s.replace(KR_MOBILE_RE, '[PHONE]').replace(INTL_PHONE_RE, '[PHONE]');
}

function redactString(s) {
  if (typeof s !== 'string') return s;
  return maskPhone(maskEmail(s));
}

function isSecretKey(name) {
  return typeof name === 'string' && SECRET_KEY_RE.test(name);
}

function redact(value, keyHint) {
  if (isSecretKey(keyHint)) {
    return value === null || value === undefined ? value : REDACTED;
  }

  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return redactString(value);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;

  if (value instanceof Date) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, keyHint));
  }

  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v, k);
    }
    return out;
  }

  return value;
}

module.exports = { redact, redactString, isSecretKey };
