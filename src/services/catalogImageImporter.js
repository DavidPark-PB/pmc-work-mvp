/**
 * catalogImageImporter — Google Sheets 의 셀 안 이미지를
 * xlsx export + drawings.xml 파싱으로 추출 → Supabase Storage 업로드
 * → catalog_image_overrides upsert.
 *
 * 2026-08-08: Google Sheets API v4 는 in-cell image URL 을 노출하지 않음.
 *   xlsx export 안 xl/media/imageN.* 파일 + xl/drawings/drawingN.xml 의
 *   anchor 정보 (fromRow/fromCol) 로 셀 매핑 가능.
 *
 * xlsx 구조 (ZIP):
 *   xl/worksheets/sheet1.xml
 *   xl/worksheets/_rels/sheet1.xml.rels       — sheet → drawing 링크
 *   xl/drawings/drawing1.xml                  — anchor + relId
 *   xl/drawings/_rels/drawing1.xml.rels       — relId → media/imageN.*
 *   xl/media/imageN.png|jpg|...
 *   xl/workbook.xml                           — sheetName → sheetId
 *   xl/_rels/workbook.xml.rels                — sheetId → worksheets/sheetN.xml
 */
'use strict';

const JSZip = require('jszip');
const xml2js = require('xml2js');
const { google } = require('googleapis');

// Drive API 로 spreadsheet 을 xlsx 로 export 하려면 Drive scope 필요.
// 서비스 계정에 이미 Sheets scope 만 있을 수 있으므로 별도 확인.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Drive scope 를 포함한 별도 auth. googleSheetsAPI 의 기본 scope
// (spreadsheets) 만으로는 files.export 가 403 이므로 여기서 확장.
async function _getDriveAuth() {
  const { CREDENTIALS_PATH } = require('../config');
  const credsJson = process.env.GOOGLE_CREDENTIALS_JSON;
  const baseConfig = {
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  };
  const authConfig = credsJson
    ? { ...baseConfig, credentials: JSON.parse(credsJson) }
    : { ...baseConfig, keyFile: CREDENTIALS_PATH };
  const auth = new google.auth.GoogleAuth(authConfig);
  return auth.getClient();
}

/**
 * 전체 시트 xlsx export (drive.files.export). 10MB 초과 시 실패 —
 * exportSheetXlsx (탭별) fallback 사용 권장.
 */
