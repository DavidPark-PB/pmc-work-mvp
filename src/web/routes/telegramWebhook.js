'use strict';

/**
 * Telegram Webhook Route — /api/telegram/webhook
 *
 * 텔레그램 인라인 버튼 클릭을 처리한다.
 * legacy callback_data 포맷: "reprice:approve:SKU:itemId:newPrice"
 *                         또는 "reprice:reject:SKU"
 *
 * 동작:
 *   Hermes v1: approve → 가격 변경 비활성화 안내만 표시
 *   reject  → "거부됨" 메시지로 버튼 교체
 */

const express = require('express');
const router = express.Router();
const telegram = require('../../services/telegramBot');
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

  // legacy reprice callbacks — Hermes v1에서는 가격 변경 없이 비활성화 안내만 표시
  if (data.startsWith('reprice:')) {
    const parts = data.split(':');
    const action = parts[1];
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

  // map:yes:myItemId:compItemId:seller  또는  map:no:myItemId:compItemId
  if (data.startsWith('map:')) {
    const parts = data.split(':');
    const action = parts[1];  // yes | no
    const myId   = parts[2];
    const compId = parts[3];
    const seller = parts[4] || '';

    if (action === 'yes') {
      await telegram.answerCallbackQuery(callbackId, '✅ 매핑 등록 중...');
      await processMapYes({ myId, compId, seller, chatId, messageId, userName });
    } else {
      await telegram.answerCallbackQuery(callbackId, '❌ 건너뜀');
      await telegram.editMessage(chatId, messageId,
        `❌ 다른 상품으로 표시됨\n경쟁사 ${compId} — ${userName}`,
        []
      );
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
      await telegram.answerCallbackQuery(callbackId, '🔒 Hermes v1에서는 실적용이 비활성화되어 시뮬레이션으로 실행합니다.');
      const { runRepricingPipeline } = require('../../jobs/repricingPipelineJob');
      await runRepricingPipeline({ dryRun: true });
    }
    return;
  }

  // market:detail:SHORT_ID — Hermes v1 alert 상세보기 (읽기 전용)
  if (data.startsWith('market:detail:')) {
    await telegram.answerCallbackQuery(callbackId, '상세 조회 중...');
    const shortId = data.split(':')[2];
    const { getMarketAlertDetail } = require('../../services/hermesMarketIntelligence');
    const alert = await getMarketAlertDetail(shortId);
    if (!alert) {
      await telegram.editMessage(chatId, messageId, '상세 정보를 찾을 수 없습니다.', []);
      return;
    }
    await telegram.editMessage(chatId, messageId, [
      '🔎 Hermes Market Alert 상세',
      alert.sku ? `SKU: ${alert.sku}` : '',
      alert.competitor_seller_id ? `Seller: ${alert.competitor_seller_id}` : '',
      alert.competitor_item_id ? `Item: ${alert.competitor_item_id}` : '',
      `Type: ${alert.alert_type}`,
      alert.message,
      alert.recommendation ? `추천: ${alert.recommendation}` : '',
      '',
      'Hermes v1: 가격 변경 버튼 없음 / 리포트 전용',
    ].filter(Boolean).join('\n'), []);
    return;
  }

  await telegram.answerCallbackQuery(callbackId, '알 수 없는 명령');
}

/**
 * 가격 변경 승인 처리
 */
async function processApprove({ sku, itemId, newPrice, chatId, messageId, userName }) {
  await telegram.editMessage(chatId, messageId,
    `🔒 Hermes v1: 가격 변경은 비활성화되어 있습니다.\n\n${sku}\n추천가: $${newPrice}\n\n현재는 Market Intelligence 추천만 제공됩니다.`,
    []
  );
}

/**
 * 가격 변경 거부 처리
 */
async function processReject({ sku, chatId, messageId, userName }) {
  await telegram.editMessage(chatId, messageId,
    `🚫 거부됨 — ${sku}\n\n${userName}이(가) 가격 변경을 거부했습니다.`,
    []
  );
}

/**
 * 매핑 승인 처리 (map:yes)
 * myId / compId 는 UUID 앞 8자 shortId 또는 실제 ID
 */
async function processMapYes({ myId, compId, seller, chatId, messageId, userName }) {
  const db = getClient();
  try {
    // product_matches에서 shortId로 찾기
    const { data: match } = await db
      .from('product_matches')
      .select('id, our_sku, competitor_item_id, seller_id')
      .or(`id.like.${myId}%,our_sku.eq.${myId}`)
      .eq('status', 'pending')
      .limit(1)
      .single()
      .catch(() => ({ data: null }));

    if (match) {
      // 기존 pending 매치 승인
      await db.from('product_matches').update({
        status: 'approved',
        approved_by: userName,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', match.id);

      await telegram.editMessage(chatId, messageId,
        `✅ 매핑 승인 완료\n\n내 SKU: ${match.our_sku}\n경쟁상품: ${match.competitor_item_id}\n승인: ${userName}`,
        []
      );
    } else {
      // 직접 product_matches에 insert (수동 매핑)
      await db.from('product_matches').insert({
        our_sku: myId,
        competitor_item_id: compId,
        seller_id: seller || '',
        confidence: 1.0,
        method: 'manual',
        status: 'approved',
        approved_by: userName,
        approved_at: new Date().toISOString(),
      }).onConflict('our_sku,competitor_item_id').merge();

      await telegram.editMessage(chatId, messageId,
        `✅ 매핑 수동 등록 완료\n\n내 SKU: ${myId}\n경쟁상품: ${compId}\n등록: ${userName}`,
        []
      );
    }
  } catch (e) {
    console.error('[TgWebhook] processMapYes error:', e.message);
    await telegram.editMessage(chatId, messageId,
      `❌ 매핑 등록 실패\n${e.message}`,
      []
    ).catch(() => {});
  }
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
      `⚔️ *Hermes Market Intelligence 실행*\n\nHermes v1은 시뮬레이션/추천만 제공합니다.`,
      [[
        { text: '🔍 시뮬레이션', callback_data: 'pipeline:run_dry' },
      ]]
    );
  }
}

module.exports = router;
