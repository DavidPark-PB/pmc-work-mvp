/**
 * 인증 미들웨어 — 유저 로그인 + 레거시 공유 비밀번호 호환
 *
 * 로그인 방식:
 *   1. 유저 로그인 (권장): POST /api/auth/login { username, password }
 *      → users 테이블에서 bcrypt 검증 → 세션에 userId + role 포함
 *   2. 레거시 로그인 (전환기 안전장치): POST /api/auth/login { password }
 *      → DASHBOARD_PASSWORD 검증 → userId=0, role='admin' 할당
 *
 * 세션 토큰 포맷:
 *   신규: "userId.timestamp.hmac"   (3파트)
 *   레거시: "timestamp.hmac"         (2파트, userId=0, role='admin'로 취급)
 *
 * 미들웨어:
 *   authGuard       — 로그인 체크 + req.user 주입
 *   requireAdmin    — req.user.isAdmin 체크
 *
 * 라우트 핸들러:
 *   loginHandler              POST /api/auth/login
 *   logoutHandler             POST /api/auth/logout
 *   meHandler                 GET  /api/auth/me
 *   changePasswordHandler     PATCH /api/auth/change-password
 *   adminResetPasswordHandler PATCH /api/admin/reset-password/:userId
 *
 * Env:
 *   DASHBOARD_PASSWORD  — 레거시 공유 비번 (미설정 시 레거시 로그인 비활성)
 *   COOKIE_SECRET       — HMAC 서명 키 (미설정 시 랜덤 — 재시작 시 세션 무효)
 */

const crypto = require('crypto');
const userRepo = require('../db/userRepository');

const COOKIE_NAME = 'pmc_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7일

const PUBLIC_PATHS = [
  '/login.html',
  '/api/auth/login',
  '/api/auth/logout',
  '/favicon.ico',
];
const PUBLIC_PREFIXES = ['/css/', '/fonts/', '/images/'];

// 레거시 로그인 시 사용하는 의사 userId (사장 권한)
const LEGACY_USER_ID = 0;

// ── 설정 헬퍼 ──
function getSharedPassword() {
  return process.env.DASHBOARD_PASSWORD || null;
}

function getCookieSecret() {
  if (!process.env.COOKIE_SECRET) {
    process.env.COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[Auth] COOKIE_SECRET 미설정 — 랜덤 생성됨 (재시작 시 세션 무효)');
  }
  return process.env.COOKIE_SECRET;
}

// ── 세션 토큰 ──
function signSession(userId, timestamp) {
  const payload = `${userId}:${timestamp}`;
  return crypto.createHmac('sha256', getCookieSecret()).update(payload).digest('hex');
}

function generateSessionToken(userId) {
  const timestamp = Date.now().toString();
  const sig = signSession(userId, timestamp);
  return `${userId}.${timestamp}.${sig}`;
}

/**
 * 토큰 검증 → { userId, timestamp } | null
 * 2파트(레거시) 토큰도 허용
 */
function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split('.');

  if (parts.length === 3) {
    // 신규 포맷
    const [userIdStr, timestamp, sig] = parts;
    const userId = parseInt(userIdStr, 10);
    if (!Number.isFinite(userId)) return null;
    const expected = signSession(userId, timestamp);
    if (sig !== expected) return null;
    if (Date.now() - parseInt(timestamp, 10) >= COOKIE_MAX_AGE) return null;
    return { userId, timestamp: parseInt(timestamp, 10) };
  }

  if (parts.length === 2) {
    // 레거시 포맷: timestamp.hmac (userId 없음 → 0으로 취급, admin)
    const [timestamp, sig] = parts;
    const expected = crypto.createHmac('sha256', getCookieSecret()).update(timestamp).digest('hex');
    if (sig !== expected) return null;
    if (Date.now() - parseInt(timestamp, 10) >= COOKIE_MAX_AGE) return null;
    return { userId: LEGACY_USER_ID, timestamp: parseInt(timestamp, 10), legacy: true };
  }

  return null;
}

