import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCREENSHOTS = path.join(__dirname, '..', 'docs', 'screenshots');
const IMAGES = path.join(__dirname, '..', 'docs', 'images');

// Ensure output dir exists
fs.mkdirSync(IMAGES, { recursive: true });

interface CropJob {
  src: string;       // source filename in screenshots/
  out: string;       // output filename in images/
  left: number;
  top: number;
  width: number;
  height: number;
}

async function getImageSize(filePath: string) {
  const meta = await sharp(filePath).metadata();
  return { width: meta.width!, height: meta.height! };
}

async function crop(job: CropJob) {
  const srcPath = path.join(SCREENSHOTS, job.src);
  const outPath = path.join(IMAGES, job.out);

  if (!fs.existsSync(srcPath)) {
    console.warn(`  SKIP: ${job.src} not found`);
    return;
  }

  const { width: imgW, height: imgH } = await getImageSize(srcPath);

  // Clamp dimensions to image bounds
  const left = Math.min(job.left, imgW);
  const top = Math.min(job.top, imgH);
  const width = Math.min(job.width, imgW - left);
  const height = Math.min(job.height, imgH - top);

  await sharp(srcPath)
    .extract({ left, top, width, height })
    .toFile(outPath);

  console.log(`  OK: ${job.out} (${width}x${height})`);
}

async function copyFull(src: string, out: string) {
  const srcPath = path.join(SCREENSHOTS, src);
  const outPath = path.join(IMAGES, out);
  if (!fs.existsSync(srcPath)) {
    console.warn(`  SKIP: ${src} not found`);
    return;
  }
  await sharp(srcPath).toFile(outPath);
  console.log(`  COPY: ${out}`);
}

async function main() {
  console.log('Cropping screenshots...\n');

  // === 로그인 ===
  // 로그인 카드 영역만 크로핑
  await crop({ src: 'login.png', out: 'login-card.png', left: 390, top: 150, width: 620, height: 500 });

  // === 대시보드 (상품관리) ===
  // 사이드바만 크로핑
  await crop({ src: 'dashboard-pending.png', out: 'sidebar-admin.png', left: 0, top: 0, width: 240, height: 900 });
  // 탭 영역
  await crop({ src: 'dashboard-pending.png', out: 'dashboard-tabs.png', left: 240, top: 140, width: 1160, height: 50 });
  // 액션바 영역
  await crop({ src: 'dashboard-pending.png', out: 'dashboard-actionbar.png', left: 240, top: 185, width: 1160, height: 55 });
  // 상단 툴바 (일괄번역, KR/EN 토글, CSV 업로드 버튼)
  await crop({ src: 'dashboard-pending.png', out: 'dashboard-toolbar.png', left: 240, top: 70, width: 1160, height: 75 });
  // 테이블 영역 (데이터 포함)
  await crop({ src: 'dashboard-pending.png', out: 'dashboard-table.png', left: 240, top: 240, width: 1160, height: 450 });
  // 전체 대시보드 (풀 카피)
  await copyFull('dashboard-pending.png', 'dashboard-full.png');
  // 데이터 없는 전체 탭
  await copyFull('dashboard.png', 'dashboard-empty.png');

  // === CSV 업로드 ===
  // 업로드 영역만 크로핑
  await crop({ src: 'upload-csv.png', out: 'upload-dropzone.png', left: 240, top: 60, width: 1160, height: 450 });

  // === 업로드 결과 ===
  // 요약 카드 영역
  await crop({ src: 'results.png', out: 'results-summary.png', left: 240, top: 30, width: 1160, height: 250 });
  // 상세 결과 테이블
  await crop({ src: 'results.png', out: 'results-detail.png', left: 240, top: 270, width: 1160, height: 380 });
  // 풀 카피
  await copyFull('results.png', 'results-full.png');

  // === 히스토리 ===
  // 세션 잡 섹션
  await crop({ src: 'history.png', out: 'history-jobs.png', left: 170, top: 30, width: 720, height: 500 });
  // 풀 카피
  await copyFull('history.png', 'history-full.png');

  // === 휴지통 ===
  // 상단 부분만 (전체는 너무 김)
  await crop({ src: 'trash.png', out: 'trash-top.png', left: 0, top: 0, width: 1400, height: 600 });

  // === 설정 ===
  // 플랫폼 카드 그리드
  await crop({ src: 'settings.png', out: 'settings-cards.png', left: 200, top: 30, width: 1200, height: 420 });
  // 가격 미리보기
  await crop({ src: 'settings.png', out: 'settings-preview.png', left: 200, top: 740, width: 900, height: 310 });
  // 풀 카피
  await copyFull('settings.png', 'settings-full.png');

  // === 토큰 관리 ===
  await copyFull('tokens.png', 'tokens-full.png');
  // eBay 토큰 카드만
  await crop({ src: 'tokens.png', out: 'tokens-ebay.png', left: 240, top: 65, width: 380, height: 340 });

  // === 직원 관리 ===
  await copyFull('staff.png', 'staff-full.png');
  // 직원 추가 폼
  await crop({ src: 'staff.png', out: 'staff-add-form.png', left: 240, top: 70, width: 1160, height: 220 });
  // 직원 목록 테이블
  await crop({ src: 'staff.png', out: 'staff-list.png', left: 240, top: 290, width: 1160, height: 200 });

  // === 작업 로그 ===
  await copyFull('audit.png', 'audit-full.png');
  // 필터 바
  await crop({ src: 'audit.png', out: 'audit-filters.png', left: 240, top: 65, width: 1160, height: 130 });

  // === CSV 업로드 (전체) ===
  await copyFull('upload-csv.png', 'upload-csv-full.png');

  console.log('\nDone! All cropped images saved to docs/images/');
}

main().catch(console.error);
