require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const axios = require('axios');

/**
 * Accio Gateway (localhost Electron app) REST client.
 *
 * Env:
 *   ACCIO_ENABLED=true       활성 (기본 false → Fly.io 프로덕션은 자동 차단)
 *   ACCIO_BASE_URL           기본 http://127.0.0.1:4097
 */
class AccioClient {
  constructor() {
    this.base = (process.env.ACCIO_BASE_URL || 'http://127.0.0.1:4097').replace(/\/$/, '');
    this.enabled = process.env.ACCIO_ENABLED === 'true';
    this._toolsCache = { at: 0, tools: null };
  }

  _wrapErr(err) {
    const code = err?.code || err?.cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      return new Error('Accio Desktop 앱이 실행 중이 아닙니다. 앱을 열어주세요.');
    }
    const body = err?.response?.data;
    if (body?.error) return new Error(typeof body.error === 'string' ? body.error : (body.error.message || JSON.stringify(body.error)));
    return err;
  }

  async health() {
    if (!this.enabled) return { enabled: false };
    try {
      const r = await axios.get(`${this.base}/health`, { timeout: 3000 });
      return { enabled: true, healthy: r.data?.healthy === true, uptime: r.data?.uptime };
    } catch (e) {
      return { enabled: true, healthy: false, error: this._wrapErr(e).message };
    }
  }

  async listTools({ refresh = false } = {}) {
    if (!this.enabled) throw new Error('Accio 비활성화 — config/.env 의 ACCIO_ENABLED=true 로 설정하세요.');
    const now = Date.now();
    if (!refresh && this._toolsCache.tools && now - this._toolsCache.at < 5 * 60 * 1000) {
      return this._toolsCache.tools;
    }
    try {
      const r = await axios.get(`${this.base}/mcp/proxy/tools`, { timeout: 10000 });
      if (!r.data?.success) throw new Error(r.data?.error?.message || 'tools fetch failed');
      const tools = r.data.data?.tools || [];
      this._toolsCache = { at: now, tools };
      return tools;
    } catch (e) { throw this._wrapErr(e); }
  }

  async call(name, args) {
    if (!this.enabled) throw new Error('Accio 비활성화 — config/.env 의 ACCIO_ENABLED=true 로 설정하세요.');
    if (!name) throw new Error('tool name required');
    try {
      const r = await axios.post(this.base + '/mcp/proxy', {
        name,
        arguments: args || {},
      }, { timeout: 60000, headers: { 'Content-Type': 'application/json' } });
      if (!r.data?.success) {
        const msg = r.data?.error?.message || r.data?.error || 'Accio call failed';
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      return r.data.data;
    } catch (e) { throw this._wrapErr(e); }
  }

  /**
   * Accio 응답에서 text content 추출. `result.content[].text` 또는 `content[].text` 에
   * JSON 문자열이 들어있는 경우 많아서 파싱 시도.
   */
  extractJson(data) {
    const content = data?.result?.content || data?.content;
    if (Array.isArray(content) && content.length) {
      const first = content.find(c => c.type === 'text') || content[0];
      const text = first?.text;
      if (typeof text === 'string') {
        try { return JSON.parse(text); } catch { return text; }
      }
    }
    return data;
  }
}

module.exports = new AccioClient();
module.exports.AccioClient = AccioClient;
