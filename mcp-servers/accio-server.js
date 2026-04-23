#!/usr/bin/env node

/**
 * Accio Gateway MCP bridge — translates stdio MCP JSON-RPC to Accio Work's
 * local REST API at http://127.0.0.1:${ACCIO_PORT}/mcp/proxy.
 *
 * Accio Desktop (Electron app) must be running. The bridge fetches the tool
 * catalog once at startup (200+ tools) and forwards tools/call through.
 *
 * Env:
 *   ACCIO_PORT             Gateway port (default 4097).
 *   ACCIO_REFRESH_ON_CALL  If "1", re-fetches tool catalog before each call
 *                          so newly-connected toolkits appear without restart.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const PORT = process.env.ACCIO_PORT || '4097';
const BASE = `http://127.0.0.1:${PORT}/mcp/proxy`;
const REFRESH_ON_CALL = process.env.ACCIO_REFRESH_ON_CALL === '1';

function friendlyFetchError(err) {
  const msg = String(err?.cause?.code || err?.code || err?.message || err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return 'Accio Desktop 앱이 실행 중이 아닙니다 (localhost:' + PORT + '). 앱을 열어주세요.';
  }
  return msg;
}

async function accioFetch(url, init) {
  try {
    const r = await fetch(url, init);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const text = await r.text();
      throw new Error(`Gateway HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    return r.json();
  } catch (e) {
    throw new Error(friendlyFetchError(e));
  }
}

async function fetchTools(refresh) {
  const url = `${BASE}/tools${refresh ? '?refresh=1' : ''}`;
  const j = await accioFetch(url);
  if (!j.success) throw new Error(j.error?.message || j.error || 'tools fetch failed');
  return j.data?.tools || [];
}

function sanitizeTool(t) {
  const schema = t.inputSchema && typeof t.inputSchema === 'object'
    ? t.inputSchema
    : { type: 'object', properties: {} };
  return {
    name: t.name,
    description: t.description || '',
    inputSchema: schema,
  };
}

let cachedTools = [];

async function main() {
  try {
    cachedTools = await fetchTools(false);
    console.error(`[accio-bridge] ${cachedTools.length} tools loaded from ${BASE}`);
  } catch (e) {
    console.error('[accio-bridge] initial tool fetch failed:', e.message);
    cachedTools = [];
  }

  const server = new Server(
    { name: 'accio', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (cachedTools.length === 0) {
      try { cachedTools = await fetchTools(false); } catch (e) {
        return { tools: [], _meta: { error: e.message } };
      }
    }
    return { tools: cachedTools.map(sanitizeTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (REFRESH_ON_CALL) {
      try { cachedTools = await fetchTools(true); } catch {}
    }
    let res;
    try {
      res = await accioFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: args || {} }),
      });
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
    if (!res.success) {
      const msg = res.error?.message || res.error || 'Accio call failed';
      return { isError: true, content: [{ type: 'text', text: String(msg) }] };
    }
    const payload = res.data?.result?.content || res.data?.content;
    if (Array.isArray(payload) && payload.length > 0) return { content: payload };
    return { content: [{ type: 'text', text: JSON.stringify(res.data ?? res, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[accio-bridge] ready');
}

main().catch(err => {
  console.error('[accio-bridge] fatal:', err);
  process.exit(1);
});
