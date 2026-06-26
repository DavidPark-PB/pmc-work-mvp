/**
 * SEED-128 ECB — PHP child_process 호출 wrapper.
 *
 * 사장님 결정 2026-06-27: 우리 JS 포팅 (이전 commit) 이 PHP 와 미세한 정수 처리
 * 차이 (block 3 mismatch 등) — 며칠 추가 디버깅 필요. PHP child_process 로
 * 직접 호출하여 우체국 서버와 100% 호환 보장.
 *
 * 동작:
 *   1. Node.js 가 child_process 로 PHP 실행
 *   2. stdin 으로 {op, key, data} JSON 전달
 *   3. stdout 으로 결과 (hex 또는 평문) 받음
 *   4. 우체국 공식 SEED128.php (2016) 코드 그대로 사용
 *
 * 성능: 호출당 ~30~80ms (PHP 부팅 + SEED 연산). 라벨 발급은 자주 X (주문당 1번).
 *
 * Railway 환경 설정 (nixpacks.toml) 에 PHP 패키지 추가 필수.
 *
 * Public API 호환:
 *   encrypt(key, plain) → hex string
 *   decrypt(key, hex)   → plain string
 *   getEncryptData / getDecryptData — PHP/JAVA 함수명 별칭
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const RUNNER = path.join(__dirname, 'seed128_runner.php');
const PHP_BIN = process.env.PHP_BIN || 'php';   // Railway nixpacks 의 PHP path

function _call(op, key, data) {
  if (typeof key !== 'string' || key.length !== 16) {
    throw new Error(`SEED-128 key 는 정확히 16 ASCII 문자 필요 (현재 ${typeof key === 'string' ? key.length : typeof key})`);
  }
  const input = JSON.stringify({ op, key, data: String(data) });
  const result = spawnSync(PHP_BIN, [RUNNER], {
    input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`PHP 실행 파일 없음 — Railway nixpacks.toml 에 'php' 패키지 추가 또는 PHP_BIN 환경변수 설정 필요`);
    }
    throw new Error(`SEED PHP 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`SEED PHP 비정상 종료 (code ${result.status}): ${stderr}`);
  }
  return (result.stdout || '').trim();
}

function encrypt(key, plain) {
  return _call('encrypt', key, plain);
}

function decrypt(key, hex) {
  return _call('decrypt', key, hex);
}

module.exports = {
  encrypt,
  decrypt,
  // PHP/JAVA 함수명 별칭 (기존 호환)
  getEncryptData: encrypt,
  getDecryptData: decrypt,
  // 외부 진단용
  _internal: {
    PHP_BIN,
    RUNNER,
  },
};
