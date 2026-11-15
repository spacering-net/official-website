// The narrow screens' menu (NavSheet.astro): on short screens wheel and touch
// scrolling must reach everything in it while the page behind stays locked,
// and Escape gives focus back to its button. Then the cost of opening it on
// the homepage: no live backdrop blur (on a 5K screen it stalled the page),
// and the scene paused while the menu covers it.
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4321';
const sizes = [[320, 568], [390, 600], [844, 390]];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=metal'] });
let failures = 0;
for (const [w, h] of sizes) {
  for (const lang of ['/', '/zh/']) {
    for (const reduced of [false, true]) {
      for (const input of ['wheel', 'touch']) {
        const touch = input === 'touch';
        const ctx = await browser.newContext({
          viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch,
          locale: lang === '/' ? 'en-US' : 'zh-CN', reducedMotion: reduced ? 'reduce' : 'no-preference',
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + lang + '#space', { waitUntil: 'load' }); // deep link: no intro wait
        await page.waitForTimeout(900);
        const scrollBefore = await page.evaluate(() => window.scrollY);
        await page.click('[data-nav-toggle]');
        await page.waitForTimeout(reduced ? 200 : 900);
        const sheet = await page.$('[data-nav-sheet]');
        const box = await sheet.boundingBox();
        const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 200);
        if (touch) {
          const cdp = await ctx.newCDPSession(page);
          await cdp.send('Input.synthesizeScrollGesture', { x: cx, y: cy, yDistance: -900, gestureSourceType: 'touch', speed: 2000 });
        } else {
          await page.mouse.move(cx, cy);
          for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
        }
        await page.waitForTimeout(500);
        const res = await page.evaluate(() => {
          const items = [...document.querySelectorAll('[data-nav-sheet] a, [data-nav-sheet] button')].filter((el) => el.checkVisibility());
          const last = items[items.length - 1].getBoundingClientRect();
          return {
            sheetScroll: document.querySelector('[data-nav-sheet]').scrollTop,
            lastVisible: last.top >= 0 && last.bottom <= window.innerHeight,
            winScroll: window.scrollY,
          };
        });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(reduced ? 200 : 600);
        const after = await page.evaluate(() => ({
          closed: document.querySelector('[data-nav-sheet]').hidden,
          focus: document.activeElement?.matches('[data-nav-toggle]'),
        }));
        const ok = res.lastVisible && res.winScroll === scrollBefore && after.closed && after.focus && !errors.length;
        if (!ok) failures++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${w}x${h} ${lang.padEnd(4)} ${reduced ? 'reduced' : 'motion '} ${input.padEnd(5)} sheetScroll=${res.sheetScroll} lastVisible=${res.lastVisible} bgLocked=${res.winScroll === scrollBefore} escClosed=${after.closed} focusBack=${after.focus}${errors.length ? ' errors=' + errors.join(';') : ''}`);
        await ctx.close();
      }
    }
  }
}
// Opening the menu: no live blur, and the scene stops drawing until it closes.
for (const webgl of [true, false]) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((webgl) => {
    sessionStorage.setItem('sr-intro', '1');
    if (!webgl) {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/i.test(type) ? null : get.call(this, type, ...rest);
      };
    }
    window.__draws = 0;
    for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
      for (const k of ['drawArrays', 'drawElements']) {
        const f = C.prototype[k];
        C.prototype[k] = function (...a) { window.__draws++; return f.apply(this, a); };
      }
    }
  }, webgl);
  await page.goto(base + '/#space', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const draws = () => page.evaluate(() => window.__draws);
  await page.click('[data-nav-toggle]');
  await page.waitForTimeout(800);
  const d0 = await draws();
  await page.waitForTimeout(800);
  const blur = await page.evaluate(() => getComputedStyle(document.querySelector('[data-nav-sheet]')).backdropFilter);
  const idle = (await draws()) - d0;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const back = (await draws()) - d0 - idle;
  const ok = blur === 'none' && (webgl ? idle === 0 && back > 0 : idle === 0) && !errors.length;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} open cost ${webgl ? 'webgl' : 'no-webgl'}: backdrop-filter=${blur} draws while covered=${idle} after close=${back}${errors.length ? ' errors=' + errors.join(';') : ''}`);
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failure(s)` : 'all menu checks passed');
process.exit(failures ? 1 : 0);
