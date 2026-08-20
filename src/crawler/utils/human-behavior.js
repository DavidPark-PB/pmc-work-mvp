/**
 * human-behavior - 봇 탐지 우회용 사람 행동 시뮬레이션
 * 원본: MrCrawler/mr-crawler/workers/utils/human-behavior.ts
 *
 * 기능: 랜덤 딜레이, 마우스 이동, 자연스러운 스크롤
 */

/** 랜덤 딜레이 (min~max ms) */
async function randomDelay(min = 1000, max = 3000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/** 자연스러운 마우스 이동 시뮬레이션 */
async function humanMouseMove(page) {
  const viewportSize = page.viewportSize();
  if (!viewportSize) return;

  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const x = Math.floor(Math.random() * viewportSize.width);
    const y = Math.floor(Math.random() * viewportSize.height);
    await page.mouse.move(x, y, { steps: 10 });
    await randomDelay(100, 300);
  }
}

/** 자연스러운 스크롤 (무한 스크롤 대응 포함) */
async function humanScroll(page) {
  let previousHeight = await page.evaluate(() => document.body.scrollHeight);
  let sameHeightCount = 0;

  for (let i = 0; i < 10; i++) {
    const scrollAmount = Math.floor(Math.random() * 800) + 400; // 400~1200px
    await page.mouse.wheel(0, scrollAmount);
    await randomDelay(800, 2000);

    // 가끔 마우스 움직임 추가
    if (Math.random() > 0.6) {
      await humanMouseMove(page);
    }

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) {
      sameHeightCount++;
      if (sameHeightCount >= 3) break; // 3번 연속 높이 변화 없으면 종료
    } else {
      sameHeightCount = 0;
      previousHeight = newHeight;
    }
  }
}

module.exports = { randomDelay, humanMouseMove, humanScroll };
