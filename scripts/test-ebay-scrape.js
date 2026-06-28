
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const axios = require('axios');
const cheerio = require('cheerio');

async function testScrape(seller) {
  const url = `https://www.ebay.com/sch/${seller}/m.html?_nkw=&_armrs=1&_ipg=240&rt=nc&LH_BIN=1`;
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const $ = cheerio.load(resp.data);
  const items = [];

  $('.s-item').each(function () {
    const title = $(this).find('.s-item__title').text().trim();
    const priceText = $(this).find('.s-item__price').text().trim();
    const link = $(this).find('a.s-item__link').attr('href') || '';
    const itemId = link.match(/\/(\d{10,})/)?.[1] || '';
    const img = $(this).find('.s-item__image-img').attr('src') || '';
    const shipping = $(this).find('.s-item__shipping').text().trim();
    if (title && title !== 'Shop on eBay' && itemId) {
      items.push({ itemId, title: title.slice(0, 70), priceText, shipping, img: img.slice(0, 60) });
    }
  });

  const totalText = $('h1.srp-controls__count-heading').text().trim() ||
                    $('.srp-controls__count-heading').text().trim();
  return { seller, total: totalText, fetched: items.length, samples: items.slice(0, 5) };
}

async function main() {
  for (const seller of ['onmom_house', 'hello_kr', 'actkorea']) {
    try {
      const r = await testScrape(seller);
      console.log(`\n[${r.seller}] 총: ${r.total} | 파싱: ${r.fetched}개`);
      r.samples.forEach(i => console.log(`  - ${i.itemId} | ${i.title} | ${i.priceText}`));
    } catch (e) {
      console.log(`[${seller}] 실패: ${e.response?.status} ${e.message?.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

main().catch(console.error);
