import { chromium } from 'playwright';
const [url, w, h, prefix, ...rest] = process.argv.slice(2);
const width = +w, height = +h, mobile = width < 700;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: rest.includes('en') ? 'en-US' : 'zh-CN' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()); });
await page.goto(url, { waitUntil: 'load' });
const t0 = Date.now();
const at = async (ms, name) => { const wait = ms - (Date.now() - t0); if (wait > 0) await page.waitForTimeout(wait); await page.screenshot({ path: `shots/${prefix}-${name}.png` }); };
await at(3550, 'scan');
await at(5800, 'hero');
const unit = await page.evaluate(() => document.querySelector('.svh-probe').getBoundingClientRect().height);
for (const i of rest.filter((x) => /^\d$/.test(x)).map(Number)) {
  await page.evaluate(([i, unit]) => window.scrollTo({ top: i * unit }), [i, unit]);
  await page.waitForTimeout(3200);
  await page.screenshot({ path: `shots/${prefix}-ch${i}.png` });
}
if (rest.includes('menu')) {
  await page.click('[data-menu-open]');
  await page.waitForTimeout(1400);
  await page.hover('.menu-link[data-node="harness"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/${prefix}-menu.png` });
}
await browser.close();
