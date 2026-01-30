require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * 상위 10개 상품의 실제 이미지 URL을 eBay GetItem API로 가져와서 적용
 */

class EbayImageTester {
  constructor() {
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.authToken = process.env.EBAY_USER_TOKEN;
  }

  async getItemImages(itemId) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${this.authToken}</eBayAuthToken>
        </RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <DetailLevel>ItemReturnDescription</DetailLevel>
        <IncludeItemSpecifics>true</IncludeItemSpecifics>
      </GetItemRequest>`;

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-DEV-NAME': this.devId,
      'X-EBAY-API-APP-NAME': this.appId,
      'X-EBAY-API-CERT-NAME': this.certId,
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml'
    };

    try {
      const response = await axios.post(this.apiUrl, xml, { headers });
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(response.data);

      const item = result.GetItemResponse?.Item;
      if (!item) return null;

      // PictureDetails에서 이미지 URL 추출 (새로운 형식: /images/g/[imageID]/s-l500.jpg)
      let imageUrl = '';
      if (item.PictureDetails?.PictureURL) {
        const pictures = Array.isArray(item.PictureDetails.PictureURL)
          ? item.PictureDetails.PictureURL
          : [item.PictureDetails.PictureURL];

        // 1순위: /z/ 경로에서 이미지 ID 추출하여 /images/g/ 형식으로 변환
        for (const url of pictures) {
          if (url) {
            const match = url.match(/\/z\/([^\/]+)\//);
            if (match) {
              const imageId = match[1];
              imageUrl = `https://i.ebayimg.com/images/g/${imageId}/s-l500.jpg`;
              break;
            }
          }
        }
      }

      // 2순위: GalleryURL 사용
      if (!imageUrl && item.PictureDetails?.GalleryURL) {
        const gallery = item.PictureDetails.GalleryURL;

        // GalleryURL이 이미 /images/g/ 형식이면 그대로 사용
        if (gallery.includes('/images/g/')) {
          imageUrl = gallery;
        } else {
          // 아니면 /z/에서 이미지 ID 추출
          const match = gallery.match(/\/z\/([^\/]+)\//);
          if (match) {
            const imageId = match[1];
            imageUrl = `https://i.ebayimg.com/images/g/${imageId}/s-l500.jpg`;
          }
        }
      }

      return imageUrl;
    } catch (error) {
      console.error(`   ⚠️  Item ${itemId} 이미지 가져오기 실패:`, error.message);
      return null;
    }
  }

  async testTop10() {
    console.log('=== 상위 10개 상품 이미지 테스트 시작 ===\n');

    try {
      // 1. Google Sheets 인증
      const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
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

      console.log('📖 상위 10개 상품의 Item ID 읽기...\n');

      // 2. 상위 10개 행에서 eBay Item ID 가져오기 (B열 - 12자리 숫자)
      await sheet.loadCells('B4:B13');

      const itemIds = [];
      for (let i = 3; i < 13; i++) {
        const itemId = sheet.getCell(i, 1).value; // B열 (eBay Item ID)
        // 12자리 숫자인지 확인
        if (itemId && /^\d{12}$/.test(String(itemId))) {
          itemIds.push({ rowIdx: i, rowNum: i + 1, itemId: String(itemId) });
        }
      }

      console.log(`✅ ${itemIds.length}개 Item ID 발견\n`);

      // 3. 각 Item의 실제 이미지 URL 가져오기
      console.log('🔍 eBay GetItem API로 이미지 URL 가져오기...\n');

      const imageData = [];
      for (const item of itemIds) {
        console.log(`   ${item.rowNum}행: Item ID ${item.itemId}`);
        const imageUrl = await this.getItemImages(item.itemId);

        if (imageUrl) {
          console.log(`      ✅ 이미지 URL: ${imageUrl.substring(0, 80)}...`);
          imageData.push({ ...item, imageUrl });
        } else {
          console.log(`      ⚠️  이미지 URL 없음`);
        }

        // Rate limit 방지
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`\n📊 총 ${imageData.length}개 이미지 URL 수집 완료\n`);

      // 4. A열에 IMAGE 함수 적용
      console.log('🖼️  A열에 IMAGE 함수 적용 중...\n');

      await sheet.loadCells('A4:A13');

      for (const data of imageData) {
        const cell = sheet.getCell(data.rowIdx, 0);
        cell.formula = `=IMAGE("${data.imageUrl}", 1)`;
        console.log(`   ${data.rowNum}행: IMAGE 함수 적용`);
      }

      await sheet.saveUpdatedCells();
      console.log('\n✅ IMAGE 함수 적용 완료\n');

      // 5. 행 높이 조절 (Google Sheets API)
      console.log('📐 행 높이 100px 설정 중...\n');

      try {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: sheet.columnCount });
        console.log('   💡 행 높이는 Google Sheets에서 수동으로 조절해주세요.');
        console.log('      행 4~13 선택 → 우클릭 → "행 크기 조절" → 100\n');
      } catch (e) {
        console.log('   💡 행 높이는 Google Sheets에서 수동으로 조절해주세요.');
        console.log('      행 4~13 선택 → 우클릭 → "행 크기 조절" → 100\n');
      }

      // 6. 결과 보고
      console.log('='.repeat(60));
      console.log('📋 최종 보고서');
      console.log('='.repeat(60));
      console.log(`✅ 처리된 상품: ${imageData.length}개`);
      console.log(`✅ IMAGE 함수 적용: ${imageData.length}개 행`);
      console.log(`\n🔗 시트 URL: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}`);
      console.log('\n💡 다음 단계:');
      console.log('   1. Google Sheets를 열어서 이미지가 표시되는지 확인');
      console.log('   2. 행 4~13 선택 → 우클릭 → "행 크기 조절" → 100');
      console.log('   3. A열 너비도 필요시 조절 (150 권장)');
      console.log('\n🎉 완료!\n');

    } catch (error) {
      console.error('\n❌ 실패:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }
}

const tester = new EbayImageTester();
tester.testTop10();
