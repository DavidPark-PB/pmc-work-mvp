const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/master-products.json');

class MasterProductDB {
  constructor() {
    this._data = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      this._data = JSON.parse(raw);
    } catch {
      this._data = [];
    }
    return this._data;
  }

  save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this._data, null, 2), 'utf8');
  }

  _ensureLoaded() {
    if (!this._data) this.load();
  }

  getAll() {
    this._ensureLoaded();
    return this._data;
  }

  getBySku(sku) {
    this._ensureLoaded();
    return this._data.find(p => p.sku === sku) || null;
  }

  create(product) {
    this._ensureLoaded();
    if (this._data.find(p => p.sku === product.sku)) {
      throw new Error(`SKU ${product.sku} already exists`);
    }

    const now = new Date().toISOString();
    const entry = {
      sku: product.sku,
      title: product.title || '',
      titleEn: product.titleEn || product.title || '',
      description: product.description || '',
      descriptionEn: product.descriptionEn || product.description || '',
      category: product.category || '기타',
      purchasePrice: parseFloat(product.purchasePrice) || 0,
      weight: parseFloat(product.weight) || 0,
      imageUrls: product.imageUrls || [],
      keywords: product.keywords || [],
      targetMargin: parseFloat(product.targetMargin) || 30,
      quantity: parseInt(product.quantity) || 1,
      condition: product.condition || 'new',
      ebayCategoryId: product.ebayCategoryId || '',
      naverCategoryId: product.naverCategoryId || '',
      shopifyProductType: product.shopifyProductType || '',
      platforms: {},
      createdAt: now,
      updatedAt: now,
    };

    this._data.push(entry);
    this.save();
    return entry;
  }

  update(sku, updates) {
    this._ensureLoaded();
    const idx = this._data.findIndex(p => p.sku === sku);
    if (idx === -1) return null;

    const allowed = ['title', 'titleEn', 'description', 'descriptionEn', 'category',
      'purchasePrice', 'weight', 'imageUrls', 'keywords', 'targetMargin',
      'quantity', 'condition', 'ebayCategoryId', 'naverCategoryId', 'shopifyProductType'];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        if (key === 'purchasePrice' || key === 'weight' || key === 'targetMargin') {
          this._data[idx][key] = parseFloat(updates[key]);
        } else if (key === 'quantity') {
          this._data[idx][key] = parseInt(updates[key]) || 1;
        } else {
          this._data[idx][key] = updates[key];
        }
      }
    }

    this._data[idx].updatedAt = new Date().toISOString();
    this.save();
    return this._data[idx];
  }

  updatePlatformStatus(sku, platform, data) {
    this._ensureLoaded();
    const idx = this._data.findIndex(p => p.sku === sku);
    if (idx === -1) return null;

    if (!this._data[idx].platforms) this._data[idx].platforms = {};
    this._data[idx].platforms[platform] = {
      ...this._data[idx].platforms[platform],
      ...data,
      updatedAt: new Date().toISOString(),
    };

    this._data[idx].updatedAt = new Date().toISOString();
    this.save();
    return this._data[idx];
  }

  delete(sku) {
    this._ensureLoaded();
    const idx = this._data.findIndex(p => p.sku === sku);
    if (idx === -1) return false;
    this._data.splice(idx, 1);
    this.save();
    return true;
  }
}

module.exports = MasterProductDB;
