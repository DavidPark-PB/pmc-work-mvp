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
const { authGuard, loginHandler, logoutHandler } = require('./src/middleware/auth');

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

// Rate limiting on auth endpoints
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, try again later' } }));
// General API rate limiting
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Auth routes (before guard)
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/logout', logoutHandler);

// Auth guard — protects everything below
app.use(authGuard);

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPMC 대시보드 서버: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api\n`);

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

// Competitor Monitor — every 6 hours (Browse API only, no Shopping API rate limit issues)
setInterval(async () => {
  try {
    const { runCompetitorMonitor } = require('./src/services/competitorMonitor');
    const result = await runCompetitorMonitor();
    console.log(`[CompetitorMonitor] ${result.alerts?.length || 0} alerts, ${result.checked || 0} checked`);
  } catch (e) {
    console.error('[CompetitorMonitor] error:', e.message);
  }
}, 6 * 60 * 60 * 1000);

// ===== AI Agent Team Scheduling =====
// Agents use Supabase + eBay API only (no Google Sheets dependency)

// Margin Agent — every 4 hours
setInterval(async () => {
  try {
    const { MarginAgent } = require('./src/agents/margin-agent');
    const recs = await new MarginAgent().run();
    console.log(`[MarginAgent] ${recs.length} recommendations`);
  } catch (e) { console.error('[MarginAgent] error:', e.message); }
}, 4 * 60 * 60 * 1000);

// Profit Brain — every 4 hours, offset 30min
setTimeout(() => {
  setInterval(async () => {
    try {
      const { ProfitBrainAgent } = require('./src/agents/profit-brain');
      const recs = await new ProfitBrainAgent().run();
      console.log(`[ProfitBrain] ${recs.length} recommendations`);
    } catch (e) { console.error('[ProfitBrain] error:', e.message); }
  }, 4 * 60 * 60 * 1000);
}, 30 * 60 * 1000);

// CS Agent — every 30 minutes
setInterval(async () => {
  try {
    const { CSAgent } = require('./src/agents/cs-agent');
    const recs = await new CSAgent().run();
    if (recs.length > 0) console.log(`[CSAgent] ${recs.length} drafts ready`);
  } catch (e) { console.error('[CSAgent] error:', e.message); }
}, 30 * 60 * 1000);

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
scheduleDaily(8, 'StrategyAgent', async () => { const { StrategyAgent } = require('./src/agents/strategy-agent'); await new StrategyAgent().run(); });
scheduleDaily(9, 'SalesAgent', async () => { const { SalesAgent } = require('./src/agents/sales-agent'); await new SalesAgent().run(); });

console.log('[Agents] All AI agents active (Supabase + eBay API only, no Google Sheets)');

