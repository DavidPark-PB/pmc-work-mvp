#!/usr/bin/env node

/**
 * 쿠팡 MCP Server
 * 쿠팡 WING API 연동: 상품, 가격, 재고, 주문 관리
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const CoupangAPI = require('../src/api/coupangAPI');

const server = new McpServer({
  name: 'pmc-coupang',
  version: '1.0.0',
});

let api = null;

function getApi() {
  if (!api) {
    api = new CoupangAPI();
  }
  return api;
}

// 상품 목록 조회
server.tool(
  'coupang_get_products',
  '쿠팡 전체 상품 목록을 가져옵니다',
  {
    max_per_page: z.number().optional().describe('페이지당 항목 수 (최대 100)'),
  },
  async ({ max_per_page }) => {
    try {
      const coupang = getApi();
      const result = await coupang.getProducts(null, max_per_page || 100);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `쿠팡 상품 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 상품 상세
server.tool(
  'coupang_get_product_detail',
  '쿠팡 상품 상세 정보를 가져옵니다',
  {
    seller_product_id: z.number().describe('셀러 상품 ID'),
  },
  async ({ seller_product_id }) => {
    try {
      const coupang = getApi();
      const result = await coupang.getProductDetail(seller_product_id);

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
  'coupang_update_price',
  '쿠팡 상품 가격을 수정합니다 (KRW)',
  {
    seller_product_id: z.number().describe('셀러 상품 ID'),
    price: z.number().describe('새 가격 (원)'),
  },
  async ({ seller_product_id, price }) => {
    try {
      const coupang = getApi();
      const result = await coupang.updatePrice(seller_product_id, [{ salePrice: price }]);

      return {
        content: [{
          type: 'text',
          text: `쿠팡 가격 업데이트 완료: ${seller_product_id} → ₩${price.toLocaleString()}`,
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
  'coupang_update_stock',
  '쿠팡 상품 재고를 수정합니다',
  {
    seller_product_id: z.number().describe('셀러 상품 ID'),
    quantity: z.number().describe('새 재고 수량'),
  },
  async ({ seller_product_id, quantity }) => {
    try {
      const coupang = getApi();
      const result = await coupang.updateStock(seller_product_id, [{ quantity }]);

      return {
        content: [{
          type: 'text',
          text: `쿠팡 재고 업데이트 완료: ${seller_product_id} → ${quantity}개`,
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
  'coupang_get_orders',
  '쿠팡 최근 주문 목록을 가져옵니다',
  {
    status: z.string().optional().describe('주문 상태 (ACCEPT, INSTRUCT, DEPARTURE 등)'),
    days: z.number().optional().describe('최근 N일 (기본 7)'),
  },
  async ({ status, days }) => {
    try {
      const coupang = getApi();
      const now = new Date();
      const from = new Date(now.getTime() - (days || 7) * 24 * 60 * 60 * 1000);
      const result = await coupang.getOrders(
        status || 'ACCEPT',
        from.toISOString(),
        now.toISOString()
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

// 반품 조회
server.tool(
  'coupang_get_returns',
  '쿠팡 반품 요청 목록을 가져옵니다',
  {},
  async () => {
    try {
      const coupang = getApi();
      const result = await coupang.getReturns();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `반품 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Coupang MCP Server running on stdio');
}

main().catch(console.error);
