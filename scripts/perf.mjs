// Rough frame-time probe on the real GPU (headless Chrome + Metal).
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:4321/';
for (const dpr of [1, 2]) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', ] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, locale: 'en-US' });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(5500);
  const measure = () => page.evaluate(() => new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    const tick = (now) => {
      times.push(now - last);
      last = now;
      if (times.length < 240) requestAnimationFrame(tick);
      else {
        times.sort((a, b) => a - b);
        resolve({ median: +times[120].toFixed(2), p95: +times[228].toFixed(2) });
      }
    };
    requestAnimationFrame(tick);
  }));
  const hero = await measure();
  await page.keyboard.press('ArrowDown');
  const transition = await measure();
  // a jump across several chapters (one move, see main.ts)
  await page.keyboard.press('End');
  const jump = await measure();
  console.log(`dpr ${dpr}: hero`, hero, '| during transition', transition, '| during jump', jump);
  await browser.close();
}