function setSessionCookie(res, userId) {
  const token = generateSessionToken(userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

// ── req.user 주입 ──
async function loadUserFromSession(session) {
  if (!session) return null;

  // 레거시 세션 (userId=0) → 의사 admin 유저
  if (session.userId === LEGACY_USER_ID) {
    return {
      id: 0,
      username: '__legacy_admin__',
      displayName: '관리자 (레거시)',
      role: 'admin',
      isAdmin: true,
      canManageFinance: true,
      isLegacy: true,
    };
  }

  const row = await userRepo.findById(session.userId);
  if (!row || !row.is_active) return null;

  const isAdmin = row.role === 'admin';
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isAdmin,
    canManageFinance: isAdmin || !!row.can_manage_finance,
    platform: row.platform || null,
    uiMode: row.ui_mode || 'normal',
    isLegacy: false,
  };
}

// ── 미들웨어 ──

/**
 * authGuard — 모든 보호 경로에 적용
 * 성공 시 req.user 주입
 */
async function authGuard(req, res, next) {
  // 레거시 비번 미설정 + 신규 로그인 없음 → 로컬 dev (인증 스킵)
  const hasAnyAuthSource = !!getSharedPassword(); // 신규 로그인은 user가 있으면 항상 가능

  // 공개 경로
  const urlPath = req.path;
  if (PUBLIC_PATHS.includes(urlPath)) return next();
  if (PUBLIC_PREFIXES.some(p => urlPath.startsWith(p))) return next();

  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verifySessionToken(token);

  if (!session) {
    // 로컬 dev 모드 — 공유 비번 미설정이면 통과
    if (!hasAnyAuthSource) return next();
    if (urlPath.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login.html');
  }

  try {
    const user = await loadUserFromSession(session);
    if (!user) {
      // 세션은 유효하지만 유저가 삭제/비활성화됨 → 로그아웃 처리
      res.clearCookie(COOKIE_NAME, { path: '/' });
      if (urlPath.startsWith('/api/')) {
        return res.status(401).json({ error: 'Session invalid' });
      }
      return res.redirect('/login.html');
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] 유저 로드 실패:', err.message);
    return res.status(500).json({ error: 'Auth error' });
  }
}

/** Admin 전용 가드 */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.isAdmin) return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}

/** 재무(지출) 접근 가드 — admin 또는 can_manage_finance=true */
function requireFinanceAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.canManageFinance) return res.status(403).json({ error: '재무 접근 권한이 없습니다' });
  next();
}

/**
 * 레거시 관리자 계정(공유 비번 로그인, userId=0)으로는 쓰기 작업 차단.
 * 업무관리 DB 작업은 users 테이블에 있는 실제 id가 필요함 (FK 제약).
 * 적용 대상: /api/tasks, /api/purchase-requests, /api/attendance, /api/payroll,
 *          /api/bonuses, /api/feedback, /api/users, /api/admin, /api/notifications
 */
const WRITE_PATHS_FOR_REAL_USER = [
  '/api/tasks',
  '/api/purchase-requests',
  '/api/attendance',
  '/api/payroll',
  '/api/bonuses',
  '/api/feedback',
  '/api/users',
  '/api/admin',
  '/api/notifications',
];
function blockLegacyWrites(req, res, next) {
  if (!req.user?.isLegacy) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const p = req.path;
  const matches = WRITE_PATHS_FOR_REAL_USER.some(w => p === w || p.startsWith(w + '/'));
  if (!matches) return next();
  return res.status(400).json({
    error: '레거시 관리자 계정으로는 업무관리 작업을 할 수 없습니다. 본인 계정(예: owner)으로 로그인하세요.',
  });
}

/** 로그인만 요구 (가드에 이미 체크되어 있지만 명시적으로 쓰고 싶을 때) */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function getCurrentUser(req) {
  return req.user || null;
}

// ── 라우트 핸들러 ──

