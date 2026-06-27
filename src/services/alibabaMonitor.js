'use strict';

/**
 * Alibaba Competitor Monitor
 *
 * Alibaba.com 공개 검색 결과를 크롤링하여 경쟁 셀러의 MOQ/단가/배송조건을 수집.
 * ICBU Open API는 자사 상품 관리용이라 경쟁사 검색 불가 → 웹 크롤링 방식 사용.
 *
 * 동작:
 *   1. alibaba_competitor_products 테이블에서 추적 중인 키워드/URL 목록 로드
 *   2. Alibaba.com 검색 결과 페이지 크롤링 (cheerio, 1페이지)
 *   3. 이전 데이터와 비교 → 단가/MOQ 변동 감지
 *   4. 변동 있으면 alibaba_competitor_alerts 저장 + 텔레그램 알림
 *
 * 테이블: alibaba_competitor_products (마이그레이션 056 필요)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { getClient } = require('../db/supabaseClient');
const telegram = require('./telegramBot');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const DELAY_MS = 3000; // 페이지 간 딜레이 (rate limit 방지)

/**
 * Alibaba.com 검색 결과 1페이지 크롤링
 * @param {string} keyword - 검색 키워드 (영문)
 * @returns {Array} products - [{ title, price, minOrder, supplier, url, imageUrl }]
 */
async function scrapeAlibabaSearch(keyword) {
  const searchUrl = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(keyword)}&IndexArea=product_en&viewtype=G`;

  try {
    const { data: html } = await axios.get(searchUrl, {
      headers: HEADERS,
      timeout: 20000,
    });

    const $ = cheerio.load(html);
    const products = [];

    // Alibaba 검색 결과 카드 파싱
    // (selector는 Alibaba UI 변경 시 업데이트 필요)
    const selectors = [
      '.organic-list .list-no-v2-outter',
      '.search-card-e-offer-main',
      '[data-aplus-ae="offer_list"]',
      '.J-offer-wrapper',
    ];

    let found = false;
    for (const sel of selectors) {
      if ($(sel).length > 0) {
        $(sel).each((i, el) => {
          if (i >= 10) return false; // 상위 10개만
          const $el = $(el);

          // 타이틀
          const title = ($el.find('.search-card-e-title, .offer-title, h2').first().text() || '').trim().slice(0, 200);
          if (!title) return;

          // 가격 (USD 기준)
          const priceText = $el.find('.search-card-e-price-main, .price-main, .price').first().text().trim();
          const priceMatch = priceText.match(/[\d,]+\.?\d*/);
          const price = priceMatch ? parseFloat(priceMatch[0].replace(/,/g, '')) : 0;

          // MOQ
          const moqText = $el.find('.search-card-e-min-order, .moq, .min-order').first().text().trim();
          const moqMatch = moqText.match(/(\d+)/);
          const moq = moqMatch ? parseInt(moqMatch[1]) : 1;

          // 공급업체
          const supplier = ($el.find('.search-card-e-company, .company-name').first().text() || '').trim().slice(0, 100);

          // URL
          const href = $el.find('a').first().attr('href') || '';
          const url = href.startsWith('http') ? href : (href ? 'https:' + href : '');

          // 이미지
          const imgSrc = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';

          if (price > 0 || moq > 0) {
            products.push({ title, price, moq, supplier, url: url.split('?')[0], imageUrl: imgSrc });
          }
        });
        if (products.length > 0) { found = true; break; }
      }
    }

    if (!found) {
      console.warn(`[AlibabaMonitor] "${keyword}" — 파서 결과 없음 (UI 변경 가능성)`);
    }

    return products;
  } catch (e) {
    console.error(`[AlibabaMonitor] scrape error for "${keyword}":`, e.message);
    return [];
  }
}

/**
 * 추적 중인 키워드 목록 로드
 * alibaba_competitor_products 테이블이 없으면 빈 배열 반환
 */
async function loadTrackedKeywords() {
  const db = getClient();
  try {
    const { data, error } = await db
      .from('alibaba_competitor_products')
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: true }); // 오래된 것 먼저 (순서 돌아가며 체크)
    if (error) {
      if (error.code === '42P01') return []; // 테이블 없음 — 마이그레이션 미적용
      throw error;
    }
    return data || [];
  } catch (e) {
    console.warn('[AlibabaMonitor] alibaba_competitor_products 테이블 없음:', e.message);
    return [];
  }
}

/**
 * 변동 감지 + DB 업데이트 + 알림
 */
async function processResults(tracked, freshResults) {
  const db = getClient();
  const alerts = [];

  for (const track of tracked) {
    const fresh = freshResults[track.id];
    if (!fresh || fresh.length === 0) continue;

    // 최저가 공급자 기준
    const cheapest = fresh.reduce((min, p) => p.price > 0 && (!min || p.price < min.price) ? p : min, null);
    if (!cheapest) continue;

    const prevPrice = parseFloat(track.last_price) || 0;
    const prevMoq = parseInt(track.last_moq) || 0;
    const newPrice = cheapest.price;
    const newMoq = cheapest.moq;

    const priceChanged = prevPrice > 0 && Math.abs(newPrice - prevPrice) / prevPrice >= 0.03; // 3%+ 변동
    const moqChanged = prevMoq > 0 && newMoq !== prevMoq;

    // DB 업데이트
    try {
      await db.from('alibaba_competitor_products').update({
        last_price: newPrice,
        last_moq: newMoq,
        last_supplier: cheapest.supplier,
        top_results: JSON.stringify(fresh.slice(0, 5)),
        updated_at: new Date().toISOString(),
      }).eq('id', track.id);
    } catch (e) {
      console.warn('[AlibabaMonitor] DB update failed:', e.message);
    }

    if (priceChanged || moqChanged) {
      const changeType = newPrice < prevPrice ? 'price_drop' : 'price_raise';
      const pct = prevPrice > 0 ? ((newPrice - prevPrice) / prevPrice * 100).toFixed(1) : '0';
      const msg = priceChanged
        ? `[Alibaba] "${track.keyword}" 단가 변동: $${prevPrice}→$${newPrice} (${pct > 0 ? '+' : ''}${pct}%)`
        : `[Alibaba] "${track.keyword}" MOQ 변동: ${prevMoq}→${newMoq}`;

      alerts.push({
        type: changeType,
        keyword: track.keyword,
        sku: track.sku || null,
        prevPrice, newPrice, prevMoq, newMoq,
        supplier: cheapest.supplier,
        message: msg,
        changePct: pct,
      });

      // alibaba_competitor_alerts 저장
      try {
        await db.from('alibaba_competitor_alerts').insert({
          type: changeType,
          keyword: track.keyword,
          sku: track.sku || null,
          prev_price: prevPrice,
          new_price: newPrice,
          prev_moq: prevMoq,
          new_moq: newMoq,
          supplier: cheapest.supplier,
          message: msg,
          data: JSON.stringify({ priceChanged, moqChanged, fresh: fresh.slice(0, 3) }),
        });
      } catch (e) {
        console.warn('[AlibabaMonitor] alibaba_competitor_alerts insert failed:', e.message);
      }

      console.log(`[AlibabaMonitor] ALERT: ${msg}`);
    }
  }

  return alerts;
}

/**
 * 텔레그램 리포트 발송
 */
async function sendAlibabaReport(alerts, checked) {
  if (!telegram.isConfigured() || alerts.length === 0) return;

  const drops = alerts.filter(a => a.type === 'price_drop');
  const raises = alerts.filter(a => a.type === 'price_raise');

  const lines = [
    `🏭 *Alibaba 공급가 모니터*`,
    `${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
    '',
    `📡 체크: ${checked}개 키워드 | 변동: ${alerts.length}건`,
    '',
  ];

  if (drops.length > 0) {
    lines.push('*📉 단가 인하 (매입 유리)*');
    drops.slice(0, 5).forEach(a => {
      lines.push(`• \`${a.keyword}\` $${a.prevPrice}→$${a.newPrice} (${a.changePct}%) — ${a.supplier}`);
      if (a.sku) lines.push(`  연결 SKU: ${a.sku}`);
    });
    lines.push('');
  }

  if (raises.length > 0) {
    lines.push('*📈 단가 인상 (판매가 검토 필요)*');
    raises.slice(0, 5).forEach(a => {
      lines.push(`• \`${a.keyword}\` $${a.prevPrice}→$${a.newPrice} (+${a.changePct}%) — ${a.supplier}`);
    });
  }

  await telegram.sendMessage(lines.join('\n'));
}

