require('dotenv').config({ path: '../../config/.env' });
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * 이미지 동기화 스크립트 (우선순위 기반)
 *
 * 기능:
 * 1. 매입가 미입력 상품 우선 동기화 (Quick Sync)
 * 2. 썸네일 최적화 (s-l140 사용)
 * 3. 배치 처리 (50개 단위)
 * 4. API 제한 방지 (배치 간 휴식)
 *
 * 사용법:
 *   node sync-images-priority.js                    # 매입가 미입력 상품만
 *   node sync-images-priority.js --all              # 이미지 없는 전체 상품
 *   node sync-images-priority.js --limit=100        # 최대 100개만
 *   node sync-images-priority.js --batch-size=30    # 배치 크기 변경
 */

const args = process.argv.slice(2);
const options = {
  allProducts: args.includes('--all'),
  limit: parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0'),
  batchSize: parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '50'),
  dryRun: args.includes('--dry-run'),
};

class ImageSyncer {
  constructor() {
    this.apiUrl = 'https://api.ebay.com/ws/api.dll';
    this.devId = process.env.EBAY_DEV_ID;
    this.appId = process.env.EBAY_APP_ID;
    this.certId = process.env.EBAY_CERT_ID;
    this.authToken = process.env.EBAY_USER_TOKEN;
    this.stats = { success: 0, fail: 0, skip: 0 };
  }

  /**
   * eBay API에서 썸네일 URL 가져오기
   * @param {string} itemId - eBay Item ID (12자리)
   * @returns {string|null} - 썸네일 URL (s-l140) 또는 null
   */
  async getThumbnailUrl(itemId) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${this.authToken}</eBayAuthToken>
        </RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <DetailLevel>ItemReturnDescription</DetailLevel>
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
      const response = await axios.post(this.apiUrl, xml, { headers, timeout: 15000 });
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(response.data);

      const item = result.GetItemResponse?.Item;
      if (!item) return null;

      // PictureDetails에서 이미지 ID 추출
      let imageUrl = null;

      if (item.PictureDetails?.PictureURL) {
        const pictures = Array.isArray(item.PictureDetails.PictureURL)
          ? item.PictureDetails.PictureURL
          : [item.PictureDetails.PictureURL];

        // /z/[imageID]/ 패턴에서 이미지 ID 추출 후 썸네일 URL 생성
        for (const url of pictures) {
          if (url) {
            const match = url.match(/\/z\/([^\/]+)\//);
            if (match) {
              const imageId = match[1];
              // s-l140: 썸네일 (빠른 로딩)
              // s-l500: 중간 크기
              // s-l1600: 고화질
              imageUrl = `https://i.ebayimg.com/images/g/${imageId}/s-l140.jpg`;
              break;
            }
            // 이미 /images/g/ 형식이면 썸네일로 변환
            if (url.includes('/images/g/')) {
              imageUrl = url.replace(/s-l\d+\.jpg/, 's-l140.jpg');
              break;
            }
          }
        }
      }

      // GalleryURL fallback
      if (!imageUrl && item.PictureDetails?.GalleryURL) {
        const gallery = item.PictureDetails.GalleryURL;
        if (gallery.includes('/images/g/')) {
          imageUrl = gallery.replace(/s-l\d+\.jpg/, 's-l140.jpg');
        } else {
          const match = gallery.match(/\/z\/([^\/]+)\//);
          if (match) {
            imageUrl = `https://i.ebayimg.com/images/g/${match[1]}/s-l140.jpg`;
          }
        }
      }

      return imageUrl;
    } catch (error) {
      return null;
    }
  }