/** POST /api/auth/login — 유저 또는 레거시 로그인 */
async function loginHandler(req, res) {
  const { username, password } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: '비밀번호를 입력하세요' });
  }

  // Case A: username 제공 → 유저 로그인
  if (username && String(username).trim()) {
    try {
      const user = await userRepo.findByUsername(String(username).trim());
      if (!user) {
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
      }
      if (!user.is_active) {
        return res.status(403).json({ error: '비활성화된 계정입니다. 관리자에게 문의하세요' });
      }
      const ok = await userRepo.verifyPassword(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
      }

      userRepo.touchLastLogin(user.id).catch(() => {});
      setSessionCookie(res, user.id);
      return res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
          isAdmin: user.role === 'admin',
        },
      });
    } catch (err) {
      console.error('[Auth] 유저 로그인 실패:', err.message);
      return res.status(500).json({ error: '로그인 처리 중 오류' });
    }
  }

  // Case B: username 없음 → 레거시 공유 비번 로그인
  const expected = getSharedPassword();
  if (!expected) {
    return res.status(401).json({ error: '아이디가 필요합니다' });
  }
  if (password !== expected) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다' });
  }

  setSessionCookie(res, LEGACY_USER_ID);
  return res.json({
    success: true,
    legacy: true,
    user: { id: 0, username: '__legacy_admin__', displayName: '관리자 (레거시)', role: 'admin', isAdmin: true },
  });
}

/** POST /api/auth/logout */
function logoutHandler(req, res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
}

/** GET /api/auth/me — 현재 로그인 유저 정보 */
function meHandler(req, res) {
  if (!req.user) return res.json({ user: null });
  const { id, username, displayName, role, isAdmin, platform, uiMode, isLegacy } = req.user;
  res.json({ user: { id, username, displayName, role, isAdmin, platform, uiMode, isLegacy } });
}

/** PATCH /api/auth/change-password — 본인 비밀번호 변경 */
async function changePasswordHandler(req, res) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  if (req.user.isLegacy) {
    return res.status(400).json({ error: '레거시 관리자 계정은 비밀번호를 변경할 수 없습니다. 신규 계정으로 로그인하세요' });
  }

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 입력하세요' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: '기존과 다른 비밀번호를 입력하세요' });
  }

  try {
    const user = await userRepo.findByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: '계정을 찾을 수 없습니다' });

    const ok = await userRepo.verifyPassword(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다' });

    const hash = await userRepo.hashPassword(newPassword);
    await userRepo.updatePassword(user.id, hash);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] 비밀번호 변경 실패:', err.message);
    return res.status(500).json({ error: '비밀번호 변경 중 오류' });
  }
}

/** PATCH /api/admin/reset-password/:userId — admin이 직원 비번 초기화 */
async function adminResetPasswordHandler(req, res) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  }

  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(targetId)) {
    return res.status(400).json({ error: 'userId가 올바르지 않습니다' });
  }

  try {
    const target = await userRepo.findById(targetId);
    if (!target) return res.status(404).json({ error: '직원을 찾을 수 없습니다' });

    const tempPassword = userRepo.generateTempPassword();
    const hash = await userRepo.hashPassword(tempPassword);
    await userRepo.updatePassword(targetId, hash);

    return res.json({
      success: true,
      tempPassword,
      user: { id: target.id, username: target.username, displayName: target.display_name },
      message: '임시 비밀번호가 발급되었습니다. 직원에게 전달 후 첫 로그인 시 변경하도록 안내하세요',
    });
  } catch (err) {
    console.error('[Auth] 비밀번호 초기화 실패:', err.message);
    return res.status(500).json({ error: '비밀번호 초기화 중 오류' });
  }
}

module.exports = {
  // 미들웨어
  authGuard,
  requireAdmin,
  requireFinanceAccess,
  requireAuth,
  blockLegacyWrites,
  getCurrentUser,
  // 핸들러
  loginHandler,
  logoutHandler,
  meHandler,
  changePasswordHandler,
  adminResetPasswordHandler,
};
