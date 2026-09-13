'use strict';

/**
 * src/middleware/internalToken.js — PMC-CCOREA-SHIPPING-1B correction (2026-09-13).
 *
 * Server-to-server bearer token authentication for /api/internal/* endpoints.
 *
 * Owner directive §3: the automation subproject (pmc-auto) must NOT reuse
 * admin browser cookies for internal shadow requests. This middleware
 * validates a dedicated token via constant-time comparison.
 *
 * Env var: SHIPPING_QUOTE_INTERNAL_TOKEN
 *   · When unset, the endpoint returns 503 so the calling side can detect
 *     "shadow not configured" and silently skip.
 *   · When set to a short value (<16 bytes) the middleware rejects requests
 *     to force operators to generate a strong secret.
 *
 * Never logs the token. Never echoes it in error bodies.
 */

const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 16;

function _tokenFromEnv() {
  return (process.env.SHIPPING_QUOTE_INTERNAL_TOKEN || '').trim();
}

//   Timing-safe string comparison. Handles length mismatch without leaking
//   the correct length through timing.
function _safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) {
    //   Do a fixed-cost comparison anyway so timing doesn't leak length.
    const pad = Buffer.alloc(ab.length);
    crypto.timingSafeEqual(ab, pad);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function requireInternalToken(req, res, next) {
  const expected = _tokenFromEnv();
  if (!expected) {
    //   Owner directive §3: without a configured token the endpoint MUST
    //   refuse rather than accept "no auth". Log once with a clear code so
    //   operators know to set it. NEVER include the header value in the log.
    return res.status(503).json({
      ok: false,
      error: 'INTERNAL_TOKEN_NOT_CONFIGURED',
      message: 'SHIPPING_QUOTE_INTERNAL_TOKEN is not set on the main service',
    });
  }
  if (expected.length < MIN_TOKEN_LENGTH) {
    return res.status(503).json({
      ok: false,
      error: 'INTERNAL_TOKEN_TOO_SHORT',
      message: `SHIPPING_QUOTE_INTERNAL_TOKEN must be at least ${MIN_TOKEN_LENGTH} chars`,
    });
  }

  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  const bearer = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i) : null;
  if (!bearer || !_safeEqual(bearer[1].trim(), expected)) {
    return res.status(401).json({ ok: false, error: 'INVALID_INTERNAL_TOKEN' });
  }
  //   Tag the request so downstream code knows this is a server-to-server
  //   internal call, not a user session.
  req.isInternalCall = true;
  return next();
}

module.exports = {
  requireInternalToken,
  MIN_TOKEN_LENGTH,
  //   exported for tests
  _safeEqual,
};
