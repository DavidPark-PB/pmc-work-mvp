#!/usr/bin/env node

/**
 * 통합 대시보드 MCP Server
 * 모든 플랫폼의 데이터를 Google Sheets 대시보드로 통합 관리
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const GoogleSheetsAPI = require('../src/api/googleSheetsAPI');

const server = new McpServer({
  name: 'pmc-dashboard',
  version: '1.0.0',
});

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const CREDENTIALS_PATH = path.join(__dirname, '..', 'config', 'credentials.json');

let sheetsApi = null;

async function getSheetsApi() {
  if (!sheetsApi) {
    sheetsApi = new GoogleSheetsAPI(CREDENTIALS_PATH);
    await sheetsApi.authenticate();
  }
  return sheetsApi;
}

// 대시보드 전체 현황 조회
server.tool(
  'dashboard_get_overview',
  '전체 플랫폼 대시보드 현황을 가져옵니다 (상품수, 매출, 마진)',
  {},
  async () => {
    try {
      const sheets = await getSheetsApi();
      const info = await sheets.getSpreadsheetInfo(SPREADSHEET_ID);

      const sheetNames = info.sheets.map(s => s.properties.title);

      // 대시보드 시트 데이터 읽기
      const dashboardSheet = sheetNames.find(n =>
        n.includes('Dashboard') || n.includes('대시보드')
      );

      let dashboardData = null;
      if (dashboardSheet) {
        const rows = await sheets.readData(SPREADSHEET_ID, `${dashboardSheet}!A1:Z5`);
        dashboardData = rows;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            spreadsheet_title: info.properties.title,
            sheets: sheetNames,
            dashboard_preview: dashboardData,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `대시보드 조회 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 특정 시트 데이터 읽기
server.tool(
  'dashboard_read_sheet',
  'Google Sheets에서 특정 시트의 데이터를 읽습니다',
  {
    sheet_name: z.string().describe('시트 이름 (예: "최종 Dashboard")'),
    range: z.string().optional().describe('범위 (예: "A1:Z100", 미지정시 전체)'),
  },
  async ({ sheet_name, range }) => {
    try {
      const sheets = await getSheetsApi();
      const fullRange = range ? `${sheet_name}!${range}` : `${sheet_name}`;
      const rows = await sheets.readData(SPREADSHEET_ID, fullRange);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sheet: sheet_name,
            total_rows: rows.length,
            headers: rows[0] || [],
            data: rows.slice(0, 50),
            note: rows.length > 50 ? `${rows.length - 50}행 추가 데이터 있음` : undefined,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `시트 읽기 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 대시보드에 데이터 업데이트
server.tool(
  'dashboard_update_data',
  '대시보드에 데이터를 업데이트합니다',
  {
    sheet_name: z.string().describe('시트 이름'),
    range: z.string().describe('업데이트 범위 (예: "A2:D10")'),
    values: z.string().describe('JSON 2차원 배열 (예: [["값1","값2"],["값3","값4"]])'),
  },
  async ({ sheet_name, range, values }) => {
    try {
      const sheets = await getSheetsApi();
      const parsedValues = JSON.parse(values);
      const fullRange = `${sheet_name}!${range}`;
      const result = await sheets.writeData(SPREADSHEET_ID, fullRange, parsedValues);

      return {
        content: [{
          type: 'text',
          text: `대시보드 업데이트 완료: ${sheet_name} ${range} (${result.updatedCells}셀)`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `업데이트 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 플랫폼별 마진 비교
server.tool(
  'dashboard_compare_margins',
  '플랫폼별 마진율을 비교 분석합니다',
  {
    sheet_name: z.string().optional().describe('대시보드 시트 이름'),
  },
  async ({ sheet_name }) => {
    try {
      const sheets = await getSheetsApi();
      const targetSheet = sheet_name || '최종 Dashboard';
      const rows = await sheets.readData(SPREADSHEET_ID, `${targetSheet}!A1:Z`);

      if (!rows || rows.length < 2) {
        return {
          content: [{ type: 'text', text: '대시보드에 데이터가 없습니다.' }],
        };
      }

      const headers = rows[0];
      const platformIdx = headers.findIndex(h => h?.includes('플랫폼'));
      const marginIdx = headers.findIndex(h => h?.includes('마진율'));
      const profitIdx = headers.findIndex(h => h?.includes('순이익') || h?.includes('이익'));

      const platformStats = {};

      rows.slice(1).forEach(row => {
        const platform = row[platformIdx] || 'Unknown';
        const margin = parseFloat(row[marginIdx]) || 0;
        const profit = parseFloat(row[profitIdx]) || 0;

        if (!platformStats[platform]) {
          platformStats[platform] = { count: 0, totalMargin: 0, totalProfit: 0, negativeMargin: 0 };
        }

        platformStats[platform].count++;
        platformStats[platform].totalMargin += margin;
        platformStats[platform].totalProfit += profit;
        if (margin < 0) platformStats[platform].negativeMargin++;
      });

      const comparison = Object.entries(platformStats).map(([platform, stats]) => ({
        platform,
        product_count: stats.count,
        avg_margin: (stats.totalMargin / stats.count * 100).toFixed(1) + '%',
        total_profit_krw: Math.round(stats.totalProfit).toLocaleString(),
        negative_margin_items: stats.negativeMargin,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_products: rows.length - 1,
            platform_comparison: comparison,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `마진 비교 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// 이상 징후 감지
server.tool(
  'dashboard_detect_anomalies',
  '역마진 상품, 재고 이상 등 이상 징후를 감지합니다',
  {
    sheet_name: z.string().optional().describe('대시보드 시트 이름'),
  },
  async ({ sheet_name }) => {
    try {
      const sheets = await getSheetsApi();
      const targetSheet = sheet_name || '최종 Dashboard';
      const rows = await sheets.readData(SPREADSHEET_ID, `${targetSheet}!A1:Z`);

      if (!rows || rows.length < 2) {
        return {
          content: [{ type: 'text', text: '데이터가 없습니다.' }],
        };
      }

      const headers = rows[0];
      const titleIdx = headers.findIndex(h => h?.includes('제목') || h?.includes('상품명'));
      const marginIdx = headers.findIndex(h => h?.includes('마진율'));
      const profitIdx = headers.findIndex(h => h?.includes('순이익'));
      const platformIdx = headers.findIndex(h => h?.includes('플랫폼'));

      const anomalies = {
        negative_margin: [],
        high_margin: [],
        zero_price: [],
      };

      rows.slice(1).forEach((row, idx) => {
        const title = row[titleIdx] || `Row ${idx + 2}`;
        const margin = parseFloat(row[marginIdx]) || 0;
        const profit = parseFloat(row[profitIdx]) || 0;
        const platform = row[platformIdx] || 'Unknown';

        if (margin < 0 || profit < 0) {
          anomalies.negative_margin.push({
            row: idx + 2,
            title: title.substring(0, 50),
            platform,
            margin: (margin * 100).toFixed(1) + '%',
            profit: Math.round(profit),
          });
        }

        if (margin > 0.5) {
          anomalies.high_margin.push({
            row: idx + 2,
            title: title.substring(0, 50),
            platform,
            margin: (margin * 100).toFixed(1) + '%',
          });
        }
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_analyzed: rows.length - 1,
            anomalies: {
              negative_margin_count: anomalies.negative_margin.length,
              negative_margin_items: anomalies.negative_margin.slice(0, 20),
              high_margin_count: anomalies.high_margin.length,
              high_margin_items: anomalies.high_margin.slice(0, 10),
            },
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `이상 징후 감지 오류: ${error.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Dashboard MCP Server running on stdio');
}

main().catch(console.error);
