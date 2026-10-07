// Checks fallbacks: no WebGL, reduced motion, keyboard focus. Saves screenshots.
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4321/';

const run = async (name, launchArgs, ctxOpts, fn) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'load' });
  await fn(page);
  console.log(name, errors.length ? errors : 'no errors');
  await browser.close();
};

await run('no-webgl', ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'], {}, async (page) => {
  await page.waitForTimeout(1500);
  console.log(' html class:', await page.evaluate(() => document.documentElement.className));
  await page.screenshot({ path: 'shots/mode-nowebgl-hero.png' });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: 'shots/mode-nowebgl-ch1.png' });
});

await run('reduced-motion', ['--enable-gpu', '--use-angle=metal'], { reducedMotion: 'reduce' }, async (page) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'shots/mode-reduced-hero.png' });
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'shots/mode-reduced-ch1.png' });
});

await run('keyboard', ['--enable-gpu', '--use-angle=metal'], {}, async (page) => {
  await page.waitForTimeout(5200);
  const seq = [];
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('Tab');
    seq.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}:${(el.textContent || '').trim().slice(0, 18)}` : 'none';
    }));
  }
  console.log(' tab order:', seq.join(' | '));
  await page.screenshot({ path: 'shots/mode-keyboard.png' });
  await page.keyboard.press('Escape');
  await page.click('[data-menu-open]');
  await page.waitForTimeout(1200);
  const inMenu = await page.evaluate(() => document.activeElement?.closest('[data-menu]') !== null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const back = await page.evaluate(() => document.activeElement?.matches('[data-menu-open]'));
  console.log(' menu focus in:', inMenu, '| focus restored:', back);
});
