// Language switch: the other page takes over the running scene instead of
// replaying the intro, cross-fades in, and keeps the chapter, the menu and the
// focus where they were. With ffmpeg installed it also films the switch and
// checks that the screen never goes dark or flashes.
// Usage: node scripts/check-switch.mjs [baseUrl]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = process.argv[2] ?? 'http://localhost:4321';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=metal'] });
let failures = 0;
const report = (ok, name, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok ' : '✗  '} ${name.padEnd(30)} ${detail}`);
};

const ARRIVAL = () => ({
  url: location.pathname + location.hash,
  crossFade: window.__vt,
  intro: document.documentElement.classList.contains('is-intro'),
  shown: [...document.querySelectorAll('.chapter.is-shown')].map((c) => c.id).join(),
  chapter: document.documentElement.dataset.chapter,
  menu: document.querySelector('[data-menu-open]')?.getAttribute('aria-expanded'),
  focus: document.activeElement?.matches('[data-lang-switch]') ? `switch${document.activeElement.closest('[data-menu]') ? ' (menu)' : ''}` : document.activeElement?.tagName,
  clock: document.querySelector('[data-tel="clock"]')?.textContent,
});

async function open(url, viewport = { width: 1440, height: 900 }) {
  const mobile = viewport.width < 700;
  const ctx = await browser.newContext({ viewport, locale: 'zh-CN', isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    sessionStorage.setItem('sr-intro', '1');
    addEventListener('pagereveal', (e) => (window.__vt = !!e.viewTransition));
  });
  await page.goto(`${base}${url}`, { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  return { ctx, page, errors };
}

// 1. from the HUD, with the mouse, mid-page
{
  const { ctx, page, errors } = await open('/zh/#harness');
  const before = await page.evaluate(() => document.querySelector('[data-tel="clock"]').textContent);
  await page.click('.hud .lang-switch');
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
  const a = await page.evaluate(ARRIVAL);
  report(a.url === '/#harness' && a.crossFade && !a.intro && a.shown === 'harness' && a.chapter === '3' && a.clock >= before && !errors.length,
    'HUD switch keeps the chapter', JSON.stringify({ ...a, before, errors }));
  // a reload afterwards is a fresh visit again
  await page.reload({ waitUntil: 'load' });
  // the first frame can land a moment after the load event
  const fresh = await page
    .waitForFunction(() => document.documentElement.classList.contains('is-intro') || !!document.querySelector('.chapter.is-shown'), null, { timeout: 3000 })
    .then(() => true, () => false);
  report(fresh, 'reload is not a hand-over', '');
  await ctx.close();
}

// 2. from the keyboard: focus comes back to the switch
{
  const { ctx, page } = await open('/zh/');
  await page.focus('.hud .lang-switch');
  await page.keyboard.press('Enter');
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
  const a = await page.evaluate(ARRIVAL);
  report(a.url === '/' && a.shown === 'top' && a.focus === 'switch', 'keyboard switch keeps focus', JSON.stringify(a));
  await ctx.close();
}

// 3. from inside the menu: the menu is still open on the other side
{
  const { ctx, page } = await open('/zh/#signet');
  await page.click('.hud .menu-btn');
  await page.waitForTimeout(900);
  await page.click('.orbit-menu .lang-switch');
  await page.waitForLoadState('load');
  await page.waitForTimeout(400);
  const a = await page.evaluate(ARRIVAL);
  const inMenu = await page.evaluate(() => !!document.activeElement?.closest('[data-menu]'));
  report(a.url === '/#signet' && a.menu === 'true' && a.shown === 'signet' && inMenu, 'menu switch keeps the menu', JSON.stringify({ ...a, inMenu }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const closed = await page.evaluate(() => ({ menu: document.querySelector('[data-menu-open]').getAttribute('aria-expanded'), inert: document.querySelector('main').inert }));
  report(closed.menu === 'false' && !closed.inert, 'menu closes after the switch', JSON.stringify(closed));
  await ctx.close();
}

// 4. on a phone the switch lives in the menu
{
  const { ctx, page } = await open('/zh/#relay', { width: 390, height: 844 });
  await page.tap('.hud .menu-btn');
  await page.waitForTimeout(900);
  await page.tap('.orbit-menu .lang-switch');
  await page.waitForLoadState('load');
  await page.waitForTimeout(400);
  const a = await page.evaluate(ARRIVAL);
  report(a.url === '/#relay' && a.shown === 'relay' && !a.intro && a.menu === 'true', 'phone switch keeps the chapter', JSON.stringify(a));
  await ctx.close();
}

// 5. film the switch: brightness must stay level (no black frame, no intro flash)
let ffmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
}
if (!ffmpeg) console.log('-   brightness film skipped (no ffmpeg)');
else {
  const { ctx, page } = await open('/zh/');
  await page.waitForTimeout(2500); // let the hero's projection settle first
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-switch-'));
  const cdp = await ctx.newCDPSession(page);
  let n = 0;
  // frames already in flight can land after the film stops, and the folder goes
  let filming = true;
  cdp.on('Page.screencastFrame', async (f) => {
    if (!filming) return;
    fs.writeFileSync(path.join(dir, `f${String(n++).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 480, maxHeight: 300 });
  await page.waitForTimeout(400);
  const clickedAt = n;
  await page.click('.hud .lang-switch');
  await page.waitForTimeout(1800);
  filming = false;
  await cdp.send('Page.stopScreencast').catch(() => {});
  const stats = path.join(dir, 'y.txt');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f%04d.jpg'), '-vf', `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${stats}`, '-f', 'null', '-']);
  const y = fs.readFileSync(stats, 'utf8').split('\n').filter((l) => l.includes('YAVG')).map((l) => +l.split('=')[1]);
  const before = y.slice(0, clickedAt).sort((a, b) => a - b);
  const first = before[before.length >> 1];
  const after = y.slice(clickedAt);
  const lo = Math.min(...after);
  const hi = Math.max(...after);
  report(n > 20 && clickedAt > 5 && lo > first * 0.8 && hi < first * 1.25, 'switch stays level on screen', `${n} frames, brightness ${lo.toFixed(1)}–${hi.toFixed(1)} after the click (before ${first.toFixed(1)})`);
  fs.rmSync(dir, { recursive: true, force: true });
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} problem(s)` : 'language switch hands over cleanly');
process.exit(failures ? 1 : 0);
