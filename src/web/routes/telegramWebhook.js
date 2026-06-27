'use strict';

/**
 * Telegram Webhook Route — /api/telegram/webhook
 *
 * 텔레그램 인라인 버튼 클릭을 처리한다.
 * callback_data 포맷: "reprice:approve:SKU:itemId:newPrice"
 *                  또는 "reprice:reject:SKU"
 *
 * 동작:
 *   approve → eBay 가격 실제 변경 → 결과 메시지로 버튼 교체
 *   reject  → "거부됨" 메시지로 버튼 교체
 */

const express = require('express');
const router = express.Router();
const telegram = require('../../services/telegramBot');
const EbayAPI = require('../../api/ebayAPI');
const { getClient } = require('../../db/supabaseClient');

/**
 * POST /api/telegram/webhook
 * 텔레그램 서버가 이 엔드포인트로 update를 전달
 */
router.post('/', express.json(), async (req, res) => {
  // 텔레그램에 즉시 200 응답 (안 하면 재시도 폭탄)
  res.sendStatus(200);

  const update = req.body;

  // callback_query (인라인 버튼 클릭)
  if (update.callback_query) {
    handleCallbackQuery(update.callback_query).catch(e =>
      console.error('[TgWebhook] callback error:', e.message)
    );
  }

  // 일반 메시지 (명령어 처리)
  if (update.message?.text) {
    handleMessage(update.message).catch(e =>
      console.error('[TgWebhook] message error:', e.message)
    );
  }
});

/**
 * 인라인 버튼 클릭 처리
 */
async function handleCallbackQuery(query) {
  const { id: callbackId, data, message, from } = query;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const userName = from?.first_name || from?.username || '관리자';

  if (!data) return;

  // reprice:approve:SKU:itemId:newPrice
  // reprice:reject:SKU
  if (data.startsWith('reprice:')) {
    const parts = data.split(':');
    const action = parts[1]; // approve | reject
    const sku = parts[2];
    const itemId = parts[3];
    const newPrice = parseFloat(parts[4]);

    if (action === 'approve') {
      await telegram.answerCallbackQuery(callbackId, '⏳ 가격 변경 중...');
      await processApprove({ sku, itemId, newPrice, chatId, messageId, userName });
    } else if (action === 'reject') {
      await telegram.answerCallbackQuery(callbackId, '❌ 거부됨');
      await processReject({ sku, chatId, messageId, userName });
    }
    return;
  }

  // pipeline:run:dryRun
  if (data.startsWith('pipeline:')) {
    const parts = data.split(':');
    const action = parts[1];
    if (action === 'run_dry') {
      await telegram.answerCallbackQuery(callbackId, '⏳ 시뮬레이션 실행 중...');
      const { runRepricingPipeline } = require('../../jobs/repricingPipelineJob');
      await runRepricingPipeline({ dryRun: true });
    } else if (action === 'run_live') {
      await telegram.answerCallbackQuery(callbackId, '⏳ 실적용 실행 중...');
      const { runRepricingPipeline } = require('../../jobs/repricingPipelineJob');
      await runRepricingPipeline({ dryRun: false });
    }
    return;
  }

  await telegram.answerCallbackQuery(callbackId, '알 수 없는 명령');
}

/**
 * 가격 변경 승인 처리
 */
async function processApprove({ sku, itemId, newPrice, chatId, messageId, userName }) {
  const db = getClient();

  try {
    // eBay API로 실제 가격 변경
    const ebay = new EbayAPI();

    // itemId가 없으면 DB에서 조회
    let targetItemId = itemId && itemId !== 'null' ? itemId : null;
    if (!targetItemId) {
      const { data: ep } = await db
        .from('ebay_products').select('item_id').eq('sku', sku).neq('status', 'ended').limit(1).single();
      targetItemId = ep?.item_id;
    }

    if (!targetItemId) {
      await telegram.editMessage(chatId, messageId,
        `❌ *승인 실패* — \`${sku}\`\n\neBay item ID를 찾을 수 없습니다.`,
        [] // 버튼 제거
      );
      return;
    }

    // 기존 가격 조회
    const { data: ep } = await db
      .from('ebay_products').select('price_usd').eq('item_id', targetItemId).single();
    const oldPrice = ep?.price_usd || 0;

    // eBay 가격 업데이트
    const result = await ebay.updateItem(targetItemId, { price: newPrice });

    if (result?.success) {
      // DB도 업데이트
      await db.from('ebay_products').update({
        price_usd: newPrice,
        updated_at: new Date().toISOString(),
      }).eq('item_id', targetItemId);

      // repricer_log 기록
      await db.from('repricer_log').insert({
        item_id: targetItemId,
        sku,
        old_price: oldPrice,
        new_price: newPrice,
        reason: `텔레그램 승인 (${userName})`,
        status: 'applied',
      }).catch(() => {});

      // 메시지 버튼을 결과로 교체
      await telegram.editMessage(chatId, messageId,
        `✅ *가격 변경 완료*\n\n\`${sku}\`\n$${oldPrice} → *$${newPrice}*\n\n승인: ${userName}`,
        [] // 버튼 제거
      );
    } else {
      await telegram.editMessage(chatId, messageId,
        `❌ *가격 변경 실패* — \`${sku}\`\n\n${result?.error || 'eBay API 오류'}\n\n수동으로 확인해주세요.`,
        [] // 버튼 제거
      );
    }
  } catch (e) {
    console.error('[TgWebhook] approve error:', e.message);
    await telegram.editMessage(chatId, messageId,
      `❌ *오류 발생* — \`${sku}\`\n\n${e.message}`,
      []
    ).catch(() => {});
  }
}

/**
 * 가격 변경 거부 처리
 */
async function processReject({ sku, chatId, messageId, userName }) {
  await telegram.editMessage(chatId, messageId,
    `🚫 *거부됨* — \`${sku}\`\n\n${userName}이(가) 가격 변경을 거부했습니다.`,
    [] // 버튼 제거
  );
}

/**
 * 텍스트 명령어 처리 (/status, /pipeline 등)
 */
async function handleMessage(message) {
  const text = (message.text || '').trim();
  if (!text.startsWith('/')) return;

  const cmd = text.split(' ')[0].toLowerCase();

  if (cmd === '/status') {
    const db = getClient();
    const { count: alertCount } = await db
      .from('competitor_alerts')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .catch(() => ({ count: 0 }));

    const { count: logCount } = await db
      .from('repricer_log')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', new Date().toISOString().slice(0, 10))
      .catch(() => ({ count: 0 }));

    await telegram.sendMessage(
      `📊 *PMC 리프라이싱 현황*\n\n` +
      `경쟁사 변동 (24h): ${alertCount || 0}건\n` +
      `오늘 가격 변경: ${logCount || 0}건`
    );
  }

  if (cmd === '/run') {
    await telegram.sendWithButtons(
      `⚔️ *리프라이싱 파이프라인 실행*\n\n모드를 선택하세요:`,
      [[
        { text: '🔍 시뮬레이션', callback_data: 'pipeline:run_dry' },
        { text: '🚀 실적용', callback_data: 'pipeline:run_live' },
      ]]
    );
  }
}

module.exports = router;
