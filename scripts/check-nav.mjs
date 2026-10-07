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

// 2. click "Open the ring" from the hero: focus lands on the Space heading. Planned
// chapters hold no links, so Tab goes on to the next link (Enter Harness) and the
// projection follows it there.
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

// 4. HUD nav: Space, Assistant and Harness light on their own chapters, Ring on the
// hero and the ring's other products, Open source on Codeg and the finale. Each link lands
// on its own chapter (Open source on the finale, not on Codeg); Ring leaves a
// clean address. Harness leads to the marketplace instead, as does its chapter's button.
const lit = [];
for (let i = 0; i <= lastIndex; i++) {
  await page.click(`.dial__item[data-goto="${i}"]`, { force: true });
  await page.waitForTimeout(2600);
  lit.push(await page.evaluate(() => document.querySelector('.nav__link[aria-current="true"]')?.getAttribute('href') ?? '-'));
}
const lands = [];
for (const href of ['#space', '#assistant', '#open-source', '#top']) {
  await page.click(`.nav__link[href="${href}"]`);
  await page.waitForTimeout(2800);
  lands.push(await page.evaluate(() => `${document.documentElement.dataset.chapter}${location.hash}`));
}
const market = await page.evaluate(() => [
  document.querySelector('.nav__link[data-range="3"]')?.getAttribute('href'),
  document.querySelector('#harness .projection__actions a')?.getAttribute('href'),
]);
const navOk =
  lit.join() === '#top,#space,#assistant,/harness/,#top,#top,#open-source,#open-source' &&
  lands.join() === '1#space,2#assistant,7#open-source,0' &&
  market.join() === '/harness/,/harness/';
console.log('nav lit per chapter:', lit.join(' '), '| links land on', lands.join(' '), '| market:', market.join(' '), navOk ? 'ok' : '✗ nav');

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
