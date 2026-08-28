/**
 * XLSX → PDF 로컬 변환 (LibreOffice headless)
 *
 * 왜 로컬인가:
 *   이전에는 googleDriveAPI.convertXlsxToPdf() 로 Drive 에 임시 파일을 업로드 →
 *   Google Sheets 로 변환 → PDF export → 임시 파일 삭제하는 경로였다.
 *   1단계가 Drive '쓰기' 라서 service account 용량이 차면 PDF 버튼만 죽었다
 *   (xlsx 는 Storage 에서 바로 받으므로 멀쩡 — 실제로 이 증상으로 신고됨).
 *   인보이스 템플릿(templates/b2b_invoice_master.xlsx)에는 CCOREA 로고와
 *   대표 서명 이미지가 박혀 있어서 HTML 재구현은 문서가 달라진다.
 *   LibreOffice 는 xlsx 를 그대로 렌더링하므로 서명/로고/셀 서식이 보존된다.
 *
 * 배포:
 *   Dockerfile 에서 libreoffice-calc 설치. SOFFICE_BIN 으로 경로 override 가능.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 후보 경로 — 명시 env > PATH > macOS 기본 설치 위치
const SOFFICE_CANDIDATES = [
  process.env.SOFFICE_BIN,
  'soffice',
  'libreoffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

let _resolvedBin = null;

/**
 * 사용 가능한 soffice 실행 파일을 찾는다. 없으면 null.
 * 결과는 프로세스 수명 동안 캐시.
 */
function resolveSofficeBin() {
  if (_resolvedBin !== null) return _resolvedBin || null;
  for (const bin of SOFFICE_CANDIDATES) {
    // 절대 경로면 존재 여부만, 아니면 --version 으로 PATH 탐색
    if (bin.includes('/')) {
      if (fs.existsSync(bin)) { _resolvedBin = bin; return bin; }
      continue;
    }
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (!probe.error && probe.status === 0) { _resolvedBin = bin; return bin; }
  }
  _resolvedBin = false;
  return null;
}

function isAvailable() {
  return resolveSofficeBin() !== null;
}

/**
 * xlsx 버퍼를 PDF 버퍼로 변환한다.
 *
 * @param {Buffer} xlsxBuffer
 * @param {string} baseName  임시 파일 basename (확장자 제외). 로그/디버깅용.
 * @returns {Promise<Buffer>} PDF 버퍼
 * @throws LibreOffice 미설치 또는 변환 실패 시
 */
async function convertXlsxToPdf(xlsxBuffer, baseName = 'document') {
  if (!Buffer.isBuffer(xlsxBuffer) || xlsxBuffer.length === 0) {
    throw new Error('xlsxToPdf: 빈 xlsx 버퍼');
  }

  const bin = resolveSofficeBin();
  if (!bin) {
    throw new Error(
      'LibreOffice(soffice) 를 찾을 수 없어 PDF 변환 불가 — ' +
      'Docker 이미지에 libreoffice-calc 설치 또는 SOFFICE_BIN 환경변수 설정 필요. ' +
      '(xlsx 다운로드는 정상 동작합니다)'
    );
  }

  // 파일명에 쓸 수 없는 문자 제거 — invoiceNo 가 그대로 들어온다.
  const safeBase = String(baseName).replace(/[^A-Za-z0-9._-]/g, '_') || 'document';

  // 호출마다 독립 작업 디렉터리.
  // LibreOffice 는 동시 실행 시 user profile 을 공유하면 두 번째 프로세스가
  // 조용히 죽는다 → -env:UserInstallation 으로 프로필도 호출별로 분리.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx2pdf-'));
  const profileDir = path.join(workDir, 'profile');
  const inputPath = path.join(workDir, `${safeBase}.xlsx`);
  const outputPath = path.join(workDir, `${safeBase}.pdf`);

  try {
    fs.writeFileSync(inputPath, xlsxBuffer);

    const result = spawnSync(bin, [
      '--headless',
      '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf:calc_pdf_Export',
      '--outdir', workDir,
      inputPath,
    ], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') {
        throw new Error('LibreOffice PDF 변환 시간 초과 (120초)');
      }
      throw new Error(`LibreOffice 실행 실패: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim() || (result.stdout || '').trim();
      throw new Error(`LibreOffice 비정상 종료 (code ${result.status}): ${stderr}`);
    }
    // soffice 는 변환에 실패해도 exit 0 을 반환하는 경우가 있어 산출물로 확인한다.
    if (!fs.existsSync(outputPath)) {
      const stderr = (result.stderr || '').trim() || (result.stdout || '').trim();
      throw new Error(`PDF 산출물 없음 — LibreOffice 변환 실패. ${stderr}`);
    }

    const pdf = fs.readFileSync(outputPath);
    if (pdf.length === 0) throw new Error('PDF 산출물이 비어 있음');
    return pdf;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
  }
}

module.exports = {
  convertXlsxToPdf,
  isAvailable,
  resolveSofficeBin,
};
