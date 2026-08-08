#!/usr/bin/env node
/**
 * CS Gemini 전환 검증 (mock + 실 API 조건부).
 */
require('dotenv').config({ path: __dirname + '/../config/.env' });

const csMessageAnalyzer = require('../src/services/cs/csMessageAnalyzer');
const csReplyGenerator  = require('../src/services/cs/csReplyGenerator');
const aiToneAdjuster    = require('../src/services/cs/aiToneAdjuster');
const koEnTranslator    = require('../src/services/cs/koEnTranslator');
const geminiClient      = require('../src/services/geminiClient');

const HAS_KEY = !!process.env.GEMINI_API_KEY;

const results = [];
function log(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  console.log(`\n=== Gemini 전환 검증 (GEMINI_API_KEY: ${HAS_KEY ? 'set' : 'unset → mock only'}) ===\n`);

  // 1) geminiClient 유틸 존재 확인
  log('S1: geminiClient 유틸 exports',
    typeof geminiClient.callGemini === 'function' &&
    typeof geminiClient.estimateCost === 'function' &&
    typeof geminiClient.DEFAULT_MODEL === 'string',
    `model=${geminiClient.DEFAULT_MODEL}`);

  // 2) mock 모드 확인 (key 없을 때 자동 mock)
  const analyzerMock = await csMessageAnalyzer.analyze({ message: 'hi, refund request' });
  const isMock = HAS_KEY ? !analyzerMock.mock : analyzerMock.mock;
  log('S2: csMessageAnalyzer ' + (HAS_KEY ? '실 API' : 'mock') + ' 정상 응답',
    !!analyzerMock.analysis && !!analyzerMock.analysis.customer_intent,
    `provider=${analyzerMock.provider}, mock=${analyzerMock.mock}, intent=${analyzerMock.analysis.customer_intent}`);

  // 3) reply generator
  const replyMock = await csReplyGenerator.generateReply({
    analysis: analyzerMock.analysis,
    koreanDraft: '환불 안내',
    tone: 'professional',
  });
  log('S3: csReplyGenerator ' + (HAS_KEY ? '실 API' : 'mock') + ' 정상',
    !!replyMock.reply_text,
    `provider=${replyMock.provider}, mock=${replyMock.mock}, len=${replyMock.reply_text?.length}`);

  // 4) tone adjuster (mock 모드 시 원본 반환)
  const toneMock = await aiToneAdjuster.adjustTone({ text: 'Hello, thank you for your message.' });
  log('S4: aiToneAdjuster ' + (HAS_KEY ? '실 API' : 'mock') + ' 정상',
    !!toneMock.text,
    `provider=${toneMock.provider}, mock=${toneMock.mock}, len=${toneMock.text?.length}`);

  // 5) translator (mock: '[mock ...]' prefix)
  const trMock = await koEnTranslator.translate({ text: '안녕하세요, 환불 요청드립니다.', targetLang: 'en' });
  log('S5: koEnTranslator ' + (HAS_KEY ? '실 API' : 'mock') + ' 정상',
    !!trMock.text,
    `provider=${trMock.provider}, mock=${trMock.mock}, out="${trMock.text?.slice(0, 60)}"`);

  // 6) 실 API 크레딧/키 에러 시 명확한 에러 (key 있을 때만 실행)
  if (HAS_KEY) {
    console.log('\n=== 실 Gemini API 호출 검증 ===');
    try {
      const r = await geminiClient.callGemini({
        prompt: 'Say hi in one word. Return only the word, no punctuation.',
        maxTokens: 20,
        expectJson: false,
      });
      log('S6: geminiClient 직접 호출 성공', !!r.text, `text="${r.text.slice(0, 40)}", tokens=${r.inputTokens}/${r.outputTokens}`);
    } catch (e) {
      log('S6: geminiClient 실패', false, e.message);
    }
  } else {
    console.log('\n(GEMINI_API_KEY 없음 → 실 API 검증 스킵. Railway 배포 후 사장님이 브라우저에서 확인.)');
  }

  // 결과
  console.log('\n' + '═'.repeat(60));
  const passed = results.filter(r => r.pass).length;
  console.log(`최종: ${passed}/${results.length} 통과`);
  console.log('═'.repeat(60));
  process.exit(passed === results.length ? 0 : 1);
})();
