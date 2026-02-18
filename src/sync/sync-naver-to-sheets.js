require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const NaverAPI = require('../api/naverAPI');
const fs = require('fs');
const path = require('path');

class NaverToSheetsSync {
  constructor() {
    this.naver = new NaverAPI();
  }

  async getAllProducts() {
    console.log('=== Naver 스마트스토어 상품 조회 시작 ===\n');

    await this.naver.getToken();

    const allItems = [];
    let page = 1;
    const size = 100;
    let totalElements = 0;

    while (true) {
      try {
        const data = await this.naver.getProducts(page, size);
        const products = data.contents || data.products || [];
        if (page === 1) {
          totalElements = data.totalElements || data.total || 0;
          console.log(`총 상품 수: ${totalElements}개\n`);
        }

        if (products.length === 0) break;

        products.forEach(p => {
          allItems.push({
            productNo: p.channelProductNo || p.productNo || '',
            name: p.name || p.channelProductName || '',
            salePrice: p.salePrice || p.discountedPrice || 0,
            stockQuantity: p.stockQuantity || 0,
            statusType: p.statusType || p.channelProductDisplayStatusType || '',
            categoryId: p.categoryId || '',
            imageUrl: p.representativeImage?.url || p.channelProductImageUrl || '',
          });
        });

        console.log(`Page ${page}: ${products.length}개 (누적: ${allItems.length}/${totalElements})`);

        if (allItems.length >= totalElements || products.length < size) break;

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

    let sheet = doc.sheetsByTitle['Naver Products'];
    if (!sheet) {
      console.log('"Naver Products" 시트 생성 중...');
      sheet = await doc.addSheet({
        title: 'Naver Products',
        headerValues: ['상품번호', '상품명', '판매가(KRW)', '재고', '상태', '카테고리ID', '플랫폼', '수수료(%)', '최종 업데이트', '이미지 URL']
      });
    }

    await sheet.clear();
    await sheet.setHeaderRow(['상품번호', '상품명', '판매가(KRW)', '재고', '상태', '카테고리ID', '플랫폼', '수수료(%)', '최종 업데이트', '이미지 URL']);

    const rows = items.map(item => ({
      '상품번호': item.productNo,
      '상품명': item.name,
      '판매가(KRW)': item.salePrice,
      '재고': item.stockQuantity,
      '상태': item.statusType,
      '카테고리ID': item.categoryId,
      '플랫폼': 'Naver',
      '수수료(%)': 5.5,
      '최종 업데이트': new Date().toISOString(),
      '이미지 URL': item.imageUrl,
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
        console.log(`${i + 1}. [${item.productNo}] ${item.name}`);
        console.log(`   가격: ${item.salePrice}원, 재고: ${item.stockQuantity}, 상태: ${item.statusType}`);
      });

      await this.updateGoogleSheets(items);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\nNaver 동기화 완료! (${elapsed}초, ${items.length}개)\n`);
    } catch (error) {
      console.error('\n동기화 실패:', error.message);
      process.exit(1);
    }
  }
}

const syncer = new NaverToSheetsSync();
syncer.sync();
