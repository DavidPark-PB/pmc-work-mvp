#!/usr/bin/env node

/**
 * 네이버 스마트스토어 MCP Server
 * 네이버 커머스 API 연동: 상품, 가격, 재고, 주문, 판매통계
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const NaverAPI = require('../src/api/naverAPI');

const server = new McpServer({
  name: 'pmc-naver',
  version: '1.0.0',
});

let api = null;

function getApi() {
  if (!api) {
    api = new NaverAPI();
  }
  return api;
}

// 상품 목록 조회
server.tool(
  'naver_get_products',
  '스마트스토어 상품 목록을 가져옵니다',
  {
    page: z.number().optional().describe('페이지 번호 (기본 1)'),
    size: z.number().optional().describe('페이지 크기 (최대 100)'),
  },
  async ({ page, size }) => {
    try {
      const naver = getApi();
      const result = await naver.getProducts(page || 1, size || 100);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `스마트스토어 상품 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 상품 상세
server.tool(
  'naver_get_product_detail',
  '스마트스토어 상품 상세 정보를 가져옵니다',
  {
    channel_product_no: z.string().describe('채널 상품번호'),
  },
  async ({ channel_product_no }) => {
    try {
      const naver = getApi();
      const result = await naver.getProductDetail(channel_product_no);

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
  'naver_update_price',
  '스마트스토어 상품 가격을 수정합니다 (KRW)',
  {
    origin_product_no: z.string().describe('원상품 번호'),
    price: z.number().describe('새 가격 (원)'),
  },
  async ({ origin_product_no, price }) => {
    try {
      const naver = getApi();
      const result = await naver.updatePrice(null, origin_product_no, price);

      return {
        content: [{
          type: 'text',
          text: `스마트스토어 가격 업데이트 완료: ${origin_product_no} → ₩${price.toLocaleString()}`,
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
  'naver_update_stock',
  '스마트스토어 상품 재고를 수정합니다',
  {
    origin_product_no: z.string().describe('원상품 번호'),
    quantity: z.number().describe('새 재고 수량'),
  },
  async ({ origin_product_no, quantity }) => {
    try {
      const naver = getApi();
      const result = await naver.updateStock(origin_product_no, quantity);

      return {
        content: [{
          type: 'text',
          text: `스마트스토어 재고 업데이트 완료: ${origin_product_no} → ${quantity}개`,
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
  'naver_get_orders',
  '스마트스토어 최근 주문 목록을 가져옵니다',
  {
    days: z.number().optional().describe('최근 N일 (기본 7)'),
  },
  async ({ days }) => {
    try {
      const naver = getApi();
      const now = new Date();
      const from = new Date(now.getTime() - (days || 7) * 24 * 60 * 60 * 1000);
      const result = await naver.getOrders('PAYED', from.toISOString());

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

// 판매 통계
server.tool(
  'naver_get_sales_stats',
  '스마트스토어 판매 통계를 가져옵니다',
  {
    days: z.number().optional().describe('최근 N일 (기본 30)'),
  },
  async ({ days }) => {
    try {
      const naver = getApi();
      const now = new Date();
      const from = new Date(now.getTime() - (days || 30) * 24 * 60 * 60 * 1000);
      const result = await naver.getSalesStats(
        from.toISOString().split('T')[0],
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
        content: [{ type: 'text', text: `판매통계 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Naver SmartStore MCP Server running on stdio');
}

main().catch(console.error);