  /**
   * 배치 단위로 이미지 동기화
   */
  async syncBatch(items, sheet, batchNum, totalBatches) {
    console.log(`\n📦 배치 ${batchNum}/${totalBatches} 처리 중 (${items.length}개)...`);

    const updates = [];

    for (const item of items) {
      const { rowIdx, rowNum, itemId, title } = item;

      process.stdout.write(`   Row ${rowNum}: ${itemId} ... `);

      const thumbnailUrl = await this.getThumbnailUrl(itemId);

      if (thumbnailUrl) {
        updates.push({ rowIdx, thumbnailUrl });
        this.stats.success++;
        console.log(`✅ ${thumbnailUrl.substring(0, 50)}...`);
      } else {
        this.stats.fail++;
        console.log(`❌ 이미지 없음`);
      }

      // API 호출 간격 (0.3초)
      await this.sleep(300);
    }

    // 배치 업데이트 (한 번에 시트에 쓰기)
    if (updates.length > 0 && !options.dryRun) {
      await sheet.loadCells(`A${updates[0].rowIdx + 1}:A${updates[updates.length - 1].rowIdx + 1}`);

      for (const { rowIdx, thumbnailUrl } of updates) {
        const cell = sheet.getCell(rowIdx, 0);
        cell.formula = `=IMAGE("${thumbnailUrl}", 1)`;
      }

      await sheet.saveUpdatedCells();
      console.log(`   💾 ${updates.length}개 셀 저장 완료`);
    }

    // 배치 간 휴식 (2초)
    if (batchNum < totalBatches) {
      console.log(`   ⏸️  다음 배치 전 2초 대기...`);
      await this.sleep(2000);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 메인 동기화 실행
   */
  async run() {
    const startTime = Date.now();
    console.log('='.repeat(70));
    console.log('🖼️  이미지 동기화 시작 (우선순위 기반)');
    console.log('='.repeat(70));
    console.log(`옵션: ${options.allProducts ? '전체 상품' : '매입가 미입력 상품만'}`);
    console.log(`배치 크기: ${options.batchSize}개`);
    if (options.limit > 0) console.log(`최대 처리: ${options.limit}개`);
    if (options.dryRun) console.log('⚠️  DRY RUN 모드 - 실제 저장 안함');
    console.log('');

    try {
      // 1. Google Sheets 연결
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

      // 2. 대상 상품 찾기
      console.log('📖 대상 상품 검색 중...\n');

      // A열(이미지), B열(SKU), E열(매입가) 로드
      const lastRow = sheet.rowCount > 10000 ? 10000 : sheet.rowCount;
      await sheet.loadCells(`A4:E${lastRow}`);

      const targetItems = [];

      for (let i = 3; i < lastRow; i++) {
        const imageCell = sheet.getCell(i, 0);
        const skuCell = sheet.getCell(i, 1);
        const titleCell = sheet.getCell(i, 2);
        const purchaseCell = sheet.getCell(i, 4);

        const itemId = String(skuCell.value || '');
        const imageFormula = imageCell.formula || '';
        const imageValue = String(imageCell.value || '');
        const purchaseValue = String(purchaseCell.value || '').trim();
        const title = String(titleCell.value || '').substring(0, 30);

        // SKU가 12자리 숫자가 아니면 스킵
        if (!/^\d{12}$/.test(itemId)) continue;

        // 이미 이미지가 있으면 스킵
        if (imageFormula.includes('IMAGE(') || imageValue.startsWith('http')) {
          this.stats.skip++;
          continue;
        }

        // 매입가 미입력 상품만 (Quick Sync 모드)
        if (!options.allProducts) {
          const hasPurchasePrice = /^\d+\.?\d*$/.test(purchaseValue) && purchaseValue !== '';
          if (hasPurchasePrice) {
            this.stats.skip++;
            continue;
          }
        }

        targetItems.push({
          rowIdx: i,
          rowNum: i + 1,
          itemId,
          title,
        });

        // 최대 개수 제한
        if (options.limit > 0 && targetItems.length >= options.limit) break;
      }

      console.log(`✅ 대상 상품: ${targetItems.length}개`);
      console.log(`⏭️  스킵 (이미 이미지 있음): ${this.stats.skip}개\n`);

      if (targetItems.length === 0) {
        console.log('🎉 동기화할 상품이 없습니다!');
        return;
      }

      // 3. 배치 처리
      const batches = [];
      for (let i = 0; i < targetItems.length; i += options.batchSize) {
        batches.push(targetItems.slice(i, i + options.batchSize));
      }

      console.log(`📊 총 ${batches.length}개 배치로 처리\n`);

      for (let i = 0; i < batches.length; i++) {
        await this.syncBatch(batches[i], sheet, i + 1, batches.length);
      }

      // 4. 결과 보고
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log('\n' + '='.repeat(70));
      console.log('📋 동기화 결과');
      console.log('='.repeat(70));
      console.log(`✅ 성공: ${this.stats.success}개`);
      console.log(`❌ 실패: ${this.stats.fail}개`);
      console.log(`⏭️  스킵: ${this.stats.skip}개`);
      console.log(`⏱️  소요 시간: ${elapsed}초`);
      console.log('='.repeat(70));

    } catch (error) {
      console.error('\n❌ 오류 발생:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
  }
}

// 도움말
if (args.includes('--help')) {
  console.log(`
🖼️  이미지 동기화 스크립트 (우선순위 기반)

사용법:
  node sync-images-priority.js [옵션]

옵션:
  --all              이미지 없는 전체 상품 동기화 (기본: 매입가 미입력만)
  --limit=N          최대 N개만 처리
  --batch-size=N     배치 크기 (기본: 50)
  --dry-run          테스트 모드 (실제 저장 안함)
  --help             도움말

예시:
  node sync-images-priority.js                  # 매입가 미입력 상품만 (Quick Sync)
  node sync-images-priority.js --all            # 전체 상품
  node sync-images-priority.js --limit=100      # 100개만
  node sync-images-priority.js --all --limit=1000  # 전체 중 1000개

권장 사용:
  1. 먼저 매입가 미입력 상품만 동기화 (알바생 작업용)
  2. 야간에 --all 옵션으로 나머지 처리
`);
  process.exit(0);
}

// 실행
const syncer = new ImageSyncer();
syncer.run();