/**
 * 메인 실행 함수
 * @param {object} opts
 * @param {boolean} opts.silent - 텔레그램 알림 없음
 * @param {number}  opts.limit  - 최대 체크 키워드 수 (기본 20)
 */
async function runAlibabaMonitor({ silent = false, limit = 20 } = {}) {
  console.log('[AlibabaMonitor] Starting...');

  const tracked = await loadTrackedKeywords();
  if (tracked.length === 0) {
    console.log('[AlibabaMonitor] 추적 키워드 없음 — alibaba_competitor_products 테이블에 키워드 등록 필요');
    return { alerts: [], checked: 0 };
  }

  const batch = tracked.slice(0, limit);
  const freshResults = {};
  let checked = 0;

  for (const track of batch) {
    const results = await scrapeAlibabaSearch(track.keyword);
    freshResults[track.id] = results;
    checked++;
    console.log(`[AlibabaMonitor] "${track.keyword}": ${results.length}개 결과`);

    if (checked < batch.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const alerts = await processResults(batch, freshResults);

  if (!silent && alerts.length > 0) {
    await sendAlibabaReport(alerts, checked);
  }

  console.log(`[AlibabaMonitor] Done: ${checked} checked, ${alerts.length} alerts`);
  return { alerts, checked };
}

module.exports = { runAlibabaMonitor, scrapeAlibabaSearch };
