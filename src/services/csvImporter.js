/**
 * CSV/Excel Importer — Bulk product import from crawling results
 * Parses CSV/XLSX files, validates rows, and batch-registers products.
 */
const ExcelJS = require('exceljs');
const path = require('path');
const pricingEngine = require('./pricingEngine');
const { useSupabase, getProductRepo, getSyncRepo } = require('./dataSource');

// Expected column headers (Korean → internal field name)
const COLUMN_MAP = {
  'SKU': 'sku',
  'sku': 'sku',
  '상품명': 'title',
  'title': 'title',
  '상품명(영문)': 'titleEn',
  'titleEn': 'titleEn',
  'title_en': 'titleEn',
  '매입가': 'purchasePrice',
  '매입가(원)': 'purchasePrice',
  'purchasePrice': 'purchasePrice',
  'purchase_price': 'purchasePrice',
  '무게': 'weight',
  '무게(kg)': 'weight',
  'weight': 'weight',
  '카테고리': 'category',
  'category': 'category',
  '수량': 'quantity',
  'quantity': 'quantity',
  '목표마진': 'targetMargin',
  '목표마진(%)': 'targetMargin',
  'targetMargin': 'targetMargin',
  'target_margin': 'targetMargin',
  '상태': 'condition',
  'condition': 'condition',
  '키워드': 'keywords',
  'keywords': 'keywords',
  '이미지URL': 'imageUrls',
  '이미지': 'imageUrls',
  'imageUrls': 'imageUrls',
  'image_urls': 'imageUrls',
  '상품설명': 'description',
  'description': 'description',
  '상품설명(영문)': 'descriptionEn',
  'descriptionEn': 'descriptionEn',
  'description_en': 'descriptionEn',
};

const REQUIRED_FIELDS = ['sku', 'title', 'purchasePrice'];

/**
 * Parse a CSV or XLSX file into an array of row objects
 */
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const workbook = new ExcelJS.Workbook();

  if (ext === '.csv') {
    await workbook.csv.readFile(filePath);
  } else if (ext === '.xlsx' || ext === '.xls') {
    await workbook.xlsx.readFile(filePath);
  } else {
    throw new Error(`Unsupported file format: ${ext}. Use .csv or .xlsx`);
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount < 2) {
    throw new Error('File is empty or has no data rows');
  }

  // Map header row to internal field names
  const headerRow = worksheet.getRow(1);
  const columnMapping = []; // index → fieldName
  headerRow.eachCell((cell, colNumber) => {
    const headerText = String(cell.value || '').trim();
    const fieldName = COLUMN_MAP[headerText];
    if (fieldName) {
      columnMapping[colNumber] = fieldName;
    }
  });

  if (columnMapping.filter(Boolean).length === 0) {
    throw new Error('No recognized column headers found. Expected: SKU, 상품명, 매입가(원) etc.');
  }

  // Parse data rows
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const item = {};
    let hasValue = false;

    row.eachCell((cell, colNumber) => {
      const fieldName = columnMapping[colNumber];
      if (!fieldName) return;

      let value = cell.value;
      // Handle ExcelJS rich text
      if (value && typeof value === 'object' && value.richText) {
        value = value.richText.map(r => r.text).join('');
      }
      // Handle formula results
      if (value && typeof value === 'object' && value.result !== undefined) {
        value = value.result;
      }

      if (value !== null && value !== undefined && String(value).trim() !== '') {
        hasValue = true;
        item[fieldName] = String(value).trim();
      }
    });

    if (hasValue && item.sku) {
      item._rowNumber = rowNumber;
      rows.push(item);
    }
  });

  return rows;
}

/**
 * Validate parsed rows. Returns { valid: [...], errors: [...] }
 */
function validateRows(rows) {
  const valid = [];
  const errors = [];
  const skuSet = new Set();

  rows.forEach((row, index) => {
    const rowErrors = [];

    // Check required fields
    for (const field of REQUIRED_FIELDS) {
      if (!row[field] || String(row[field]).trim() === '') {
        const label = field === 'sku' ? 'SKU' : field === 'title' ? '상품명' : '매입가';
        rowErrors.push(`${label} 필수`);
      }
    }

    // Validate purchasePrice is numeric
    if (row.purchasePrice && isNaN(parseFloat(row.purchasePrice))) {
      rowErrors.push('매입가 숫자 아님');
    }

    // Check duplicate SKU within file
    if (row.sku) {
      if (skuSet.has(row.sku)) {
        rowErrors.push('파일 내 SKU 중복');
      }
      skuSet.add(row.sku);
    }

    // Validate weight if provided
    if (row.weight && isNaN(parseFloat(row.weight))) {
      rowErrors.push('무게 숫자 아님');
    }

    if (rowErrors.length > 0) {
      errors.push({
        row: row._rowNumber || (index + 2),
        sku: row.sku || '-',
        errors: rowErrors,
      });
    } else {
      valid.push(normalizeRow(row));
    }
  });

  return { valid, errors, total: rows.length };
}

/**
 * Normalize a raw parsed row into a structured product object
 */
