const fs0 = require('fs');
if (fs0.existsSync('./config/.env')) {
  require('dotenv').config({ path: './config/.env' });
}
// Railway: write credentials.json from env var if file doesn't exist
if (process.env.GOOGLE_CREDENTIALS && !fs0.existsSync('./config/credentials.json')) {
  fs0.mkdirSync('./config', { recursive: true });
  fs0.writeFileSync('./config/credentials.json', process.env.GOOGLE_CREDENTIALS);
}
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const {
  authGuard,
  blockLegacyWrites,
  loginHandler,
  logoutHandler,
  meHandler,
  changePasswordHandler,
  adminResetPasswordHandler,
} = require('./src/middleware/auth');

const app = express();
app.set('trust proxy', 1); // Railway runs behind a reverse proxy
const PORT = process.env.PORT || 3000;
const AUTO_PORT = process.env.AUTO_PORT || 3001;
const AUTO_SERVICE_URL = process.env.AUTO_SERVICE_URL || `http://localhost:${AUTO_PORT}`;

// uploads 디렉토리 생성
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Security middleware
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for inline scripts
app.use(cookieParser());
app.use(express.json());

// ── Rate limiting (사장님 요청 2026-05) ──
//
// 이전: /api/auth/* 광역 (15분 20회 IP 단독) — 직원 공용 PC 환경에서 /api/auth/me 가 페이지 새로고침마다
//      카운트되어 빠르게 도달 + 한 직원 실패가 전체 직원 막음.
// 변경: POST /api/auth/login 에만 좁힘. me/logout/change-password 등은 일반 /api/ 한도만 적용.
//      key = username + IP 조합 (공용 PC 보호). 성공은 카운트 X. dev 환경 완화. 차단 응답에 retryAfterSeconds.
const IS_DEV = process.env.NODE_ENV === 'development';
const LOGIN_WINDOW_MS = 5 * 60 * 1000;          // 5분
const LOGIN_MAX = IS_DEV ? 100 : 10;            // 운영 10회, dev 100회 (사실상 비활성)

const loginRateLimit = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX,
  skipSuccessfulRequests: true,                  // 성공 시 카운트 X
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const u = String(req.body?.username || '').trim().toLowerCase();
    return u ? `${u}|${req.ip}` : req.ip;        // username 있으면 조합, 없으면 IP only
  },
  handler: (req, res /*, next, options */) => {
    const retryAfterSeconds = Math.ceil(LOGIN_WINDOW_MS / 1000);
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: '로그인 시도가 많습니다. 약 ' + Math.ceil(retryAfterSeconds / 60) + '분 후 다시 시도하세요.',
      retryAfterSeconds,
    });
  },
});

// 일반 /api/ rate limit — auth 외 모든 endpoint (me / logout / change-password 등 포함)
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Auth routes (before guard) — POST /login 만 별 limit, logout 은 일반 한도만
app.post('/api/auth/login', loginRateLimit, loginHandler);
app.post('/api/auth/logout', logoutHandler);

// Auth guard — protects everything below
app.use(authGuard);

// 레거시 관리자 계정은 업무관리 쓰기 차단 (users FK 제약)
app.use(blockLegacyWrites);

// Auth routes (guard 이후 — req.user 필요)
app.get('/api/auth/me', meHandler);
app.patch('/api/auth/change-password', changePasswordHandler);
app.patch('/api/admin/reset-password/:userId', adminResetPasswordHandler);

app.use(express.static(path.join(__dirname, 'public')));

// ccorea-auto automation server proxy (kept for future API integration)
app.use('/api/auto', createProxyMiddleware({
  target: `${AUTO_SERVICE_URL}/api`,
  pathRewrite: { '^/api/auto': '' },
  changeOrigin: true,
  onProxyRes: (proxyRes) => {
    proxyRes.headers['X-Accel-Buffering'] = 'no';
  },
  onError: (err, req, res) => {
    res.status(502).json({ error: 'Automation server unavailable', detail: err.message });
  }
}));

const apiRoutes = require('./src/web/routes/api');
app.use('/api', apiRoutes);

const opsRoutes = require('./src/web/routes/operations');
app.use('/api/ops', opsRoutes);

