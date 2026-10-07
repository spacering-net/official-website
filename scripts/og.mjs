// Renders the share images from the live hero: public/og.png and public/og-zh.png.
// Convert to JPEG afterwards (the site references .jpg), e.g. on macOS:
//   sips -s format jpeg -s formatOptions 84 public/og.png --out public/og.jpg
// Run against `pnpm preview` (or dev): node scripts/og.mjs [baseUrl]
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4321';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
for (const [path, file, locale] of [['/', 'og.png', 'en-US'], ['/zh/', 'og-zh.png', 'zh-CN']]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, locale });
  await page.goto(`${base}${path}?capture`, { waitUntil: 'load' });
  await page.mouse.move(600, 315);
  await page.waitForTimeout(6500);
  await page.screenshot({ path: `public/${file}` });
  console.log('wrote public/' + file);
  await page.close();
}
await browser.close();
