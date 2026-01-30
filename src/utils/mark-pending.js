require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

/**
 * 특정 SKU를 Pending 상태로 설정
 * 사용법: node mark-pending.js SKU1 SKU2 SKU3...
 */

async function markPending() {
  const skusToMark = process.argv.slice(2);

  if (skusToMark.length === 0) {
    console.log('사용법: node mark-pending.js SKU1 SKU2 SKU3...');
    console.log('예시: node mark-pending.js ABC123 DEF456');
    return;
  }

  console.log('=== Pending 상태로 설정 ===\n');
  console.log(`📦 대상 SKU: ${skusToMark.join(', ')}\n`);

  try {
    const credentials = JSON.parse(fs.readFileSync('../../config/credentials.json', 'utf8'));
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['최종 Dashboard'];
    if (!sheet) {
      console.error('❌ "최종 Dashboard" 시트를 찾을 수 없습니다!');
      return;
    }

    const rows = await sheet.getRows();
    console.log(`📄 총 ${rows.length}개 행 로드 완료\n`);

    let markedCount = 0;

    for (const sku of skusToMark) {
      const row = rows.find(r => r.get('SKU') === sku);

      if (row) {
        row.set('Sync Status', 'Pending');
        row.set('Last Updated', new Date().toISOString());
        await row.save();

        console.log(`✅ ${sku} → Pending`);
        markedCount++;
      } else {
        console.log(`❌ ${sku} → 찾을 수 없음`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ ${markedCount}/${skusToMark.length}개 SKU Pending 설정 완료!`);
    console.log('='.repeat(60));
    console.log(`\n🔗 시트: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
    console.log('\n다음 단계:');
    console.log('  - Shopify 업데이트: node sync-to-shopify.js');
    console.log('  - eBay 업데이트: node sync-to-ebay.js');
    console.log('\n🎉 완료!\n');

  } catch (error) {
    console.error('\n❌ 실패:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

markPending();
