'use strict';

/**
 * src/services/shipping/xlsxParser.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Minimal xlsx reader tuned for CCOREA_통합배송비_기본데이터_v1.xlsx.
 *
 * Why not exceljs (already in package.json)?
 *   The workbook stores inline strings (`t="str"` with `<x:v>` children) and
 *   an empty sharedStrings.xml. Exceljs's model builder threw
 *   `Cannot read properties of undefined (reading 'sheets')` on this shape.
 *   Rather than add a new dependency, we use jszip (already resolved as an
 *   exceljs transitive) + a tight XML sweep over cell references.
 *
 * Public surface:
 *   parseXlsxFromBuffer(buffer) → Map<sheetName, rows[]>
 *     rows[] = array of objects keyed by the header row (row 1).
 *
 * Guarantees:
 *   · Cell references are parsed ("A1" → column 0), so empty cells never
 *     misalign columns (this is what the earlier "vals" regex bug did).
 *   · Values are typed by the cell's `t` attribute; unknown types fall back
 *     to raw text (never silently coerced).
 *   · No workbook is written, no external network I/O.
 */

const JSZip = require('jszip');

//   Match ONE `<x:c ...>[<x:v>text</x:v>][<x:is><x:t>text</x:t></x:is>]</x:c>` cell or self-closing `<x:c ... />`.
//   Capture group 1 = attributes, 2 = optional value inner, 3 = optional inlineStr inner.
const CELL_RE = /<x:c\s+([^>]*?)\/?>(?:<x:v>([^<]*)<\/x:v>|<x:is><x:t(?:\s[^>]*)?>([^<]*)<\/x:t><\/x:is>)?<\/x:c>|<x:c\s+([^>]*?)\/>/g;
const ROW_RE  = /<x:row\s+([^>]*)>([\s\S]*?)<\/x:row>/g;
const REF_RE  = /r="([A-Z]+)(\d+)"/;
const TYPE_RE = /t="([^"]+)"/;

//   "A" → 0, "B" → 1, "Z" → 25, "AA" → 26, etc.
function colLetterToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

//   Read every `<sheet name=... r:id=... sheetId=...>` in workbook.xml.
function parseWorkbookSheets(workbookXml, relsXml) {
  const rels = new Map();
  //   Attribute order is workbook-dependent; capture the whole element and pull
  //   Id / Target from within (spec: attributes may appear in any order).
  const relRe = /<Relationship\s+([^>]+?)\/?>/g;
  let m;
  while ((m = relRe.exec(relsXml)) !== null) {
    const idM     = /Id="([^"]+)"/.exec(m[1]);
    const targetM = /Target="([^"]+)"/.exec(m[1]);
    if (idM && targetM) rels.set(idM[1], targetM[1]);
  }
  const out = [];
  //   Sheet nodes carry the `r:id` attribute; some workbook variants prefix
  //   the sheet element with `x:sheet` or plain `sheet`. Match both.
  const sheetRe = /<(?:x:)?sheet\s+([^>]*?)\/?>/g;
  while ((m = sheetRe.exec(workbookXml)) !== null) {
    const attrs = m[1];
    const nameM = /name="([^"]+)"/.exec(attrs);
    const rIdM  = /r:id="([^"]+)"/.exec(attrs);
    if (!nameM || !rIdM) continue;
    const target = rels.get(rIdM[1]);
    if (!target) continue;
    //   Normalize to the full zip path.
    //   Some files write "/xl/worksheets/sheet1.xml" (absolute-ish),
    //   others "worksheets/sheet1.xml" (relative to xl/).
    let path;
    if (target.startsWith('/')) path = target.replace(/^\/+/, '');
    else if (target.startsWith('xl/')) path = target;
    else path = 'xl/' + target;
    out.push({ name: nameM[1], path });
  }
  return out;
}

