// The pages beside the homepage (Harness, the policies): the shared HUD, menu
// and account dialog, what stays in view while scrolling, and Harness's
// in-place browsing, all without a page error or a refused script.
// Usage: node scripts/check-pages.mjs [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4321';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failed = 0;
const report = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(ok ? 'ok ' : '✗  ', what, detail);
};

async function open(path, { phone = false } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: phone ? 2 : 1,
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`)));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  return { ctx, page, errors };
}

/** Marks the document, to tell a swap in place from a page load. */
const mark = (page) => page.evaluate(() => (window.__same = true));
const same = (page) => page.evaluate(() => window.__same === true);
const top = (page, selector) => page.evaluate((s) => Math.round(document.querySelector(s)?.getBoundingClientRect().top ?? -1), selector);

// 1. the frame: HUD, rail, language twin, menu, account dialog
{
  const { ctx, page, errors } = await open('/zh/harness/?q=pdf');
  const hud = await page.evaluate(() => ({
    page: !!document.querySelector('.hud.hud--page'),
    current: document.querySelector('.nav__link[aria-current="page"]')?.getAttribute('href'),
    dot: document.querySelector('.nav__dot')?.classList.contains('is-on'),
    lang: document.querySelector('.page-foot [data-lang-switch]')?.getAttribute('href'),
    topLang: !!document.querySelector('.hud [data-lang-switch]'),
    menuLinks: [...document.querySelectorAll('.menu-link')].map((a) => `${a.getAttribute('href')}${a.hasAttribute('data-goto') ? '+goto' : ''}`).join(' '),
  }));
  report(hud.page && hud.current === '/zh/harness/' && hud.dot, 'HUD on the page, Harness current, rail resting on it', JSON.stringify(hud.current));
  report(hud.lang === '/harness/?q=pdf' && !hud.topLang, 'language switch (in the foot) leads to the twin page with its query', `${hud.lang} top:${hud.topLang}`);
  report(hud.menuLinks === '/zh/#space /zh/#assistant /zh/harness/ /zh/#relay /zh/#signet /zh/#codeg', 'menu leads to pages and the homepage chapters', hud.menuLinks);
  await page.click('.hud [data-menu-open]');
  await page.waitForTimeout(900);
  const opened = await page.evaluate(() => [document.querySelector('.orbit-menu')?.classList.contains('is-open'), document.documentElement.classList.contains('is-locked')]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const closed = await page.evaluate(() => [document.querySelector('.orbit-menu')?.classList.contains('is-open'), document.documentElement.classList.contains('is-locked')]);
  report(opened.join() === 'true,true' && closed.join() === 'false,false', 'menu opens over a still page and closes with Escape', `${opened} → ${closed}`);
  await page.click('.hud [data-account-open]');
  await page.waitForTimeout(400);
  const dialog = await page.evaluate(() => document.querySelector('[data-account-dialog]')?.open);
  await page.click('[data-account-close]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => [document.querySelector('[data-account-dialog]')?.open, document.documentElement.classList.contains('is-locked')]);
  report(dialog === true && after.join() === 'false,false', 'account dialog opens and closes', `${dialog} → ${after}`);
  report(!errors.length, 'frame: no errors', errors.join(' | '));
  await ctx.close();
}

// 2. browsing: what stays in view, and swaps in place
{
  const { ctx, page, errors } = await open('/zh/harness/');
  await mark(page);
  const before = await page.locator('[data-grid] > li').count();
  await page.click('[data-more]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-grid] > li').length > n, before, { timeout: 8000 }).catch(() => {});
  const grown = await page.locator('[data-grid] > li').count();
  report(grown > before && (await same(page)), 'more loads into the same page', `${before} → ${grown}`);

  // halfway down a long list (at its end the sidebar leaves with it)
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(500);
  const hudH = await page.evaluate(() => Math.round(document.querySelector('.hud').getBoundingClientRect().height));
  const bar = await top(page, '.browse__bar');
  const side = await top(page, '.browse__side-inner');
  const veil = await page.evaluate(() => document.querySelector('.hud').classList.contains('is-scrolled'));
  report(Math.abs(bar - (hudH - 1)) <= 1 && side > bar && side < bar + 120 && veil, 'search bar and filters stay under the HUD', `hud ${hudH}, bar ${bar}, side ${side}, veil ${veil}`);

  await page.keyboard.press('/');
  const focused = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.type('pdf');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'pdf', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const searched = await page.evaluate(() => ({ url: location.pathname + location.search, count: document.querySelector('.results__count')?.textContent?.trim(), cards: document.querySelectorAll('[data-grid] > li').length }));
  report(focused === 'harness-q' && searched.url === '/zh/harness/?q=pdf' && searched.cards > 0 && (await same(page)), '"/" then typing searches in place', JSON.stringify(searched));

  await page.click('.results__count a');
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'), null, { timeout: 8000 }).catch(() => {});
  const box = await page.inputValue('#harness-q');
  report(box === '' && (await same(page)), 'clearing a search empties the search box', JSON.stringify(box));
  await page.click('.kinds a:has-text("MCP")');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('kind') === 'mcp', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const kinds = await page.evaluate(() => ({ url: location.search, current: document.querySelector('.kinds [aria-current]')?.textContent?.trim(), all: [...document.querySelectorAll('.card .badge--kind')].every((b) => b.textContent.trim() === 'MCP') }));
  report(kinds.url === '?kind=mcp' && kinds.all && (await same(page)), 'a kind filters in place', JSON.stringify(kinds));

  await page.click('.kinds a:has-text("全部")');
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('kind'), null, { timeout: 8000 }).catch(() => {});
  const tag = page.locator('.browse__side .tags .chip').nth(1);
  const tagName = (await tag.textContent()).replace(/\d+/g, '').trim();
  await tag.click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has('tag'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const chip = await page.evaluate(() => document.querySelector('.active__chip')?.textContent?.trim());
  await page.click('.active__chip');
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('tag'), null, { timeout: 8000 }).catch(() => {});
  report(chip === tagName && !(await page.evaluate(() => !!document.querySelector('.active__chip'))) && (await same(page)), 'a tag filters in place and its chip takes it off', `${tagName} / ${chip}`);

  await page.goBack();
  await page.waitForFunction(() => new URL(location.href).searchParams.has('tag'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => ({ url: location.search, chip: document.querySelector('.active__chip')?.textContent?.trim() }));
  report(back.url.startsWith('?tag=') && back.chip === tagName && (await same(page)), 'Back returns to the filter before', JSON.stringify(back));
  report(!errors.length, 'browse: no errors', errors.join(' | '));
  await ctx.close();
}

// 2b. answers that come back after the reader has moved on are dropped
{
  const { ctx, page, errors } = await open('/zh/harness/');
  await mark(page);
  let release;
  const held = new Promise((done) => (release = done));
  await page.route(/[?&]cursor=/, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.click('[data-more]');
  await page.click('.kinds a:has-text("MCP")');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('kind') === 'mcp', null, { timeout: 8000 }).catch(() => {});
  release();
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => ({
    url: location.search,
    allMcp: [...document.querySelectorAll('.card .badge--kind')].every((b) => b.textContent.trim() === 'MCP'),
    cards: document.querySelectorAll('[data-grid] > li').length,
    more: document.querySelector('[data-more]')?.getAttribute('href') ?? null,
  }));
  report(after.url === '?kind=mcp' && after.allMcp && (after.more === null || after.more.includes('kind=mcp')) && (await same(page)), 'more answered after a filter changed is dropped', JSON.stringify(after));
  await page.unroute(/[?&]cursor=/);

  // back, then forward before the answer for back arrives
  let release2;
  const held2 = new Promise((done) => (release2 = done));
  await page.route((url) => url.pathname === '/zh/harness/' && url.search === '', async (route) => {
    await held2;
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => history.back());
  await page.waitForTimeout(300);
  await page.evaluate(() => history.forward());
  await page.waitForTimeout(300);
  release2();
  await page.waitForTimeout(1000);
  const forward = await page.evaluate(() => ({
    url: location.search,
    allMcp: [...document.querySelectorAll('.card .badge--kind')].every((b) => b.textContent.trim() === 'MCP'),
    current: document.querySelector('.kinds [aria-current]')?.textContent?.replace(/\d+/g, '').trim(),
    busy: document.querySelector('[data-region="results"]')?.getAttribute('aria-busy'),
  }));
  report(forward.url === '?kind=mcp' && forward.allMcp && forward.busy === null && (await same(page)), 'back then forward keeps the list in step with the address', JSON.stringify(forward));
  await page.unroute((url) => url.pathname === '/zh/harness/' && url.search === '');

  // a kind asked for, then the old list's "more": the kind's answer first, then the page of the old list
  await page.goto(`${base}/zh/harness/`, { waitUntil: 'networkidle' });
  await mark(page);
  let releaseKind;
  let releasePage;
  const kindHeld = new Promise((done) => (releaseKind = done));
  const pageHeld = new Promise((done) => (releasePage = done));
  await page.route((url) => url.searchParams.get('kind') === 'mcp' && !url.searchParams.has('cursor'), async (route) => {
    await kindHeld;
    await route.continue().catch(() => {});
  });
  await page.route(/[?&]cursor=/, async (route) => {
    await pageHeld;
    await route.continue().catch(() => {});
  });
  await page.click('.kinds a:has-text("MCP")');
  await page.click('[data-more]');
  await page.waitForTimeout(200);
  releaseKind();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('kind') === 'mcp', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  releasePage();
  await page.waitForTimeout(1000);
  const crossed = await page.evaluate(() => ({
    allMcp: [...document.querySelectorAll('.card .badge--kind')].every((b) => b.textContent.trim() === 'MCP'),
    cards: document.querySelectorAll('[data-grid] > li').length,
    more: document.querySelector('[data-more]')?.getAttribute('href') ?? null,
  }));
  report(crossed.allMcp && crossed.cards === 18 && (crossed.more === null || crossed.more.includes('kind=mcp')) && (await same(page)), 'the old list\'s more, answered after a new kind, is dropped', JSON.stringify(crossed));
  await page.unroute(/[?&]cursor=/);
  await page.unroute((url) => url.searchParams.get('kind') === 'mcp' && !url.searchParams.has('cursor'));

  // "more" cut short by going back and forth comes back ready to be asked again
  await page.goto(`${base}/zh/harness/`, { waitUntil: 'networkidle' });
  await page.click('.kinds a:has-text("MCP")');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('kind') === 'mcp', null, { timeout: 8000 }).catch(() => {});
  await page.click('.kinds a:has-text("全部")');
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('kind'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  await mark(page);
  let releaseMore;
  let releaseBack;
  const moreHeld = new Promise((done) => (releaseMore = done));
  const backHeld = new Promise((done) => (releaseBack = done));
  await page.route(/[?&]cursor=/, async (route) => {
    await moreHeld;
    await route.continue().catch(() => {});
  });
  await page.route((url) => url.searchParams.get('kind') === 'mcp' && !url.searchParams.has('cursor'), async (route) => {
    await backHeld;
    await route.continue().catch(() => {});
  });
  const cardsBefore = await page.locator('[data-grid] > li').count();
  await page.click('[data-more]');
  await page.waitForTimeout(200);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(300);
  await page.evaluate(() => history.forward());
  await page.waitForTimeout(300);
  releaseMore();
  releaseBack();
  await page.waitForTimeout(800);
  const link = await page.evaluate(() => {
    const a = document.querySelector('[data-more]');
    return { busy: a?.getAttribute('aria-busy') ?? null, label: a?.textContent?.trim(), url: location.search };
  });
  await page.unroute(/[?&]cursor=/);
  await page.unroute((url) => url.searchParams.get('kind') === 'mcp' && !url.searchParams.has('cursor'));
  await page.click('[data-more]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-grid] > li').length > n, cardsBefore, { timeout: 8000 }).catch(() => {});
  const retried = await page.locator('[data-grid] > li').count();
  report(link.busy === null && link.label === '更多' && link.url === '' && retried > cardsBefore && (await same(page)), '"more" cut short is ready again, and works', `${JSON.stringify(link)} ${cardsBefore} → ${retried}`);
  report(!errors.filter((e) => !e.includes('Failed to load resource')).length, 'late answers: no errors', errors.join(' | '));
  await ctx.close();
}

// 3. small screens: the filters' sheet
{
  const { ctx, page, errors } = await open('/zh/harness/', { phone: true });
  await mark(page);
  const sideHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.browse__side')).display === 'none');
  await page.click('[data-sheet-open]');
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => [document.querySelector('[data-sheet]')?.open, document.documentElement.classList.contains('is-locked')]);
  await page.click('[data-sheet] .facet:has-text("Python")');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('runtime') === 'python', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const chosen = await page.evaluate(() => document.querySelector('[data-sheet] .facet[aria-current]')?.textContent?.trim());
  await page.click('[data-sheet-close]');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => [document.querySelector('[data-sheet]')?.open, document.documentElement.classList.contains('is-locked'), document.querySelector('[data-region="filtered"]')?.textContent?.trim()]);
  report(sideHidden && shown.join() === 'true,true' && chosen?.startsWith('Python') && after.join() === 'false,false,1' && (await same(page)), 'filters open in a sheet, apply in place, and close', `${shown} ${chosen} ${after}`);
  report(!errors.length, 'sheet: no errors', errors.join(' | '));
  await ctx.close();
}

// 4. an item: section bar, the side in view, copying, the summary
{
  const { ctx, page, errors } = await open('/zh/harness/anthropics/docx');
  await page.click('.toc a[href="#permissions"]');
  await page.waitForTimeout(1300);
  const hudH = await page.evaluate(() => Math.round(document.querySelector('.hud').getBoundingClientRect().height));
  const toc = await top(page, '.toc');
  const section = await top(page, '#permissions');
  const current = await page.evaluate(() => document.querySelector('.toc a[aria-current]')?.getAttribute('href'));
  const side = await top(page, '.side__inner');
  report(Math.abs(toc - hudH) <= 1 && section >= toc && section < toc + 80 && current === '#permissions', 'section bar moves to a section and marks it', `hud ${hudH}, toc ${toc}, section ${section}, current ${current}`);
  report(side > hudH && side < hudH + 40, 'install panel and details stay in view', `side ${side}`);
  const copy = page.locator('.head__ref [data-copy]');
  const visible = await copy.isVisible();
  await copy.click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  report(visible && copied === 'anthropics/docx', 'the address copies', copied);
  const clamp = await page.evaluate(() => {
    const c = document.querySelector('[data-clamp]');
    const b = c?.querySelector('[data-clamp-toggle]');
    if (!c || !b || b.hidden) return 'none';
    const before = c.querySelector('p').clientHeight;
    b.click();
    return `${c.classList.contains('is-clamped')} ${c.querySelector('p').clientHeight > before}`;
  });
  report(clamp === 'false true', 'a long summary unfolds', clamp);
  report(!errors.length, 'item: no errors', errors.join(' | '));
  await ctx.close();
}

// 5. an item on a phone: the dock once the install panel has gone
{
  const { ctx, page, errors } = await open('/zh/harness/anthropics/docx', { phone: true });
  const atFirst = await page.evaluate(() => document.querySelector('[data-dock]')?.hidden);
  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.waitForTimeout(700);
  const later = await page.evaluate(() => {
    const d = document.querySelector('[data-dock]');
    return [d?.hidden, Math.round(d?.getBoundingClientRect().bottom ?? 0) === innerHeight];
  });
  report(atFirst === true && later.join() === 'false,true', 'the dock appears once the install panel is gone', `${atFirst} → ${later}`);
  report(!errors.length, 'item on a phone: no errors', errors.join(' | '));
  await ctx.close();
}

// 6. the policies: the same frame
{
  const { ctx, page, errors } = await open('/privacy/');
  const frame = await page.evaluate(() => ({
    hud: !!document.querySelector('.hud.hud--page [data-account-open]'),
    lang: document.querySelector('.page-foot [data-lang-switch]')?.getAttribute('href'),
    harness: document.querySelector('.nav__link[href="/harness/"]') !== null,
  }));
  report(frame.hud && frame.lang === '/zh/privacy/' && frame.harness, 'policies have the HUD, the account and their twin', JSON.stringify(frame));
  report(!errors.length, 'policies: no errors', errors.join(' | '));
  await ctx.close();
}

// 7. addresses with nothing behind them: the not-found page in the frame, in the address's language
for (const [path, lang] of [
  ['/no-such-page', 'en'],
  ['/zh/no-such-page', 'zh-CN'],
  ['/harness/nobody-here/nothing', 'en'],
  ['/zh/harness/nobody-here', 'zh-CN'],
]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the page itself answers 404 (and the console says so); nothing it loads may fail
  page.on('response', (r) => r.status() >= 400 && r.url() !== `${base}${path}` && errors.push(`${r.status()} ${r.url()}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
  const res = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  const seen = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    hud: !!document.querySelector('.hud.hud--page [data-account-open]'),
    code: document.querySelector('.lost__code')?.textContent?.trim(),
    switchTo: document.querySelector('.page-foot [data-lang-switch]')?.getAttribute('href'),
    noindex: document.querySelector('meta[name="robots"]')?.getAttribute('content'),
  }));
  report(res?.status() === 404 && seen.lang === lang && seen.hud && seen.code === '404' && seen.noindex === 'noindex' && !errors.length, `not found: ${path}`, `${res?.status()} ${JSON.stringify(seen)} ${errors.join(' | ')}`);
  await ctx.close();
}

await browser.close();
console.log(failed ? `${failed} failed` : 'all pages ok');
process.exit(failed ? 1 : 0);
