/**
 * human-behavior - 봇 탐지 우회용 사람 행동 시뮬레이션
 */
import type { Page } from 'patchright';

/** 랜덤 딜레이 (min~max ms) */
export async function randomDelay(min = 1000, max = 3000): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/** 자연스러운 마우스 이동 시뮬레이션 */
export async function humanMouseMove(page: Page): Promise<void> {
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
export async function humanScroll(page: Page): Promise<void> {
  let previousHeight = await page.evaluate(() => document.body.scrollHeight);
  let sameHeightCount = 0;

  for (let i = 0; i < 10; i++) {
    const scrollAmount = Math.floor(Math.random() * 800) + 400;
    await page.mouse.wheel(0, scrollAmount);
    await randomDelay(800, 2000);

    if (Math.random() > 0.6) {
      await humanMouseMove(page);
    }

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) {
      sameHeightCount++;
      if (sameHeightCount >= 3) break;
    } else {
      sameHeightCount = 0;
      previousHeight = newHeight;
    }
  }
}