//   Turn one `<x:row>` block into an object keyed by column index.
function parseRowCells(rowBody, sharedStrings) {
  const cells = {};
  //   Fresh regex per row (global state).
  const re = new RegExp(CELL_RE.source, 'g');
  let m;
  while ((m = re.exec(rowBody)) !== null) {
    const attrs = m[1] || m[4];
    const valInner = m[2];
    const inlineStr = m[3];
    if (!attrs) continue;
    const refM = REF_RE.exec(attrs);
    if (!refM) continue;
    const colIdx = colLetterToIndex(refM[1]);
    const typeM = TYPE_RE.exec(attrs);
    const t = typeM ? typeM[1] : null;
    let value;
    if (inlineStr !== undefined) {
      value = inlineStr;
    } else if (valInner === undefined) {
      //   Self-closing cell with no value.
      continue;
    } else if (t === 's') {
      const idx = parseInt(valInner, 10);
      value = sharedStrings[idx] || '';
    } else if (t === 'b') {
      value = valInner === '1';
    } else if (t === 'n' || t === null) {
      const n = Number(valInner);
      value = Number.isFinite(n) ? n : valInner;
    } else {
      //   'str', 'inlineStr' (rare), 'e', 'd', etc. — hold raw text.
      value = valInner;
    }
    cells[colIdx] = value;
  }
  return cells;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  //   Both simple `<x:si><x:t>text</x:t></x:si>` and rich-text `<x:si><x:r>...`
  //   variants exist. We flatten inner text for both.
  const siRe = /<x:si>([\s\S]*?)<\/x:si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    const chunks = inner.match(/<x:t(?:\s[^>]*)?>([^<]*)<\/x:t>/g) || [];
    out.push(chunks.map(c => c.replace(/<[^>]+>/g, '')).join(''));
  }
  return out;
}

//   Parse one worksheet into an array of objects keyed by header names
//   captured from row 1. Rows with fewer cells than expected produce
//   `undefined` for missing keys (never silently repeat prior value).
function parseSheetToRows(sheetXml, sharedStrings) {
  const rows = [];
  const rowRe = new RegExp(ROW_RE.source, 'g');
  let m;
  let headers = null;
  while ((m = rowRe.exec(sheetXml)) !== null) {
    const attrs  = m[1];
    const body   = m[2];
    const idxM   = /r="(\d+)"/.exec(attrs);
    if (!idxM) continue;
    const rowNum = parseInt(idxM[1], 10);
    const cells  = parseRowCells(body, sharedStrings);
    if (rowNum === 1) {
      //   Header row — column index → header name.
      headers = [];
      const colIdxs = Object.keys(cells).map(Number).sort((a, b) => a - b);
      for (const c of colIdxs) headers[c] = String(cells[c] || '').trim();
      continue;
    }
    if (!headers) continue;   //   Skip data rows that arrive before the header.
    //   Build an object keyed by header names.
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = cells[c];   //   undefined for missing cells — caller decides how to handle.
    }
    obj._rowNum = rowNum;
    rows.push(obj);
  }
  return rows;
}

/**
 * Parse a buffer holding an entire .xlsx workbook. Returns a Map of
 * sheetName → rows[], where each row is an object keyed by header row.
 *
 * Fails fast on:
 *   · Not-a-zip payload (jszip throws)
 *   · Missing xl/workbook.xml (spec violation — corrupt xlsx)
 *
 * Sheets with zero data rows still appear in the map (rows = []).
 */
async function parseXlsxFromBuffer(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbookFile = zip.file('xl/workbook.xml');
  const relsFile     = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookFile) throw new Error('xlsx malformed: xl/workbook.xml missing');
  if (!relsFile)     throw new Error('xlsx malformed: xl/_rels/workbook.xml.rels missing');
  const workbookXml = await workbookFile.async('string');
  const relsXml     = await relsFile.async('string');
  const sheets      = parseWorkbookSheets(workbookXml, relsXml);
  const sharedFile  = zip.file('xl/sharedStrings.xml');
  const sharedXml   = sharedFile ? await sharedFile.async('string') : '';
  const sharedStrings = parseSharedStrings(sharedXml);
  const out = new Map();
  for (const { name, path } of sheets) {
    const file = zip.file(path);
    if (!file) { out.set(name, []); continue; }
    const xml = await file.async('string');
    out.set(name, parseSheetToRows(xml, sharedStrings));
  }
  return out;
}

module.exports = {
  parseXlsxFromBuffer,
  //   internal helpers exported for focused tests only
  colLetterToIndex,
  parseSharedStrings,
};
