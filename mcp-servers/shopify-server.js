#!/usr/bin/env node

/**
 * Shopify MCP Server
 * 기존 ShopifyAPI를 MCP 도구로 래핑하여 Claude가 직접 접근 가능하게 함
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

// 환경변수 로드
require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const ShopifyAPI = require('../src/api/shopifyAPI');

const server = new McpServer({
  name: 'pmc-shopify',
  version: '1.0.0',
});

let shopifyApi = null;

function getApi() {
  if (!shopifyApi) {
    shopifyApi = new ShopifyAPI();
  }
  return shopifyApi;
}

// 전체 상품 목록 조회
server.tool(
  'shopify_get_products',
  '쇼피파이 전체 상품 목록을 가져옵니다 (SKU, 제목, 가격, 재고 포함)',
  {
    limit: z.number().optional().describe('한 번에 가져올 상품 수 (최대 250)'),
  },
  async ({ limit }) => {
    try {
      const api = getApi();
      const products = await api.getAllProducts(limit || 250);

      const summary = products.map(p => ({
        id: p.id,
        title: p.title,
        status: p.status,
        variants: p.variants?.map(v => ({
          sku: v.sku,
          price: v.price,
          inventory_quantity: v.inventory_quantity,
        })),
        created_at: p.created_at,
        updated_at: p.updated_at,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: products.length,
            products: summary.slice(0, 50),
            note: products.length > 50 ? `${products.length - 50}개 추가 상품 있음` : undefined,
          }, null, 2),
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

// 상품 검색
server.tool(
  'shopify_search_products',
  '쇼피파이에서 상품을 검색합니다 (제목, SKU 기준)',
  {
    query: z.string().describe('검색어 (상품 제목 또는 SKU)'),
  },
  async ({ query }) => {
    try {
      const api = getApi();
      const products = await api.getAllProducts(250);

      const filtered = products.filter(p =>
        p.title?.toLowerCase().includes(query.toLowerCase()) ||
        p.variants?.some(v => v.sku?.toLowerCase().includes(query.toLowerCase()))
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            found: filtered.length,
            products: filtered.map(p => ({
              id: p.id,
              title: p.title,
              variants: p.variants?.map(v => ({
                sku: v.sku,
                price: v.price,
                inventory_quantity: v.inventory_quantity,
              })),
            })),
          }, null, 2),
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

// 상품 가격 수정
server.tool(
  'shopify_update_price',
  '쇼피파이 상품의 판매 가격을 수정합니다',
  {
    product_id: z.number().describe('상품 ID'),
    variant_id: z.number().describe('변형(variant) ID'),
    new_price: z.string().describe('새 가격 (예: "29.99")'),
  },
  async ({ product_id, variant_id, new_price }) => {
    try {
      const api = getApi();
      const result = await api.updateVariant(variant_id, { price: new_price });
      return {
        content: [{
          type: 'text',
          text: `가격 업데이트 완료: Product ${product_id}, Variant ${variant_id} → $${new_price}`,
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

// 재고 현황 조회
server.tool(
  'shopify_get_inventory_summary',
  '쇼피파이 재고 현황 요약 (품절/저재고/정상 분류)',
  {},
  async () => {
    try {
      const api = getApi();
      const products = await api.getAllProducts(250);

      let outOfStock = 0;
      let lowStock = 0;
      let normal = 0;
      const outOfStockItems = [];

      products.forEach(p => {
        p.variants?.forEach(v => {
          const qty = v.inventory_quantity || 0;
          if (qty === 0) {
            outOfStock++;
            outOfStockItems.push({ title: p.title, sku: v.sku });
          } else if (qty < 5) {
            lowStock++;
          } else {
            normal++;
          }
        });
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: {
              total_products: products.length,
              out_of_stock: outOfStock,
              low_stock: lowStock,
              normal: normal,
            },
            out_of_stock_items: outOfStockItems.slice(0, 20),
          }, null, 2),
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
  console.error('Shopify MCP Server running on stdio');
}

main().catch(console.error);
