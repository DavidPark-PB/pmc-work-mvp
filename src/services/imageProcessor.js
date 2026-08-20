/**
 * Image Processor — Process product images for domestic/global markets.
 * Uses sharp for image manipulation. Stores results in product_images table.
 * Images are uploaded to Shopify CDN; Supabase stores URLs only.
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');

class ImageProcessor {
  constructor() {
    this._shopifyApi = null;
  }

  _getRepo() {
    const PlatformRepository = require('../db/platformRepository');
    return new PlatformRepository();
  }

  _getProductRepo() {
    const ProductRepository = require('../db/productRepository');
    return new ProductRepository();
  }

  _getShopifyApi() {
    if (!this._shopifyApi) {
      const ShopifyAPI = require('../api/shopifyAPI');
      this._shopifyApi = new ShopifyAPI();
    }
    return this._shopifyApi;
  }

  /**
   * Download an image from URL and return as Buffer
   */
  async _downloadImage(url) {
    if (url.startsWith('/uploads/') || url.startsWith('uploads/')) {
      const localPath = path.join(UPLOADS_DIR, path.basename(url));
      return fs.readFileSync(localPath);
    }
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    return Buffer.from(response.data);
  }

  /**
   * Process all images for a product: save original, create global variants
   */
  async processForProduct(productId) {
    const prodRepo = this._getProductRepo();
    const { data: product } = await prodRepo.db
      .from('products').select('id, sku, image_urls, image_url').eq('id', productId).single();
    if (!product) throw new Error(`Product not found: ${productId}`);

    const imageUrls = product.image_urls || (product.image_url ? [product.image_url] : []);
    if (imageUrls.length === 0) return [];

    const repo = this._getRepo();
    const results = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
        // Save original reference
        await repo.addProductImage(productId, 'original', url, i);

        // Process for global market
        const buffer = await this._downloadImage(url);
        const processed = await this._processForGlobal(buffer);

        // Save processed image locally (Shopify CDN upload can be added later)
        const filename = `global-${product.sku}-${i}-${Date.now()}.jpg`;
        const outputPath = path.join(UPLOADS_DIR, filename);
        await sharp(processed).toFile(outputPath);
        const globalUrl = `/uploads/${filename}`;

        await repo.addProductImage(productId, 'global', globalUrl, i);
        results.push({ original: url, global: globalUrl, status: 'done' });
      } catch (err) {
        console.error(`Image processing error for ${url}:`, err.message);
        results.push({ original: url, status: 'failed', error: err.message });
      }
    }

    return results;
  }

  /**
   * Process image for global market:
   * - Resize to max 1600px (eBay recommendation)
   * - White background pad
   * - Quality optimization
   */
  async _processForGlobal(buffer) {
    return await sharp(buffer)
      .resize(1600, 1600, {
        fit: 'inside',
        withoutEnlargement: true,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
  }

  /**
   * Process image for domestic market:
   * - Resize to max 1000px
   * - Keep original quality
   */
  async processForDomestic(buffer) {
    return await sharp(buffer)
      .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  /**
   * Add text watermark to image
   */
  async addWatermark(buffer, text = 'PMC Global') {
    const metadata = await sharp(buffer).metadata();
    const fontSize = Math.max(12, Math.round(metadata.width * 0.03));

    const svgText = `<svg width="${metadata.width}" height="${metadata.height}">
      <text x="${metadata.width - 10}" y="${metadata.height - 10}"
        font-family="Arial" font-size="${fontSize}" fill="rgba(255,255,255,0.5)"
        text-anchor="end">${text}</text>
    </svg>`;

    return await sharp(buffer)
      .composite([{ input: Buffer.from(svgText), gravity: 'southeast' }])
      .toBuffer();
  }

  /**
   * Generate thumbnail URL from Shopify CDN URL
   * Shopify CDN supports on-the-fly resizing via URL params
   */
  getThumbnailUrl(cdnUrl, width = 200) {
    if (!cdnUrl) return '';
    // Shopify CDN: append _WIDTHx to filename before extension
    const ext = path.extname(cdnUrl);
    const base = cdnUrl.replace(ext, '');
    return `${base}_${width}x${ext}`;
  }

  /**
   * Upload image buffer to Shopify CDN via Admin API
   * Returns the CDN URL
   */
  async uploadToShopifyCDN(buffer, filename) {
    try {
      const shopify = this._getShopifyApi();
      const base64 = buffer.toString('base64');

      // Shopify Files API or staged upload
      const result = await shopify.uploadImage({
        filename,
        attachment: base64,
      });

      return result?.src || result?.url || null;
    } catch (err) {
      console.error('Shopify CDN upload failed:', err.message);
      return null;
    }
  }

  /**
   * Get all processed images for a product, grouped by type
   */
  async getProcessedImages(productId) {
    const repo = this._getRepo();
    const images = await repo.getProductImages(productId);
    const grouped = { original: [], domestic: [], global: [] };
    images.forEach(img => {
      if (grouped[img.image_type]) grouped[img.image_type].push(img);
    });
    return grouped;
  }
}

module.exports = ImageProcessor;
