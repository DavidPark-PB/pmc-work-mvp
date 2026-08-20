/**
 * Crawler 모듈 진입점
 */
const { BaseCrawler } = require('./BaseCrawler');
const { CoupangCrawler } = require('./CoupangCrawler');
const { generateShopifyCSV } = require('./shopify-transformer');
const parsers = require('./utils/parsers');
const humanBehavior = require('./utils/human-behavior');

module.exports = {
  BaseCrawler,
  CoupangCrawler,
  generateShopifyCSV,
  parsers,
  humanBehavior,
};