function normalizeRow(row) {
  return {
    sku: row.sku,
    title: row.title || '',
    titleEn: row.titleEn || row.title || '',
    description: row.description || '',
    descriptionEn: row.descriptionEn || '',
    purchasePrice: parseFloat(row.purchasePrice) || 0,
    weight: parseFloat(row.weight) || 0,
    category: row.category || '기타',
    quantity: parseInt(row.quantity) || 10,
    targetMargin: row.targetMargin ? parseFloat(row.targetMargin) : null,
    condition: row.condition || 'new',
    keywords: row.keywords ? row.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
    imageUrls: row.imageUrls ? row.imageUrls.split(',').map(u => u.trim()).filter(Boolean) : [],
    _rowNumber: row._rowNumber,
  };
}

/**
 * Process validated rows — register products in Supabase + calculate prices
 * @param {Array} rows - validated & normalized rows
 * @param {Object} options - { defaultMargin, targetPlatforms }
 * @returns {Object} { total, success, failed, results: [{sku, status, prices?, error?}] }
 */
async function processRows(rows, options = {}) {
  const { defaultMargin = 30 } = options;
  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    try {
      const margin = row.targetMargin !== null ? row.targetMargin : defaultMargin;
      const prices = pricingEngine.calculatePrices({
        purchasePrice: row.purchasePrice,
        weight: row.weight,
        targetMargin: margin,
      });

      // Upsert to Supabase products table
      if (useSupabase()) {
        const repo = getProductRepo();
        const ebayPrice = prices.ebay && !prices.ebay.error ? prices.ebay.price : null;
        const ebayShipping = prices.ebay && !prices.ebay.error ? prices.ebay.shipping : null;
        const profitKrw = prices.ebay && !prices.ebay.error ? prices.ebay.estimatedProfit : 0;
        const marginPct = prices.ebay && !prices.ebay.error ? prices.ebay.margin : 0;

        const productData = {
          sku: row.sku,
          title: row.titleEn || row.title,
          title_ko: row.title,
          purchase_price: row.purchasePrice,
          weight: row.weight,
          price_usd: ebayPrice,
          shipping_usd: ebayShipping,
          profit_krw: profitKrw,
          margin_pct: marginPct,
          category: row.category,
          quantity: row.quantity,
          condition: row.condition,
          description: row.descriptionEn || row.description,
          description_ko: row.description,
          keywords: row.keywords,
          image_urls: row.imageUrls,
          updated_at: new Date().toISOString(),
        };

        await repo.db
          .from('products')
          .upsert(productData, { onConflict: 'sku' });
      }

      results.push({
        sku: row.sku,
        title: row.title,
        status: 'success',
        prices: {
          ebay: prices.ebay && !prices.ebay.error ? `$${prices.ebay.price}` : null,
          shopify: prices.shopify && !prices.shopify.error ? `$${prices.shopify.price}` : null,
          naver: prices.naver && !prices.naver.error ? `₩${prices.naver.price.toLocaleString()}` : null,
        },
      });
      successCount++;
    } catch (err) {
      results.push({
        sku: row.sku,
        title: row.title,
        status: 'failed',
        error: err.message,
      });
      failedCount++;
    }
  }

  // Log import to sync_history
  if (useSupabase()) {
    try {
      await getSyncRepo().logSync(
        'csv_import',
        'bulk_import',
        failedCount === 0 ? 'success' : 'partial',
        successCount,
        { total: rows.length, failed: failedCount },
        failedCount > 0 ? `${failedCount} rows failed` : ''
      );
    } catch (e) {
      console.error('Sync log error:', e.message);
    }
  }

  return {
    total: rows.length,
    success: successCount,
    failed: failedCount,
    results,
  };
}

/**
 * Return expected CSV column definitions for template download
 */
function getExpectedColumns() {
  return [
    { header: 'SKU', key: 'sku', required: true, example: 'PMC-001' },
    { header: '상품명', key: 'title', required: true, example: '보드게임 세트' },
    { header: '상품명(영문)', key: 'titleEn', required: false, example: 'Board Game Set' },
    { header: '매입가(원)', key: 'purchasePrice', required: true, example: '5000' },
    { header: '무게(kg)', key: 'weight', required: false, example: '0.5' },
    { header: '카테고리', key: 'category', required: false, example: '보드게임' },
    { header: '수량', key: 'quantity', required: false, example: '10' },
    { header: '목표마진(%)', key: 'targetMargin', required: false, example: '30' },
    { header: '상태', key: 'condition', required: false, example: 'new' },
    { header: '키워드', key: 'keywords', required: false, example: '보드게임,가족게임' },
    { header: '이미지URL', key: 'imageUrls', required: false, example: 'https://...' },
    { header: '상품설명', key: 'description', required: false, example: '상세 설명' },
    { header: '상품설명(영문)', key: 'descriptionEn', required: false, example: 'Description' },
  ];
}

/**
 * Generate a CSV template file buffer
 */
async function generateTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('상품 템플릿');

  const columns = getExpectedColumns();
  sheet.columns = columns.map(c => ({
    header: c.header + (c.required ? ' *' : ''),
    key: c.key,
    width: Math.max(c.header.length * 2, 15),
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE94560' } };
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  // Add example row
  const exampleData = {};
  columns.forEach(c => { exampleData[c.key] = c.example; });
  sheet.addRow(exampleData);

  return await workbook.xlsx.writeBuffer();
}

module.exports = {
  parseFile,
  validateRows,
  processRows,
  getExpectedColumns,
  generateTemplate,
  COLUMN_MAP,
};
