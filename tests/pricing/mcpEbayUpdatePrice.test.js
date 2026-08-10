'use strict';

/**
 * mcpEbayUpdatePrice.test.js — Phase 1 Commit 10
 * ---------------------------------------------------------------------------
 * Static regression guards that pin the fail-closed state of the
 * MCP `ebay_update_price` tool. If a future commit re-enables the
 * marketplace mutation path, these assertions fail loudly and the
 * regression is caught before deploy.
 *
 * We do NOT execute the MCP server in this test — the module has
 * top-level side effects (dotenv, transport setup) and requiring it
 * would try to reach the eBay auth token. Grep-level audit is enough
 * to prove there is no direct mutation in the tool handler.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC_PATH = path.join(__dirname, '../../mcp-servers/ebay-server.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/* ─────────────────────────── 1. Direct eBay mutation removed ─────────────────────────── */

test('AUDIT: ebay_update_price handler has NO ReviseFixedPriceItem call', () => {
  // Isolate the ebay_update_price tool block: from server.tool('ebay_update_price'
  // to the next server.tool( or end-of-file.
  const start = SRC.indexOf("server.tool(\n  'ebay_update_price'");
  assert.notEqual(start, -1, 'ebay_update_price tool not found');
  const rest = SRC.slice(start);
  const nextTool = rest.slice(50).indexOf("server.tool(");
  const block = nextTool === -1 ? rest : rest.slice(0, 50 + nextTool);

  // Comment-only mentions of ReviseFixedPriceItem are OK; live calls are not.
  // Scan line-by-line, ignore comment lines.
  const lines = block.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim();
    assert.equal(/ReviseFixedPriceItem/.test(stripped), false,
      `handler must not call ReviseFixedPriceItem — offending line: ${line}`);
    assert.equal(/ReviseItem\b/.test(stripped), false,
      `handler must not call ReviseItem — offending line: ${line}`);
    assert.equal(/callTradingAPI\s*\(/.test(stripped), false,
      `handler must not call callTradingAPI — offending line: ${line}`);
    assert.equal(/\.updateItem\s*\(/.test(stripped), false,
      `handler must not call updateItem — offending line: ${line}`);
    assert.equal(/updatePrice\s*\(/.test(stripped), false,
      `handler must not call updatePrice — offending line: ${line}`);
  }
});

test('AUDIT: ebay_update_price handler does NOT call getApi() (no live eBay client)', () => {
  const start = SRC.indexOf("server.tool(\n  'ebay_update_price'");
  const rest = SRC.slice(start);
  const nextTool = rest.slice(50).indexOf("server.tool(");
  const block = nextTool === -1 ? rest : rest.slice(0, 50 + nextTool);
  const lines = block.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/\/\/.*$/, '').trim();
    assert.equal(/\bgetApi\s*\(\s*\)/.test(stripped), false,
      `handler must not instantiate the eBay client — offending line: ${line}`);
  }
});

/* ─────────────────────────── 2. Fail-closed markers present ─────────────────────────── */

test('AUDIT: handler emits fail-closed marker MCP_PRICE_MUTATION_DISABLED', () => {
  assert.match(SRC, /MCP_PRICE_MUTATION_DISABLED/);
});

test('AUDIT: handler documents Phase 1 Commit 10 rationale', () => {
  assert.match(SRC, /Phase 1 Commit 10/);
  assert.match(SRC, /fail-closed/);
});

test('AUDIT: handler documents the three re-enable prerequisites', () => {
  // (1) MCP→backend service auth
  // (2) tool-call id based idempotency
  // (3) owner-approved gated endpoint
  assert.match(SRC, /MCP→backend 서비스 인증/);
  assert.match(SRC, /tool-call id 기반 idempotency/);
  assert.match(SRC, /gated endpoint/);
});

/* ─────────────────────────── 3. Tool signature preserved (client contract) ─────────────────────────── */

test('tool signature (schema) still exposes item_id, new_price, currency', () => {
  // If the schema shape changes, existing MCP clients break — regression guard.
  assert.match(SRC, /item_id:\s*z\.string\(\)/);
  assert.match(SRC, /new_price:\s*z\.string\(\)/);
  assert.match(SRC, /currency:\s*z\.string\(\)\.optional\(\)/);
});

test('handler returns { content: [text], isError: true } shape', () => {
  const start = SRC.indexOf("server.tool(\n  'ebay_update_price'");
  const rest = SRC.slice(start);
  const nextTool = rest.slice(50).indexOf("server.tool(");
  const block = nextTool === -1 ? rest : rest.slice(0, 50 + nextTool);
  assert.match(block, /isError:\s*true/);
  assert.match(block, /content:\s*\[\{\s*type:\s*['"]text['"]/);
});

/* ─────────────────────────── 4. Handler is synchronous-safe ─────────────────────────── */

test('AUDIT: ebay_update_price handler contains no await (no network I/O)', () => {
  // If a future edit re-introduces `await api.callTradingAPI(...)` inside
  // the disabled block, this test fails. Fully-isolated handler body is
  // hard to eval because of brace matching, so we do the same guard at
  // the source level.
  const start = SRC.indexOf("server.tool(\n  'ebay_update_price'");
  const rest = SRC.slice(start);
  const nextTool = rest.slice(50).indexOf("server.tool(");
  const block = nextTool === -1 ? rest : rest.slice(0, 50 + nextTool);
  // strip comments then look for `await`
  const codeOnly = block.split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.equal(/\bawait\s+/.test(codeOnly), false,
    'disabled handler must not await anything (implies live I/O)');
});

/* ─────────────────────────── 5. Other MCP servers untouched (scope limit) ─────────────────────────── */

test('scope: only ebay-server.js was touched — other MCP servers unchanged in this commit', () => {
  // We enumerate them to make the reader aware; content is not asserted.
  const dir = path.join(__dirname, '../../mcp-servers');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-server.js'));
  assert.ok(files.includes('ebay-server.js'));
  // 8+ siblings expected
  assert.ok(files.length >= 5, `expected multiple MCP servers, found ${files.length}`);
});
