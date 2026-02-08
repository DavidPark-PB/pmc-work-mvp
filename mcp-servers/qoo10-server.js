#!/usr/bin/env node

/**
 * Qoo10 Japan MCP Server
 * 일본 시장 관리: 상품, 가격, 재고, 주문, 판매현황
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const Qoo10API = require('../src/api/qoo10API');

const server = new McpServer({
  name: 'pmc-qoo10',
  version: '1.0.0',
});

let api = null;

function getApi() {
  if (!api) {
    api = new Qoo10API();
  }
  return api;
}

// 상품 목록 조회
server.tool(
  'qoo10_get_products',
  'Qoo10 Japan 전체 상품 목록을 가져옵니다',
  {
    page: z.number().optional().describe('페이지 번호 (기본 1)'),
    page_size: z.number().optional().describe('페이지 크기 (최대 100)'),
  },
  async ({ page, page_size }) => {
    try {
      const qoo10 = getApi();
      const result = await qoo10.getProducts(page || 1, page_size || 100);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Qoo10 상품 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 상품 상세
server.tool(
  'qoo10_get_product_detail',
  'Qoo10 Japan 상품 상세 정보를 가져옵니다',
  {
    item_code: z.string().describe('Qoo10 상품 코드'),
  },
  async ({ item_code }) => {
    try {
      const qoo10 = getApi();
      const result = await qoo10.getProductDetail(item_code);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `상세 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 가격 수정
server.tool(
  'qoo10_update_price',
  'Qoo10 Japan 상품 가격을 수정합니다 (엔화)',
  {
    item_code: z.string().describe('상품 코드'),
    price: z.number().describe('새 가격 (JPY)'),
  },
  async ({ item_code, price }) => {
    try {
      const qoo10 = getApi();
      const result = await qoo10.updatePrice(item_code, price);

      return {
        content: [{
          type: 'text',
          text: `Qoo10 가격 업데이트 완료: ${item_code} → ¥${price}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `가격 수정 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 재고 수정
server.tool(
  'qoo10_update_stock',
  'Qoo10 Japan 상품 재고를 수정합니다',
  {
    item_code: z.string().describe('상품 코드'),
    quantity: z.number().describe('새 재고 수량'),
  },
  async ({ item_code, quantity }) => {
    try {
      const qoo10 = getApi();
      const result = await qoo10.updateStock(item_code, quantity);

      return {
        content: [{
          type: 'text',
          text: `Qoo10 재고 업데이트 완료: ${item_code} → ${quantity}개`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `재고 수정 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 주문 조회
server.tool(
  'qoo10_get_orders',
  'Qoo10 Japan 최근 주문 목록을 가져옵니다',
  {
    days: z.number().optional().describe('최근 N일 (기본 7)'),
  },
  async ({ days }) => {
    try {
      const qoo10 = getApi();
      const now = new Date();
      const startDate = new Date(now.getTime() - (days || 7) * 24 * 60 * 60 * 1000);
      const result = await qoo10.getOrders(
        startDate.toISOString().split('T')[0],
        now.toISOString().split('T')[0]
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `주문 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 판매 현황
server.tool(
  'qoo10_get_sales_summary',
  'Qoo10 Japan 판매 현황 요약',
  {
    days: z.number().optional().describe('최근 N일 (기본 30)'),
  },
  async ({ days }) => {
    try {
      const qoo10 = getApi();
      const result = await qoo10.getSalesSummary(days || 30);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `판매현황 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Qoo10 Japan MCP Server running on stdio');
}

main().catch(console.error);