async function exportXlsx(spreadsheetId) {
  const auth = await _getDriveAuth();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.export(
    { fileId: spreadsheetId, mimeType: XLSX_MIME },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/**
 * 특정 시트(gid)만 xlsx 로 export — 10MB 제한 우회.
 *   docs.google.com/spreadsheets/d/{sid}/export?format=xlsx&gid={gid}
 * 서비스 계정 access token 을 Bearer 헤더로 전달.
 */
async function exportSheetXlsx(spreadsheetId, gid) {
  const auth = await _getDriveAuth();
  const tokenResp = await auth.getAccessToken();
  const token = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
  if (!token) throw new Error('access token 발급 실패');
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx&gid=${gid}`;
  const axios = require('axios');
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 100 * 1024 * 1024,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    const body = Buffer.isBuffer(res.data) ? res.data.toString('utf8').slice(0, 300) : String(res.data).slice(0, 300);
    throw new Error(`탭별 export HTTP ${res.status}: ${body}`);
  }
  return Buffer.from(res.data);
}

/**
 * 시트 gid 목록 조회 (탭별 export 에 필요).
 * @returns {Promise<Array<{sheetId: number, title: string}>>}
 */
async function listSheetGids(spreadsheetId) {
  const auth = await _getDriveAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  return (r.data.sheets || []).map(s => ({
    sheetId: s.properties.sheetId,
    title: s.properties.title,
  }));
}

async function _xmlToJs(str) {
  return xml2js.parseStringPromise(str, { explicitArray: false, mergeAttrs: true });
}

/**
 * xlsx 를 파싱해서 각 시트별 이미지 anchor 리스트 반환.
 * @param {Buffer} xlsxBuffer
 * @returns {Promise<Array<{
 *   sheetName: string,
 *   images: Array<{ fromRow: number, fromCol: number, toRow: number, toCol: number,
 *                   mediaFile: string, mediaBytes: Buffer, contentType: string }>
 * }>>}
 */
async function parseXlsxImages(xlsxBuffer) {
  const zip = await JSZip.loadAsync(xlsxBuffer);

  // 1) workbook.xml — sheet name → sheetId (rId) 매핑
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const workbook = await _xmlToJs(workbookXml);
  const sheetEntries = _asArray(workbook.workbook.sheets.sheet).map(s => ({
    name: s.name,
    sheetId: s.sheetId,
    rId: s['r:id'],
  }));

  // 2) workbook.xml.rels — rId → target (worksheets/sheetN.xml)
  const workbookRelsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const workbookRels = await _xmlToJs(workbookRelsXml);
  const relMap = new Map();
  for (const r of _asArray(workbookRels.Relationships.Relationship)) {
    relMap.set(r.Id, r.Target);
  }

  const result = [];

  for (const sheet of sheetEntries) {
    const worksheetPath = 'xl/' + relMap.get(sheet.rId);  // e.g. worksheets/sheet1.xml
    if (!zip.file(worksheetPath)) continue;

    // 3) sheetN.xml.rels — drawing 링크 (r:id → target)
    const relsPath = worksheetPath.replace('worksheets/', 'worksheets/_rels/') + '.rels';
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;
    const relsXml = await relsFile.async('string');
    const rels = await _xmlToJs(relsXml);
    const drawingRel = _asArray(rels.Relationships.Relationship || [])
      .find(r => (r.Type || '').includes('/drawing'));
    if (!drawingRel) continue;

    // drawing target 은 '../drawings/drawing1.xml' 형태 → 정규화
    const drawingPath = _resolveRelPath(worksheetPath, drawingRel.Target);
    const drawingFile = zip.file(drawingPath);
    if (!drawingFile) continue;

    // 4) drawing1.xml — anchor + relId (이미지)
    const drawingXml = await drawingFile.async('string');
    const drawing = await _xmlToJs(drawingXml);
    const wsDr = drawing['xdr:wsDr'] || drawing.wsDr || {};
    // anchor 종류: oneCellAnchor, twoCellAnchor, absoluteAnchor
    const anchorTypes = ['xdr:twoCellAnchor', 'twoCellAnchor', 'xdr:oneCellAnchor', 'oneCellAnchor'];
    let anchors = [];
    for (const t of anchorTypes) {
      if (wsDr[t]) anchors = anchors.concat(_asArray(wsDr[t]));
    }
    if (anchors.length === 0) continue;

    // 5) drawing1.xml.rels — rId → media/imageN.*
    const drawingRelsPath = drawingPath.replace('drawings/', 'drawings/_rels/') + '.rels';
    const drawingRelsFile = zip.file(drawingRelsPath);
    if (!drawingRelsFile) continue;
    const drawingRelsXml = await drawingRelsFile.async('string');
    const drawingRels = await _xmlToJs(drawingRelsXml);
    const drRelMap = new Map();
    for (const r of _asArray(drawingRels.Relationships.Relationship || [])) {
      drRelMap.set(r.Id, r.Target);
    }

    const images = [];
    for (const anchor of anchors) {
      // xdr:pic 안 xdr:blipFill.a:blip 의 r:embed 가 rId
      // (blip 은 drawingML 'a:' namespace 이 표준. group shape 는 무시)
      const pic = anchor['xdr:pic'] || anchor.pic;
      if (!pic) continue;
      const blipFill = pic['xdr:blipFill'] || pic.blipFill || {};
      const blip = blipFill['a:blip'] || blipFill['xdr:blip'] || blipFill.blip || {};
      const embedId = blip['r:embed'] || blip['xdr:embed'] || blip.embed;
      if (!embedId) continue;
      const mediaTarget = drRelMap.get(embedId);
      if (!mediaTarget) continue;

      const mediaPath = _resolveRelPath(drawingPath, mediaTarget);
      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;

      // anchor from/to cell (0-based)
      const fromEl = anchor['xdr:from'] || anchor.from || {};
      const toEl = anchor['xdr:to'] || anchor.to || {};
      const fromRow = parseInt(fromEl['xdr:row'] || fromEl.row || '0', 10);
      const fromCol = parseInt(fromEl['xdr:col'] || fromEl.col || '0', 10);
      const toRow = parseInt(toEl['xdr:row'] || toEl.row || String(fromRow), 10);
      const toCol = parseInt(toEl['xdr:col'] || toEl.col || String(fromCol), 10);

      const mediaBytes = await mediaFile.async('nodebuffer');
      const contentType = _guessContentType(mediaPath);

      images.push({ fromRow, fromCol, toRow, toCol, mediaFile: mediaPath, mediaBytes, contentType });
    }

    if (images.length > 0) result.push({ sheetName: sheet.name, images });
  }

  return result;
}

function _asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function _resolveRelPath(fromPath, relTarget) {
  // fromPath: xl/worksheets/sheet1.xml, target: ../drawings/drawing1.xml
  //   → xl/drawings/drawing1.xml
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of relTarget.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function _guessContentType(path) {
  const ext = path.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext] || 'application/octet-stream';
}

/**
 * 이미지 buffer → Supabase Storage 업로드 → public URL 반환.
 * bucket: 'catalog-images' (없으면 생성 필요 — 사장님 수동 or 사전 작업)
 * @returns {Promise<string>} publicUrl
 */
async function uploadToStorage(bucket, key, buffer, contentType) {
  const { getClient } = require('../db/supabaseClient');
  const db = getClient();
  const { error } = await db.storage.from(bucket).upload(key, buffer, {
    contentType, upsert: true,
  });
  if (error) throw new Error(`Storage upload 실패 (${key}): ${error.message}`);
  const { data: pub } = db.storage.from(bucket).getPublicUrl(key);
  return pub.publicUrl;
}

/**
 * 전체 임포트 파이프라인 — 탭 하나 처리.
 *
 * col 매핑 (실 xlsx anchor 분석 결과):
 *   fromCol=2  (C열) → left IMAGE
 *   fromCol=10 (K열) → right IMAGE   ← 문서엔 J(9)로 되어있지만 실제는 10
 * anchor.fromRow (0-based) + 1 = catalog rowIndex (1-based 시트 row)
 *
 * tabName 은 xlsx 안 sheetName 이 아니라 사장님 시트의 원래 이름을 전달해야 함
 * ('[POKEMON] TCG LIST_USD' 등 — export 시 [] 브래킷 제거되므로 xlsx 안 이름은 다름).
 * catalog_image_overrides.tab 은 카탈로그 조회 시와 동일한 원래 이름으로 저장.
 *
 * @param {Object} opts
 * @param {string} opts.spreadsheetId  기본 SHEET_ID_USD
 * @param {string} opts.tabName        원래 탭 이름 (필수 — 없으면 전체 탭 순회)
 * @param {number} opts.userId
 */
async function importSheetImages({ spreadsheetId, tabName = null, userId } = {}) {
  const sid = spreadsheetId || process.env.SHEET_ID_USD || '1O6a7tSHmIHiFSmX0qLXN7Ab624viR-sEENmrGtXfQ_0';

  // 대상 탭 목록: tabName 지정 시 그 하나만, 없으면 전체
  const allGids = await listSheetGids(sid);
  const targets = tabName ? allGids.filter(g => g.title === tabName) : allGids;
  if (targets.length === 0) throw new Error(`탭 '${tabName || '전체'}' 를 찾을 수 없습니다`);

  const { getClient } = require('../db/supabaseClient');
  const db = getClient();
  const bucket = 'catalog-images';

  const stats = {
    tabsProcessed: [],
    imagesImported: 0,
    overridesUpserted: 0,
    errors: [],
  };

  // 2026-08-08: 탭마다 IMAGE 컬럼 위치 다름 (POKEMON=C(2)/K(10), ONE PIECE=C(2)/I(8)).
  // catalogService 헤더 감지 재사용해서 각 side 의 IMAGE col idx 를 동적으로 얻음.
  const catalogService = require('./catalogService');

  for (const target of targets) {
    let xlsxBuf;
    try {
      xlsxBuf = await exportSheetXlsx(sid, target.sheetId);
    } catch (e) {
      stats.errors.push({ tab: target.title, error: `export 실패: ${e.message}` });
      continue;
    }

    let parsed;
    try {
      parsed = await parseXlsxImages(xlsxBuf);
    } catch (e) {
      stats.errors.push({ tab: target.title, error: `parse 실패: ${e.message}` });
      continue;
    }

    // 해당 탭의 IMAGE 컬럼 idx 조회 (헤더 감지) — anchor col 매칭에 사용
    let leftImageCol = 2, rightImageCol = 10;  // POKEMON default fallback
    try {
      // catalogService 는 SHEET_IDS.USD 를 사용 — 여기서도 동일 시트
      const s = await catalogService.SHEET_IDS ? require('./catalogService') : null;
      const items = await catalogService.getCatalog(target.title).catch(() => null);
      if (items && items.items && items.items.length > 0) {
        const leftSample = items.items.find(i => i.side === 'left');
        const rightSample = items.items.find(i => i.side === 'right');
        // catalogService 는 image col idx 를 직접 노출하지 않음 → 다른 방법으로 헤더 재조회
      }
      // 헤더 직접 조회 (동일 로직 재구현)
      const GSAPI = require('../api/googleSheetsAPI');
      const gs = new GSAPI();
      await gs.authenticate();
      const headRows = await gs.readData(process.env.SHEET_ID_USD || '1O6a7tSHmIHiFSmX0qLXN7Ab624viR-sEENmrGtXfQ_0',
        `'${target.title}'!A1:P25`);
      for (const r of headRows.slice(0, 25)) {
        const upper = (r || []).map(v => String(v || '').toUpperCase().trim());
        if (upper.includes('#') && upper.includes('NAME')) {
          const imageIdxs = [];
          upper.forEach((v, idx) => { if (v === 'IMAGE') imageIdxs.push(idx); });
          if (imageIdxs.length >= 1) leftImageCol = imageIdxs[0];
          if (imageIdxs.length >= 2) rightImageCol = imageIdxs[1];
          break;
        }
      }
    } catch (e) {
      console.warn(`[importer] ${target.title} 헤더 감지 실패, 기본값 사용 (2/10):`, e.message);
    }

    // xlsx export 는 단일 시트만 포함 → parsed[0] 사용. sheetName 은 원래 이름으로 대체.
    const sheetImages = parsed[0]?.images || [];
    stats.tabsProcessed.push({
      tab: target.title, imageCount: sheetImages.length,
      leftImageCol, rightImageCol,
    });

    for (const img of sheetImages) {
      const rowIndex = img.fromRow + 1;
      let side;
      if (img.fromCol === leftImageCol) side = 'left';
      else if (img.fromCol === rightImageCol) side = 'right';
      else continue;

      const key = `${target.title.replace(/[^\w\-]/g, '_')}/${rowIndex}-${side}.${_extFromContentType(img.contentType)}`;
      try {
        const url = await uploadToStorage(bucket, key, img.mediaBytes, img.contentType);
        const { error: upsertErr } = await db.from('catalog_image_overrides').upsert({
          tab: target.title,           // 원래 탭 이름 (사장님이 카탈로그 조회 시 쓰는 이름)
          row_index: rowIndex,
          side,
          image_url: url,
          updated_by: userId || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tab,row_index,side' });
        if (upsertErr) throw upsertErr;
        stats.imagesImported++;
        stats.overridesUpserted++;
      } catch (e) {
        stats.errors.push({ tab: target.title, rowIndex, side, error: e.message });
      }
    }
  }

  return stats;
}

function _extFromContentType(ct) {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[ct] || 'bin';
}

module.exports = {
  exportXlsx,
  exportSheetXlsx,
  listSheetGids,
  parseXlsxImages,
  importSheetImages,
};
