<?php
/**
 * SEED-128 stdin/stdout wrapper.
 *
 * Node.js 가 child_process 로 호출. stdin JSON 받음, stdout 결과 출력.
 *
 * input:  {"op":"encrypt"|"decrypt", "key":"...", "data":"..."}
 * output: hex string (encrypt) 또는 평문 (decrypt). 에러 시 'ERROR: ...'.
 *
 * 우체국 공식 SEED128.php (2016) 그대로 사용 — 우체국 서버와 100% 호환.
 * JS 포팅 시 미세한 정수 처리 차이 (block 3 mismatch 등) 가 있어 PHP 직접 호출.
 */
require_once __DIR__ . '/seed128.php';

$raw = file_get_contents('php://stdin');
$input = json_decode($raw, true);
if (!is_array($input) || !isset($input['op'], $input['key'], $input['data'])) {
    fwrite(STDERR, "ERROR: invalid input JSON\n");
    exit(1);
}

try {
    $seed = new SEED128();
    if ($input['op'] === 'encrypt') {
        echo $seed->getEncryptData($input['key'], $input['data']);
    } else if ($input['op'] === 'decrypt') {
        echo $seed->getDecryptData($input['key'], $input['data']);
    } else {
        fwrite(STDERR, "ERROR: unknown op (encrypt/decrypt only)\n");
        exit(1);
    }
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR: " . $e->getMessage() . "\n");
    exit(1);
}