// ── 업무관리 모듈 (Phase 1) ──
app.use('/api/users', require('./src/web/routes/users'));
app.use('/api/tasks/:id/comments', require('./src/web/routes/taskComments'));
app.use('/api/tasks', require('./src/web/routes/tasks'));
app.use('/api/notifications', require('./src/web/routes/notifications'));
// WMS Phase 1 — SKU master + 자동 예외 라우팅 (모두 admin 전용)
// PR P-1A-B: 발주 폼 SKU autocomplete (read-only, 모든 직원). /api/sku-master 보다 먼저 mount 필요.
app.use('/api/sku-master/search', require('./src/web/routes/skuMasterSearch'));
app.use('/api/sku-master', require('./src/web/routes/skuMaster'));
app.use('/api/exception-routing', require('./src/web/routes/exceptionRouting'));
// WMS Phase 2 — Order import + matching (admin 전용)
// 주의: /api/orders/mock-import 가 /api/orders/:id 보다 먼저 등록돼야 함 (path specificity).
app.use('/api/orders/mock-import', require('./src/web/routes/mockOrderImport'));
app.use('/api/orders', require('./src/web/routes/orders'));
// Phase 3 PR M — Safety Foundation 실행 로그 read API (admin / staff 동일 가시성)
app.use('/api/safety-runs', require('./src/web/routes/safetyRuns'));
// PR O1 — Daily Operations Briefing (오늘 운영 요약 read-only)
app.use('/api/ops-briefing', require('./src/web/routes/operationsBriefing'));
// PR R0 — Opportunity Inbox (직원/admin 후보 등록 + 사장님 검토)
app.use('/api/opportunity-inbox', require('./src/web/routes/opportunityInbox'));
// PR R1 — AI Draft Generator (opportunity → AI 가 platform 별 title/description 생성)
app.use('/api/opportunity-drafts', require('./src/web/routes/opportunityDrafts'));

// ── 발주 관리 (Phase 2) ──
app.use('/api/purchase-requests', require('./src/web/routes/purchaseRequests'));

// ── 출퇴근 + 급여 + Shopee 보너스 (Phase 3) ──
app.use('/api/attendance', require('./src/web/routes/attendance'));
// PR W-G2-B: 2주 급여 확정 — /api/payroll 보다 먼저 mount (`/periods` 가 `/:employeeId` 에 잡히지 않게)
app.use('/api/payroll/periods', require('./src/web/routes/payrollPeriods'));
// Phase 2B: 배송사 추천 (DB 변경 없음, 추천 결과 매번 계산)
app.use('/api/shipping/recommendations', require('./src/web/routes/shippingRecommendations'));
app.use('/api/payroll', require('./src/web/routes/payroll'));
app.use('/api/bonuses', require('./src/web/routes/bonuses'));

