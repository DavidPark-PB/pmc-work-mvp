require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 품절 데이터가 어디에 있는지 확인
 */

async function findSoldoutColumn() {
  console.log('=== 품절 데이터 위치 확인 ===\n');

  try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const dashboard = doc.sheetsByTitle['최종 Dashboard'];

    // 전체 데이터 스캔 - "품절" 텍스트 찾기
    console.log('🔍 전체 데이터에서 "품절" 텍스트 검색 중...\n');

    await dashboard.loadCells('A1:Z100');

    const foundCells = [];

    for (let row = 0; row < 100; row++) {
      for (let col = 0; col < 26; col++) {
        const cell = dashboard.getCell(row, col);
        const value = String(cell.value || '').toLowerCase();

        if (value.includes('품절') || value.includes('sold') || value.includes('out of stock') || value === '0') {
          foundCells.push({
            row: row + 1,
            col: String.fromCharCode(65 + col),
            value: cell.value
          });
        }
      }
    }

    if (foundCells.length > 0) {
      console.log('✅ 발견된 품절 관련 셀:\n');
      foundCells.slice(0, 30).forEach(c => {
        console.log(`   ${c.col}${c.row}: "${c.value}"`);
      });
      if (foundCells.length > 30) {
        console.log(`   ... 외 ${foundCells.length - 30}개`);
      }
    } else {
      console.log('❌ "품절" 텍스트를 찾지 못했습니다.');
    }

    // 재고 열 확인 (숫자 0 찾기)
    console.log('\n\n🔢 재고가 0인 상품 확인 중...\n');

    await dashboard.loadCells('A1:Z500');

    let zeroStockCells = [];

    for (let row = 1; row < 500; row++) {
      for (let col = 0; col < 26; col++) {
        const cell = dashboard.getCell(row, col);
        if (cell.value === 0 || cell.value === '0') {
          zeroStockCells.push({
            row: row + 1,
            col: String.fromCharCode(65 + col),
            value: cell.value
          });
        }
      }
    }

    if (zeroStockCells.length > 0) {
      // 열별로 그룹화
      const byCol = {};
      zeroStockCells.forEach(c => {
        if (!byCol[c.col]) byCol[c.col] = [];
        byCol[c.col].push(c);
      });

      console.log('열별 0 값 개수:');
      Object.entries(byCol).forEach(([col, cells]) => {
        console.log(`   ${col}열: ${cells.length}개`);
      });
    }

    console.log('\n\n📋 각 열의 첫 번째 값 확인:\n');
    await dashboard.loadCells('A2:Z2');

    for (let col = 0; col < 26; col++) {
      const cell = dashboard.getCell(1, col);
      if (cell.value !== null && cell.value !== '') {
        console.log(`   ${String.fromCharCode(65 + col)}: ${cell.value}`);
      }
    }

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
  }
}

findSoldoutColumn();
