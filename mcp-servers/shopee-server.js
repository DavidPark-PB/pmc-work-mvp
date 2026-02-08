#!/usr/bin/env node

/**
 * Shopee MCP Server
 * 동남아 시장 관리: 상품, 가격, 재고, 주문 관리
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const ShopeeAPI = require('../src/api/shopeeAPI');

const server = new McpServer({
  name: 'pmc-shopee',
  version: '1.0.0',
});

let api = null;

function getApi() {
  if (!api) {
    api = new ShopeeAPI();
  }
  return api;
}

// 상품 목록 조회
server.tool(
  'shopee_get_products',
  'Shopee 상품 목록을 가져옵니다',
  {
    offset: z.number().optional().describe('시작 위치 (기본 0)'),
    page_size: z.number().optional().describe('페이지 크기 (최대 100)'),
    status: z.string().optional().describe('상품 상태 (NORMAL, BANNED, DELETED)'),
  },
  async ({ offset, page_size, status }) => {
    try {
      const shopee = getApi();
      const result = await shopee.getProducts(offset || 0, page_size || 50, status || 'NORMAL');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Shopee 상품 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 상품 상세
server.tool(
  'shopee_get_product_detail',
  'Shopee 상품 상세 정보를 가져옵니다',
  {
    item_id: z.number().describe('Shopee 상품 ID'),
  },
  async ({ item_id }) => {
    try {
      const shopee = getApi();
      const result = await shopee.getProductDetail(item_id);

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
  'shopee_update_price',
  'Shopee 상품 가격을 수정합니다',
  {
    item_id: z.number().describe('상품 ID'),
    price: z.number().describe('새 가격 (현지 통화)'),
    model_id: z.number().optional().describe('모델(옵션) ID'),
  },
  async ({ item_id, price, model_id }) => {
    try {
      const shopee = getApi();
      const result = await shopee.updatePrice(item_id, model_id || 0, price);

      return {
        content: [{
          type: 'text',
          text: `Shopee 가격 업데이트 완료: Item ${item_id} → ${price}`,
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
  'shopee_update_stock',
  'Shopee 상품 재고를 수정합니다',
  {
    item_id: z.number().describe('상품 ID'),
    stock: z.number().describe('새 재고 수량'),
    model_id: z.number().optional().describe('모델(옵션) ID'),
  },
  async ({ item_id, stock, model_id }) => {
    try {
      const shopee = getApi();
      const result = await shopee.updateStock(item_id, model_id || 0, stock);

      return {
        content: [{
          type: 'text',
          text: `Shopee 재고 업데이트 완료: Item ${item_id} → ${stock}개`,
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
  'shopee_get_orders',
  'Shopee 최근 주문 목록을 가져옵니다',
  {
    days: z.number().optional().describe('최근 N일 (기본 7)'),
    status: z.string().optional().describe('주문 상태 (READY_TO_SHIP, SHIPPED 등)'),
  },
  async ({ days, status }) => {
    try {
      const shopee = getApi();
      const now = Math.floor(Date.now() / 1000);
      const from = now - (days || 7) * 24 * 3600;
      const result = await shopee.getOrders(from, now, status || 'READY_TO_SHIP');

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Shopee MCP Server running on stdio');
}

main().catch(console.error);
