// Navigation checks: deep link, focus after in-page navigation, language switch.
// Usage: node scripts/check-nav.mjs [baseUrl]
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4321';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=metal'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. deep link straight into a chapter
await page.goto(`${base}/#harness`, { waitUntil: 'load' });
await page.waitForTimeout(2200);
const deep = await page.evaluate(() => ({
  chapter: document.documentElement.dataset.chapter,
  shown: [...document.querySelectorAll('.chapter.is-shown')].map((c) => c.id),
  intro: document.documentElement.classList.contains('is-intro'),
}));
console.log('deep link #harness →', deep);
await page.screenshot({ path: 'shots/nav-deeplink.png' });
await page.click('.hud .brand');
await page.waitForTimeout(2600);
console.log('home link →', await page.evaluate(() => ({ chapter: document.documentElement.dataset.chapter, hash: location.hash || '(none)' })));

// 2. click "Open the ring" from the hero: focus lands on the Space heading, and Tab
// goes on to the chapter's own button (See the plan), the projection staying on
// Space.
await page.goto(`${base}/`, { waitUntil: 'load' });
await page.waitForTimeout(5200);
await page.click('.hero .btn--primary');
await page.waitForTimeout(1800);
const afterClick = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
await page.keyboard.press('Tab');
await page.waitForTimeout(2600);
const afterTab = await page.evaluate(() => {
  const el = document.activeElement;
  return { text: el?.textContent?.trim().slice(0, 20), chapter: el?.closest('.chapter[data-chapter]')?.id, current: document.documentElement.dataset.chapter };
});
console.log('focus after Open-the-ring click:', afterClick, '| after Tab:', afterTab);

// 3. dial click to the last chapter, then a roadmap link back to Harness
const lastIndex = await page.evaluate(() => document.querySelectorAll('.chapter[data-chapter]').length - 1);
await page.click(`.dial__item[data-goto="${lastIndex}"]`, { force: true });
await page.waitForTimeout(3000);
console.log('dial → finale:', await page.evaluate(() => document.documentElement.dataset.chapter), 'of', lastIndex);
await page.screenshot({ path: 'shots/nav-finale.png' });
await page.click('.roadmap__item[href="#harness"]');
await page.waitForTimeout(2800);
console.log('roadmap → harness:', await page.evaluate(() => ({ chapter: document.documentElement.dataset.chapter, focus: document.activeElement?.id })));

// 4. HUD nav: the links are pages, not chapters. On the homepage Ring is the
// current one whichever chapter is projected (the dial follows the chapters),
// and only it stays on this page (back to the top, a clean address); Space,
// Assistant, Harness and Open source open their own pages, the projections
// left alone, and there their own link is the current one. The chapters of
// Space, the assistant and Harness end with a button to the same pages.
const lit = [];
for (let i = 0; i <= lastIndex; i++) {
  await page.click(`.dial__item[data-goto="${i}"]`, { force: true });
  await page.waitForTimeout(2600);
  lit.push(
    await page.evaluate(() => {
      const current = [...document.querySelectorAll('.nav__link[aria-current]')].map((a) => `${a.getAttribute('href')}=${a.getAttribute('aria-current')}`);
      const dial = document.querySelector('.dial__item[aria-current="step"]')?.dataset.goto;
      return `${current.join('+') || '-'}@${dial}`;
    }),
  );
}
const gotos = await page.evaluate(() => [...document.querySelectorAll('.nav__link')].map((a) => a.dataset.goto ?? '-').join());
await page.click('.nav__link[href="#top"]');
await page.waitForTimeout(2800);
const top = await page.evaluate(() => `${document.documentElement.dataset.chapter}${location.hash}`);
const market = await page.evaluate(() => [
  document.querySelectorAll('.nav__link')[3]?.getAttribute('href'),
  ...['space', 'assistant', 'harness'].map((id) => document.querySelector(`#${id} .projection__actions a`)?.getAttribute('href')),
]);
const opened = [];
for (const href of ['/space/', '/assistant/', '/open-source/']) {
  await page.click(`.nav__link[href="${href}"]`);
  await page.waitForURL(`**${href}`, { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('load');
  opened.push(await page.evaluate(() => `${location.pathname}${location.hash}=${document.querySelector('.nav__link[aria-current="page"]')?.getAttribute('href')}`));
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForTimeout(3200);
}
const navOk =
  lit.join() === [...Array(lastIndex + 1).keys()].map((i) => `#top=page@${i}`).join() &&
  gotos === '0,-,-,-,-' &&
  top === '0' &&
  opened.join() === '/space/=/space/,/assistant/=/assistant/,/open-source/=/open-source/' &&
  market.join() === '/harness/,/space/,/assistant/,/harness/';
console.log('nav lit per chapter:', lit.join(' '), '| goto:', gotos, '| ring →', top, '| pages:', opened.join(' '), '| market:', market.join(' '), navOk ? 'ok' : '✗ nav');

// 5. language switch: remembers the choice, cross-fades, and lands on the same
// chapter already projected, without replaying the intro
await page.click('.dial__item[data-goto="3"]', { force: true });
await page.waitForTimeout(2800);
await page.addInitScript(() => addEventListener('pagereveal', (e) => (window.__vt = !!e.viewTransition)));
await page.click('.hud-foot [data-lang-switch]');
await page.waitForLoadState('load');
await page.waitForTimeout(150);
const arrived = await page.evaluate(() => ({
  url: location.pathname + location.hash,
  lang: localStorage.getItem('sr-lang'),
  crossFade: window.__vt,
  intro: document.documentElement.classList.contains('is-intro'),
  shown: [...document.querySelectorAll('.chapter.is-shown')].map((c) => c.id),
  scan: document.getElementById('harness')?.style.getPropertyValue('--scan'),
}));
console.log('after switch:', arrived);
const ok = navOk && arrived.url === '/zh/#harness' && arrived.lang === 'zh' && arrived.crossFade && !arrived.intro && arrived.shown.join() === 'harness' && arrived.scan === '1.0000';
console.log(ok ? 'switch ok' : '✗ switch did not hand over');
console.log(errors.length ? errors : 'no page errors');
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