// ── 피드백 게시판 (Phase 4) ──
app.use('/api/feedback', require('./src/web/routes/feedback'));
app.use('/api/sync', require('./src/web/routes/platformSync'));
app.use('/api/catalog', require('./src/web/routes/catalog'));
app.use('/api/events', require('./src/web/routes/events'));
app.use('/api/workspace', require('./src/web/routes/workspace'));
app.use('/api/expenses', require('./src/web/routes/expenses'));
app.use('/api/recurring', require('./src/web/routes/recurring'));
app.use('/api/inventory-purchases', require('./src/web/routes/inventoryPurchases'));
app.use('/api/finance', require('./src/web/routes/finance'));
app.use('/api/weekly-plans', require('./src/web/routes/weeklyPlans'));
app.use('/api/weekly-meetings', require('./src/web/routes/weeklyMeetings'));
app.use('/api/competitors', require('./src/web/routes/competitors'));
app.use('/api/prospects', require('./src/web/routes/prospects'));
app.use('/api/health', require('./src/web/routes/health'));
app.use('/api/stocktake', require('./src/web/routes/stocktake'));
app.use('/api/cs', require('./src/web/routes/cs'));
app.use('/api/resources', require('./src/web/routes/resources'));
app.use('/api/accio', require('./src/web/routes/accio'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPMC 대시보드 서버: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api\n`);

  // 업무관리 알림 스케줄러 (Phase 5 — 매일 오전 9시, 오후 5시)
  require('./src/services/scheduler').start();

  // Load tokens from DB into process.env on startup
  const { loadToken } = require('./src/services/tokenStore');
  (async () => {
    const platforms = [
      { name: 'ebay', envKeys: { accessToken: 'EBAY_USER_TOKEN' } },
      { name: 'shopee', envKeys: { accessToken: 'SHOPEE_ACCESS_TOKEN', refreshToken: 'SHOPEE_REFRESH_TOKEN' } },
      { name: 'shopee_shop', envKeys: { accessToken: 'SHOPEE_SHOP_ACCESS_TOKEN', refreshToken: 'SHOPEE_SHOP_REFRESH_TOKEN' } },
      { name: 'alibaba', envKeys: { accessToken: 'ALIBABA_ACCESS_TOKEN', refreshToken: 'ALIBABA_REFRESH_TOKEN' } },
    ];
    for (const p of platforms) {
      const token = await loadToken(p.name);
      if (token) {
        if (token.accessToken && p.envKeys.accessToken) process.env[p.envKeys.accessToken] = token.accessToken;
        if (token.refreshToken && p.envKeys.refreshToken) process.env[p.envKeys.refreshToken] = token.refreshToken;
        console.log(`[TokenStore] ${p.name} token loaded from DB`);
      }
    }
  })().catch(e => console.warn('[TokenStore] DB token load failed:', e.message));

  // OAuth 토큰 자동 갱신 (3시간마다 — Shopee 4h, eBay 2h 만료)
  const { refreshAllTokens } = require('./src/jobs/tokenRefresh');
  refreshAllTokens(); // 서버 시작 시 즉시 1회 실행
  setInterval(refreshAllTokens, 3 * 60 * 60 * 1000); // 이후 3시간마다
  console.log('OAuth 토큰 자동 갱신: 3시간 주기로 실행됨');

  // SKU 점수 자동 업데이트 (매일 02:00)
  const { scheduleSkuScoreUpdate } = require('./src/jobs/collectSkuData');
  const now = new Date();
  const next2AM = new Date(now);
  next2AM.setHours(2, 0, 0, 0);
  if (next2AM <= now) next2AM.setDate(next2AM.getDate() + 1);
  const delay = next2AM - now;
  setTimeout(() => {
    scheduleSkuScoreUpdate();
    setInterval(scheduleSkuScoreUpdate, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`SKU 점수 자동 업데이트: ${next2AM.toLocaleString('ko-KR')} 예약됨`);
});

// Competitor Monitor — every 2 hours (가격·재고 정확도 개선, Browse API 무료)
setInterval(async () => {
  try {
    const { runCompetitorMonitor } = require('./src/services/competitorMonitor');
    const result = await runCompetitorMonitor();
    console.log(`[CompetitorMonitor] ${result.alerts?.length || 0} alerts, ${result.checked || 0} checked`);
  } catch (e) {
    console.error('[CompetitorMonitor] error:', e.message);
  }
}, 2 * 60 * 60 * 1000);

// ===== AI Agent Scheduling (margin / sourcing / operations) =====
// 2026-04 정리: 8개 → 3개. 나머지 5개는 실질 가치 부족으로 제거.
// - margin-agent:     eBay 가격 자동 조정 (auto-approved는 즉시 eBay 반영)
// - sourcing-agent:   경쟁사 배틀 리포트 (텔레그램 알림)
// - operations-agent: 재고/단종 탐지 → team_tasks 자동 생성 (업무관리 화면에 노출)

// Margin Agent — every 4 hours
setInterval(async () => {
  try {
    const { MarginAgent } = require('./src/agents/margin-agent');
    const recs = await new MarginAgent().run();
    console.log(`[MarginAgent] ${recs.length} recommendations`);
  } catch (e) { console.error('[MarginAgent] error:', e.message); }
}, 4 * 60 * 60 * 1000);

// Daily agents
const scheduleDaily = (hour, name, factory) => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    (async () => { try { await factory(); } catch (e) { console.error(`[${name}] error:`, e.message); } })();
    setInterval(async () => { try { await factory(); } catch (e) { console.error(`[${name}] error:`, e.message); } }, 24 * 60 * 60 * 1000);
  }, next - now);
  console.log(`[${name}] 예약: ${next.toLocaleString('ko-KR')}`);
};

scheduleDaily(3, 'SourcingAgent', async () => { const { SourcingAgent } = require('./src/agents/sourcing-agent'); await new SourcingAgent().run(); });
scheduleDaily(6, 'OperationsAgent', async () => { const { OperationsAgent } = require('./src/agents/operations-agent'); await new OperationsAgent().run(); });

console.log('[Agents] active: margin-agent (4h), sourcing-agent (03:00), operations-agent (06:00)');

