/**
 * src/services/oms/piiFilter.js — Sanitize activity log payload.
 *
 * Owner directive §11 · §4:
 *   oms_activity_log 에 buyer email/phone/address/raw payload 를 복사하지 않는다.
 *   sanitizeActivityData() 로 감싼다.
 *
 * 제거 대상 (case-insensitive · 부분 일치):
 *   email, phone, tel, mobile, whatsapp,
 *   street, street1, street2, address, addr,
 *   zip, postal, postal_code, postcode,
 *   raw_payload, rawPayload, payload, buyer_contact, buyerContact,
 *   recipient_name, recipientName, ship_recipient_name,
 *   ship_street, ship_phone, ship_postal,
 *   buyer_name (전체 이름은 최소한 마스킹),
 *   ip, ip_address, session, cookie
 *
 * 남기는 것 (business change):
 *   status / assigned_to / hold_reason / cancellation_reason /
 *   tracking_no (배송 상태) — 이건 PII 아님
 *   금액 / 통화 / 시각 필드 / count 필드
 */
'use strict';

const PII_KEY_PATTERNS = [
  /email/i,
  /phone/i,
  /\btel\b/i,
  /mobile/i,
  /whatsapp/i,
  /street/i,
  /^addr/i,
  /address/i,
  /zip/i,
  /postal/i,
  /postcode/i,
  /raw_payload/i,
  /rawpayload/i,
  /^payload$/i,
  /buyer_contact/i,
  /buyercontact/i,
  /recipient_name/i,
  /recipientname/i,
  /ship_recipient/i,
  /buyer_name/i,
  /buyername/i,
  /^ip$/i,
  /ip_address/i,
  /session/i,
  /cookie/i,
];

const PII_REDACTED = '[REDACTED]';

function isPiiKey(key) {
  if (typeof key !== 'string') return false;
  return PII_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Deep-sanitize any value. Returns a NEW value — never mutates input.
 * - Objects: strip PII keys entirely (drop instead of masking → smaller log).
 * - Arrays: sanitize each element.
 * - Primitives: pass through.
 * - Cycles: guarded via WeakSet.
 *
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
function sanitizeActivityData(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeActivityData(v, seen));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isPiiKey(k)) {
      // drop entirely — activity log is business change diff, not customer record
      continue;
    }
    out[k] = sanitizeActivityData(v, seen);
  }
  return out;
}

/**
 * Mask an email to last-4 form for cases where minimal identification is needed.
 * NOT used in activity log by default. Call site must be explicit.
 * @param {string|null|undefined} email
 * @returns {string|null}
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return PII_REDACTED;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) return `**@${domain}`;
  return `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`;
}

/**
 * Mask a phone number to last-4 form.
 * @param {string|null|undefined} phone
 * @returns {string|null}
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return `***${digits}`;
  return `***${digits.slice(-4)}`;
}

module.exports = {
  sanitizeActivityData,
  maskEmail,
  maskPhone,
  isPiiKey,           // exported for tests only
  PII_KEY_PATTERNS,   // exported for tests only
};
