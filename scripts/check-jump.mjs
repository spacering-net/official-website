// Jumps across several chapters must read as one move: only the chapter left
// and the chapter reached may project, and the HUD steps straight to the
// destination. Usage: node scripts/check-jump.mjs [baseUrl]
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4321';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=metal'] });
let failures = 0;

// Records every chapter that gets projected and every chapter the HUD points at.
const WATCH = () => {
  window.__shown = new Set();
  window.__steps = [];
  const root = document.documentElement;
  new MutationObserver(() => {
    const c = root.dataset.chapter;
    if (c !== undefined && window.__steps.at(-1) !== c) window.__steps.push(c);
  }).observe(root, { attributes: true, attributeFilter: ['data-chapter'] });
  for (const el of document.querySelectorAll('.chapter[data-chapter]')) {
    new MutationObserver(() => el.classList.contains('is-shown') && window.__shown.add(el.id)).observe(el, { attributes: true, attributeFilter: ['class'] });
  }
};
const reset = (page) => page.evaluate(() => {
  window.__shown = new Set([...document.querySelectorAll('.chapter.is-shown')].map((c) => c.id));
  window.__steps = [document.documentElement.dataset.chapter];
});
const read = (page) => page.evaluate(() => ({
  shown: [...window.__shown],
  steps: window.__steps,
  now: [...document.querySelectorAll('.chapter.is-shown')].map((c) => c.id),
  chapter: document.documentElement.dataset.chapter,
}));

async function scenario(name, { url = '/#space', seen = true, webgl = true, wait = 2400 }, act, expect) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();
  if (seen) await page.addInitScript(() => sessionStorage.setItem('sr-intro', '1'));
  if (!webgl) await page.addInitScript(() => (HTMLCanvasElement.prototype.getContext = () => null));
  await page.goto(`${base}${url}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  await page.evaluate(WATCH);
  await reset(page);
  await act(page);
  await page.waitForTimeout(3200);
  const r = await read(page);
  const ok = expect(r);
  if (!ok) failures++;
  console.log(`${ok ? 'ok ' : '✗  '} ${name.padEnd(36)} shown=${r.shown.join(',')} steps=${r.steps.join('>')} now=${r.now.join(',')}`);
  await ctx.close();
}

const only = (r, ...ids) => r.shown.length === ids.length && ids.every((id) => r.shown.includes(id));

await scenario('dial: space → signet', {}, (p) => p.click('.dial__item[data-goto="5"]', { force: true }),
  (r) => only(r, 'space', 'signet') && r.steps.join() === '1,5' && r.now.join() === 'signet');
await scenario('keyboard End: ring → finale', { url: '/' , wait: 2600 }, (p) => p.keyboard.press('End'),
  (r) => only(r, 'top', 'open-source') && r.steps.join() === '0,7');
await scenario('back up: signet → space', { url: '/#signet' }, (p) => p.click('.dial__item[data-goto="1"]', { force: true }),
  (r) => only(r, 'signet', 'space') && r.steps.join() === '5,1');
await scenario('arrow mid-jump retargets', {}, async (p) => {
  await p.click('.dial__item[data-goto="5"]', { force: true });
  await p.waitForTimeout(550);
  await p.keyboard.press('ArrowDown');
}, (r) => r.now.join() === 'codeg' && r.chapter === '6' && !r.shown.some((id) => ['assistant', 'harness', 'relay'].includes(id)));
await scenario('wheel mid-jump is held off', {}, async (p) => {
  await p.click('.dial__item[data-goto="5"]', { force: true });
  await p.waitForTimeout(400);
  await p.mouse.move(700, 450);
  for (let i = 0; i < 6; i++) await p.mouse.wheel(0, 400);
}, (r) => r.now.join() === 'signet' && only(r, 'space', 'signet'));
await scenario('menu: space → codeg', {}, async (p) => {
  await p.click('.hud .menu-btn');
  await p.waitForTimeout(900);
  await p.click('.menu-link[data-node="codeg"]');
}, (r) => only(r, 'space', 'codeg') && r.now.join() === 'codeg');
await scenario('during the intro', { url: '/', seen: false, wait: 900 }, (p) => p.click('.dial__item[data-goto="4"]', { force: true }),
  (r) => r.now.join() === 'relay' && r.chapter === '4' && !r.shown.some((id) => ['space', 'assistant', 'harness'].includes(id)));
await scenario('without WebGL', { webgl: false }, (p) => p.click('.dial__item[data-goto="5"]', { force: true }),
  (r) => only(r, 'space', 'signet') && r.now.join() === 'signet');

await browser.close();
console.log(failures ? `${failures} problem(s)` : 'all jumps clean');
process.exit(failures ? 1 : 0);
