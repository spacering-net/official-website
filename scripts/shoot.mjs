// Visual QA: drives the page in headless Chrome and saves screenshots.
// Usage: node scripts/shoot.mjs [url] [width] [height] [prefix]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4321/';
const width = Number(process.argv[3] ?? 1440);
const height = Number(process.argv[4] ?? 900);
const prefix = process.argv[5] ?? 'desk';
const mobile = width < 700;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: mobile ? 2 : 1,
  isMobile: mobile,
  hasTouch: mobile,
  // the English page redirects Chinese-language browsers, so pin the locale
  locale: url.includes('/zh/') ? 'zh-CN' : 'en-US',
});
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'load' });
const t0 = Date.now();
const at = async (ms, name) => {
  const wait = ms - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.screenshot({ path: `shots/${prefix}-${name}.png` });
  console.log('shot', name, Date.now() - t0, 'ms');
};
await at(700, 'intro-0.7');
await at(1600, 'intro-1.6');
await at(2050, 'intro-2.05');
await at(2600, 'intro-2.6');
await at(3700, 'intro-3.7');
await at(5600, 'hero');

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no webgl2';
});
console.log('gpu:', gpu);

const chapters = await page.evaluate(() => document.querySelectorAll('.chapter[data-chapter]').length);
for (let i = 1; i < chapters; i++) {
  if (mobile) {
    await page.evaluate((i) => window.scrollTo({ top: i * document.querySelector('.svh-probe').getBoundingClientRect().height }), i);
  } else {
    await page.mouse.move(width * 0.7, height * 0.5);
    await page.keyboard.press('ArrowDown');
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: `shots/${prefix}-ch${i}-mid.png` });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `shots/${prefix}-ch${i}.png` });
  console.log('chapter', i);
}
await browser.close();
