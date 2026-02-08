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

// eBay 가격 수정
server.tool(
  'ebay_update_price',
  'eBay 리스팅 가격을 수정합니다',
  {
    item_id: z.string().describe('eBay Item ID'),
    new_price: z.string().describe('새 가격 (예: "29.99")'),
    currency: z.string().optional().describe('통화 (기본: USD)'),
  },
  async ({ item_id, new_price, currency }) => {
    try {
      const api = getApi();
      const result = await api.callTradingAPI('ReviseFixedPriceItem', `
        <Item>
          <ItemID>${item_id}</ItemID>
          <StartPrice currencyID="${currency || 'USD'}">${new_price}</StartPrice>
        </Item>
      `);

      return {
        content: [{
          type: 'text',
          text: `eBay 가격 업데이트 완료: Item ${item_id} → $${new_price}`,
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
