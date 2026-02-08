#!/usr/bin/env node

/**
 * Alibaba MCP Server
 * 소싱 자동화: 상품 검색, 가격 비교, 공급업체 분석
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const AlibabaAPI = require('../src/api/alibabaAPI');

const server = new McpServer({
  name: 'pmc-alibaba',
  version: '1.0.0',
});

let api = null;

function getApi() {
  if (!api) {
    api = new AlibabaAPI();
  }
  return api;
}

// 소싱 상품 검색
server.tool(
  'alibaba_search_products',
  '알리바바에서 소싱 가능한 상품을 검색합니다',
  {
    keyword: z.string().describe('검색 키워드 (영문 권장)'),
    min_price: z.number().optional().describe('최소 가격 (USD)'),
    max_price: z.number().optional().describe('최대 가격 (USD)'),
    page: z.number().optional().describe('페이지 번호'),
  },
  async ({ keyword, min_price, max_price, page }) => {
    try {
      const alibaba = getApi();
      const results = await alibaba.searchProducts(keyword, {
        page: page || 1,
        minPrice: min_price,
        maxPrice: max_price,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            keyword,
            results: results,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `소싱 검색 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 가격 비교 (핵심 소싱 기능)
server.tool(
  'alibaba_compare_prices',
  '여러 공급업체의 가격을 비교합니다 (소싱 최적화)',
  {
    keyword: z.string().describe('상품 키워드'),
    top_n: z.number().optional().describe('비교할 공급업체 수 (기본 10)'),
  },
  async ({ keyword, top_n }) => {
    try {
      const alibaba = getApi();
      const comparison = await alibaba.comparePrices(keyword, top_n || 10);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            keyword,
            suppliers_compared: comparison.length,
            results: comparison,
            recommendation: comparison.length > 0
              ? `최저가 공급업체: ${comparison[0]?.supplier || 'N/A'} ($${comparison[0]?.price || 'N/A'})`
              : '검색 결과 없음',
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `가격 비교 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 상품 상세 정보
server.tool(
  'alibaba_get_product_detail',
  '알리바바 상품 상세 정보를 가져옵니다',
  {
    product_id: z.string().describe('알리바바 상품 ID'),
  },
  async ({ product_id }) => {
    try {
      const alibaba = getApi();
      const detail = await alibaba.getProductDetail(product_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(detail, null, 2),
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

// 공급업체 정보
server.tool(
  'alibaba_get_supplier_info',
  '알리바바 공급업체 상세 정보 (신뢰도, 거래실적 등)',
  {
    supplier_id: z.string().describe('공급업체 ID'),
  },
  async ({ supplier_id }) => {
    try {
      const alibaba = getApi();
      const info = await alibaba.getSupplierInfo(supplier_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(info, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `공급업체 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Alibaba MCP Server running on stdio');
}

main().catch(console.error);
