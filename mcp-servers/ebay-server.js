#!/usr/bin/env node

/**
 * eBay MCP Server
 * 기존 EbayAPI를 MCP 도구로 래핑하여 Claude가 직접 접근 가능하게 함
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const EbayAPI = require('../src/api/ebayAPI');

const server = new McpServer({
  name: 'pmc-ebay',
  version: '1.0.0',
});

let ebayApi = null;

function getApi() {
  if (!ebayApi) {
    ebayApi = new EbayAPI();
  }
  return ebayApi;
}

// eBay 활성 리스팅 조회
server.tool(
  'ebay_get_active_listings',
  'eBay 활성 리스팅 목록을 가져옵니다',
  {
    page: z.number().optional().describe('페이지 번호 (1부터)'),
    per_page: z.number().optional().describe('페이지당 항목 수 (최대 200)'),
  },
  async ({ page, per_page }) => {
    try {
      const api = getApi();
      const pageNum = page || 1;
      const entriesPerPage = per_page || 100;

      const result = await api.callTradingAPI('GetMyeBaySelling', `
        <ActiveList>
          <Sort>TimeLeft</Sort>
          <Pagination>
            <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
            <PageNumber>${pageNum}</PageNumber>
          </Pagination>
        </ActiveList>
        <DetailLevel>ReturnAll</DetailLevel>
      `);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// eBay 가격 수정 — Phase 1 Commit 10 (fail-closed / DISABLED)
//   Owner directive (2026-08-10):
//     "AI/MCP가 독립적으로 가격 변경을 요청한다면 MANUAL_APPROVED 사용 금지"
//     "안전한 기존 인증 경로가 없으면 MCP update_price를 fail-closed/disabled
//      상태로 만드는 방안을 우선 제안"
//     "새로운 대형 auth framework 도입 금지"
//
//   Investigation summary (전제 4개, 모두 STOP CONDITION):
//     1. Caller = AI(Claude MCP client). No authenticated human approval.
//        → MANUAL_APPROVED 사용 불가.
//     2. No MCP → backend service-to-service auth path exists.
//     3. MCP SDK does not expose a stable tool-call id → idempotency
//        key cannot be safely derived (randomUUID would fail duplicate-
//        retry protection).
//     4. Enabling this path bypasses PriceExecutionGate entirely.
//
//   Decision: refuse every call. The tool signature stays so MCP clients
//   still discover it — but the handler returns a machine-readable error
//   that names the missing prerequisites. Re-enabling requires (a) a
//   verified service-to-service auth path, (b) a durable tool-call id
//   flowing through, and (c) an owner-approved backend endpoint that
//   itself calls PriceExecutionGate.
server.tool(
  'ebay_update_price',
  'eBay 리스팅 가격을 수정합니다 (현재 DISABLED — safety gate 우회 방지)',
  {
    item_id: z.string().describe('eBay Item ID'),
    new_price: z.string().describe('새 가격 (예: "29.99")'),
    currency: z.string().optional().describe('통화 (기본: USD)'),
  },
  async ({ item_id, new_price, currency }) => {
    const reason = 'MCP_PRICE_MUTATION_DISABLED';
    const detail = [
      `eBay 가격 변경 요청을 거부했습니다 (${reason}).`,
      `Item ${item_id}, ${currency || 'USD'} ${new_price}.`,
      '이유: MCP client (AI) 는 PriceExecutionGate 를 우회하지 않는 인증된 backend 경로가 없어',
      'Phase 1 Commit 10 (2026-08-10) 이후 fail-closed 상태입니다.',
      '재활성화 조건: (1) MCP→backend 서비스 인증, (2) tool-call id 기반 idempotency,',
      '(3) 소유자가 승인한 gated endpoint 신설.',
      '수동 가격 변경은 PMC 웹에서 [🔥 즉시 반영] 버튼을 사용하세요.',
    ].join(' ');
    return {
      content: [{ type: 'text', text: detail }],
      isError: true,
    };
  }
);

// eBay 판매 현황 요약
server.tool(
  'ebay_get_sales_summary',
  'eBay 최근 30일 판매 현황 요약',
  {},
  async () => {
    try {
      const api = getApi();
      const result = await api.callTradingAPI('GetMyeBaySelling', `
        <SoldList>
          <DurationInDays>30</DurationInDays>
          <Pagination>
            <EntriesPerPage>50</EntriesPerPage>
            <PageNumber>1</PageNumber>
          </Pagination>
        </SoldList>
      `);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('eBay MCP Server running on stdio');
}

main().catch(console.error);
