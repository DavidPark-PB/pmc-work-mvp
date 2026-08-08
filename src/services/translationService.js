/**
 * Translation Service — Auto-translate product data.
 * 2026-08-08: Anthropic → Gemini 전환.
 * Stores results in `translations` table for caching and manual review.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const geminiClient = require('./geminiClient');

class TranslationService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
  }

  _getRepo() {
    const PlatformRepository = require('../db/platformRepository');
    return new PlatformRepository();
  }

  _getProductRepo() {
    const ProductRepository = require('../db/productRepository');
    return new ProductRepository();
  }

  /**
   * Translate a product's title, description, and keywords to the target language.
   * Saves to translations table and returns the translation.
   */
  async translateProduct(productId, targetLang = 'en') {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in config/.env');
    }

    // Load product
    const repo = this._getProductRepo();
    const { data: product, error } = await repo.db
      .from('products').select('*').eq('id', productId).single();
    if (error || !product) throw new Error(`Product not found: ${productId}`);

    const title = product.title_ko || product.title || '';
    const description = product.description_ko || product.description || '';
    const keywords = product.keywords || [];

    if (!title) throw new Error('Product has no title to translate');

    // Check if translation already exists
    const platRepo = this._getRepo();
    const existing = await platRepo.getTranslation(productId, targetLang);
    if (existing && existing.title) return existing;

    // Build prompt and call Gemini
    const langName = this._getLangName(targetLang);
    const prompt = this._buildTranslationPrompt(title, description, keywords, langName);
    const result = await this._callLLM(prompt);

    // Save to DB
    const translation = await platRepo.upsertTranslation(productId, targetLang, {
      source_lang: 'ko',
      title: result.title || '',
      description: result.description || '',
      keywords: result.keywords || [],
      translated_by: 'gemini',
      is_reviewed: false,
    });

    return translation;
  }

  /**
   * Get cached translation or null
   */
  async getTranslation(productId, targetLang = 'en') {
    return await this._getRepo().getTranslation(productId, targetLang);
  }

  /**
   * Batch translate multiple products
   */
  async batchTranslate(productIds, targetLang = 'en') {
    const results = [];
    for (const id of productIds) {
      try {
        const t = await this.translateProduct(id, targetLang);
        results.push({ productId: id, status: 'success', translation: t });
      } catch (err) {
        results.push({ productId: id, status: 'failed', error: err.message });
      }
    }
    return results;
  }

  /**
   * Force retranslate (ignore cache)
   */
  async retranslate(productId, targetLang = 'en') {
    // Delete existing translation first
    const platRepo = this._getRepo();
    await platRepo.db.from('translations')
      .delete().eq('product_id', productId).eq('target_lang', targetLang);
    return await this.translateProduct(productId, targetLang);
  }

  _buildTranslationPrompt(title, description, keywords, langName) {
    return `You are a professional e-commerce product translator. Translate the following Korean product information to ${langName}.

Rules:
- Translate naturally for e-commerce listings (not word-by-word)
- Keep brand names, model numbers, and measurements unchanged
- For product titles: create SEO-friendly titles (max 80 characters for eBay)
- For descriptions: make them appeal to international buyers
- For keywords: translate and add relevant English search terms

Input:
Title: ${title}
Description: ${description || '(no description)'}
Keywords: ${keywords.length > 0 ? keywords.join(', ') : '(none)'}

Respond in valid JSON format only:
{
  "title": "translated title",
  "description": "translated description",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}`;
  }

  async _callLLM(prompt) {
    let text;
    try {
      const r = await geminiClient.callGemini({
        prompt,
        maxTokens: 2000,
        expectJson: true,
        errCodePrefix: 'translation',
      });
      text = r.text;
    } catch (e) {
      throw new Error(`Translation API failed: ${e.message}`);
    }

    // Parse JSON from response
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('Translation JSON parse error:', e.message);
    }

    return { title: text.trim(), description: '', keywords: [] };
  }

  _getLangName(code) {
    const map = {
      en: 'English',
      ja: 'Japanese',
      zh: 'Chinese (Simplified)',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
    };
    return map[code] || code;
  }
}

module.exports = TranslationService;
