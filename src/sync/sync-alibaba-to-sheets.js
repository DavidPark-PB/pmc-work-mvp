require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const AlibabaAPI = require('../api/alibabaAPI');
const fs = require('fs');
const path = require('path');

class AlibabaToSheetsSync {
  constructor() {
    this.alibaba = new AlibabaAPI();
  }

  async getAllProducts() {
    console.log('=== Alibaba ICBU 상품 조회 시작 ===\n');

    const allItems = [];
    let page = 1;
    const pageSize = 20;
    let totalItems = 0;

    while (true) {
      try {
        const data = await this.alibaba.getProductList(page, pageSize);
        const result = data.result || data;
        const products = result.products || [];

        if (page === 1) {
          totalItems = result.total_item || result.total || 0;
          console.log(`총 상품 수: ${totalItems}개\n`);
        }

        if (products.length === 0) break;

        products.forEach(p => {
          allItems.push({
            productId: p.id || p.product_id || '',
            subject: p.subject || '',
            groupName: p.group_name || '',
            status: p.status || '',
            categoryId: p.category_id || '',
            imageUrl: p.main_image?.images?.[0] || p.image_url || '',
            pcDetailUrl: p.pc_detail_url || '',
          });
        });

        console.log(`Page ${page}: ${products.length}개 (누적: ${allItems.length}/${totalItems})`);

        if (allItems.length >= totalItems || products.length < pageSize) break;

        page++;
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Page ${page} 실패:`, error.message);
        break;
      }
    }

    console.log(`\n${allItems.length}개 상품 수집 완료!\n`);
    return allItems;
  }

  async updateGoogleSheets(items) {
    console.log('=== Google Sheets 업데이트 시작 ===\n');

    const credPath = path.join(__dirname, '../../config/credentials.json');
    const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));

    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`스프레드시트: ${doc.title}`);

    let sheet = doc.sheetsByTitle['Alibaba Products'];
    if (!sheet) {
      console.log('"Alibaba Products" 시트 생성 중...');
      sheet = await doc.addSheet({
        title: 'Alibaba Products',
        headerValues: ['Product ID', 'Subject', 'Group', 'Status', 'Category ID', 'Platform', 'Fee (%)', 'Last Updated', 'Image URL', 'URL']
      });
    }

    await sheet.clear();
    await sheet.setHeaderRow(['Product ID', 'Subject', 'Group', 'Status', 'Category ID', 'Platform', 'Fee (%)', 'Last Updated', 'Image URL', 'URL']);

    const rows = items.map(item => ({
      'Product ID': item.productId,
      'Subject': item.subject,
      'Group': item.groupName,
      'Status': item.status,
      'Category ID': item.categoryId,
      'Platform': 'Alibaba',
      'Fee (%)': 5,
      'Last Updated': new Date().toISOString(),
      'Image URL': item.imageUrl,
      'URL': item.pcDetailUrl,
    }));

    console.log(`\n${rows.length}개 행을 Google Sheets에 업로드 중...`);
    await sheet.addRows(rows);

    console.log(`Google Sheets 업데이트 완료!`);
    console.log(`시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
  }

  async sync() {
    try {
      const startTime = Date.now();

      const items = await this.getAllProducts();

      if (items.length === 0) {
        console.log('가져온 상품이 없습니다.');
        return;
      }

      console.log('샘플 데이터 (처음 3개):\n');
      items.slice(0, 3).forEach((item, i) => {
        console.log(`${i + 1}. [${item.productId}] ${item.subject}`);
        console.log(`   그룹: ${item.groupName}, 상태: ${item.status}`);
      });

      await this.updateGoogleSheets(items);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\nAlibaba 동기화 완료! (${elapsed}초, ${items.length}개)\n`);
    } catch (error) {
      console.error('\n동기화 실패:', error.message);
      process.exit(1);
    }
  }
}

const syncer = new AlibabaToSheetsSync();
syncer.sync();
