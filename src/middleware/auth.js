/**
 * Simple shared-password authentication middleware.
 *
 * - POST /api/auth/login  — verify password, set signed cookie
 * - POST /api/auth/logout — clear cookie
 * - authGuard middleware   — check cookie on every request
 *
 * Env vars:
 *   DASHBOARD_PASSWORD  — the shared password (required in production)
 *   COOKIE_SECRET       — cookie signing secret (auto-generated if missing)
 */

const crypto = require('crypto');

const COOKIE_NAME = 'pmc_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Paths that don't require authentication
const PUBLIC_PATHS = [
  '/login.html',
  '/api/auth/login',
  '/api/auth/logout',
  '/favicon.ico',
];

// Prefixes that don't require authentication
const PUBLIC_PREFIXES = [
  '/css/',
  '/fonts/',
  '/images/',
];

function getPassword() {
  return process.env.DASHBOARD_PASSWORD || null;
}

function getCookieSecret() {
  if (!process.env.COOKIE_SECRET) {
    process.env.COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[Auth] COOKIE_SECRET not set, using random value (sessions will not survive restart)');
  }
  return process.env.COOKIE_SECRET;
}

/**
 * Generate a session token (HMAC of timestamp)
 */
function generateSessionToken() {
  const timestamp = Date.now().toString();
  const hmac = crypto.createHmac('sha256', getCookieSecret())
    .update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}

/**
 * Verify a session token
 */
function verifySessionToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [timestamp, sig] = parts;
  const expected = crypto.createHmac('sha256', getCookieSecret())
    .update(timestamp).digest('hex');
  if (sig !== expected) return false;
  // Check expiry
  const age = Date.now() - parseInt(timestamp);
  return age < COOKIE_MAX_AGE;
}

/**
 * Auth guard middleware — check cookie, redirect to login if missing
 */
function authGuard(req, res, next) {
  // Skip auth if no password is configured (local dev)
  if (!getPassword()) return next();

  // Public paths
  const urlPath = req.path;
  if (PUBLIC_PATHS.includes(urlPath)) return next();
  if (PUBLIC_PREFIXES.some(p => urlPath.startsWith(p))) return next();

  // Check cookie
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (verifySessionToken(token)) return next();

  // Not authenticated
  const isApi = urlPath.startsWith('/api/');
  if (isApi) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.redirect('/login.html');
}

/**
 * Login route handler — POST /api/auth/login
 */
function loginHandler(req, res) {
  const { password } = req.body;
  const expected = getPassword();

  if (!expected) {
    return res.json({ success: true, message: 'No password configured' });
  }

  if (!password || password !== expected) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
  }

  const token = generateSessionToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
  res.json({ success: true });
}

/**
 * Logout route handler — POST /api/auth/logout
 */
function logoutHandler(req, res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
}

module.exports = { authGuard, loginHandler, logoutHandler };
