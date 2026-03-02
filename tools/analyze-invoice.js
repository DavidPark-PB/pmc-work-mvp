/**
 * 인보이스 Excel 구조 분석 — 아이템 파싱 패턴 파악용
 */
const GoogleDriveAPI = require('../src/api/googleDriveAPI');
const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const drive = new GoogleDriveAPI(path.join(__dirname, '../config/credentials.json'));
  await drive.authenticate();

  // 금액 파싱 성공한 파일 ID들로 구조 분석
  const testFiles = [
    { name: 'MATT QUINN', id: '1mYBcLSdGX1dUlqCLYYvYh9eC6sFXpvZO', type: 'sheet' },
  ];

  // 바이어 폴더에서 xlsx 파일 몇 개 가져오기
  const res = await drive.drive.files.list({
    q: "'1FduYLrs9G8qU197QoYqYtLY0Il3t4Tet' in parents and mimeType='application/vnd.google-apps.folder'",
    fields: 'files(id, name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  for (const folder of (res.data.files || []).slice(0, 3)) {
    if (folder.name.startsWith('00') || folder.name.startsWith('AA')) continue;

    const sub = await drive.drive.files.list({
      q: `'${folder.id}' in parents and (mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType='application/vnd.google-apps.spreadsheet')`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1,
      orderBy: 'modifiedTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const file = (sub.data.files || [])[0];
    if (file) {
      testFiles.push({
        name: folder.name,
        id: file.id,
        type: file.mimeType.includes('spreadsheet') ? 'sheet' : 'xlsx',
      });
    }
  }

  for (const tf of testFiles) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`=== ${tf.name} (${tf.type}) ===`);
    console.log(`${'='.repeat(60)}`);

    try {
      let buf;
      if (tf.type === 'sheet') {
        const exp = await drive.drive.files.export(
          { fileId: tf.id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          { responseType: 'arraybuffer' }
        );
        buf = Buffer.from(exp.data);
      } else {
        const dl = await drive.drive.files.get(
          { fileId: tf.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        buf = Buffer.from(dl.data);
      }

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const ws = wb.worksheets[0];

      ws.eachRow((row, rowNum) => {
        const cells = [];
        row.eachCell((cell, colNum) => {
          const val = cell.value;
          if (val !== null && val !== undefined && val !== '') {
            let display;
            if (typeof val === 'object') {
              display = val.result !== undefined ? val.result : (val.text || JSON.stringify(val));
            } else {
              display = val;
            }
            cells.push(`C${colNum}:${display}`);
          }
        });
        if (cells.length > 0) console.log(`R${rowNum} | ${cells.join(' | ')}`);
      });
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }
}

main().catch(e => console.error('Fatal:', e.message));
