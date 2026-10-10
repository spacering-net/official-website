// The pages beside the homepage (Harness, the policies; Space, the assistant
// and open source): the shared HUD, menu and account dialog, what stays in
// view while scrolling, Harness's in-place browsing, the edges they share, the
// light theme, the prompts' gallery, the assistants' shelf and pages, and the
// product pages' drawings and previews, all without a page error or a refused
// script.
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

// 1. the frame: HUD, rail, language twin, menu (ending as the page does), account dialog
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
  report(hud.menuLinks === '/zh/space/ /zh/assistant/ /zh/harness/ /zh/#relay /zh/#signet /zh/#codeg', 'menu leads to pages and the homepage chapters', hud.menuLinks);
  await page.click('.hud [data-menu-open]');
  await page.waitForTimeout(900);
  const opened = await page.evaluate(() => [document.querySelector('.orbit-menu')?.classList.contains('is-open'), document.documentElement.classList.contains('is-locked')]);
  // the menu ends with the footer's last line, at its places; the account sits in its top bar
  const foot = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const x = (v) => (v === undefined ? null : Math.round(v));
    return {
      lang: document.querySelector('.orbit-menu .foot-line [data-lang-switch]')?.getAttribute('href'),
      theme: document.querySelector('.orbit-menu .foot-line [data-theme-switch]')?.hidden === false,
      account: !!document.querySelector('.orbit-menu__top [data-account-open]') && !document.querySelector('.orbit-menu__foot [data-account-open]'),
      left: [x(r('.orbit-menu .foot-line .langs')?.left), x(r('.page-foot .foot-line .langs')?.left)],
      right: [x(r('.orbit-menu .foot-line__legal')?.right), x(r('.page-foot .foot-line__legal')?.right)],
    };
  });
  report(
    foot.lang === '/harness/?q=pdf' && foot.theme && foot.account && foot.left[0] !== null && foot.left[0] === foot.left[1] && foot.right[0] !== null && foot.right[0] === foot.right[1],
    'the menu ends as the page does: languages and theme, the small print, at the footer’s places',
    JSON.stringify(foot),
  );
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

  // a runtime chosen from its list: in place, the list showing it and keeping the focus
  await page.focus('.browse__side select[data-pick]');
  await page.selectOption('.browse__side select[data-pick]', 'python');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('runtime') === 'python', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const picked = await page.evaluate(() => {
    const list = document.querySelector('.browse__side select[data-pick]');
    return {
      url: location.search,
      value: list?.value,
      shown: list?.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim(),
      focus: document.activeElement === list,
      chips: [...document.querySelectorAll('.active__chip')].map((c) => c.textContent.trim()),
    };
  });
  // the tag chosen before stays chosen
  const query = new URLSearchParams(picked.url);
  report(
    query.get('runtime') === 'python' && query.get('tag') === new URLSearchParams(back.url).get('tag') && picked.value === 'python' && picked.shown?.startsWith('Python') && picked.focus && picked.chips.includes('Python') && (await same(page)),
    'a runtime chosen from its list filters in place, the list keeping the focus',
    JSON.stringify(picked),
  );
  await page.selectOption('.browse__side select[data-pick]', '');
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('runtime'), null, { timeout: 8000 }).catch(() => {});
  // and from the keyboard: an arrow opens it, another moves on, Enter chooses; the focus comes back to it
  await page.waitForTimeout(300);
  await page.focus('.browse__side select[data-pick]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => new URL(location.href).searchParams.has('runtime'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const keyed = await page.evaluate(() => ({ runtime: new URL(location.href).searchParams.get('runtime'), focus: !!document.activeElement?.matches('.browse__side select[data-pick]') }));
  report(!!keyed.runtime && keyed.focus && (await same(page)), 'the runtime list works from the keyboard, the focus staying on it', JSON.stringify(keyed));
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
  // a page's length, and how many MCP servers there are: the kind's first page holds the fewer
  const firstPage = await page.locator('[data-grid] > li').count();
  const mcpTotal = await page.evaluate(() => Number(document.querySelector('.kinds a[href*="kind=mcp"] .chip__n')?.textContent?.replace(/\D/g, '') ?? NaN));
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
  report(
    crossed.allMcp && crossed.cards === Math.min(firstPage, mcpTotal) && (crossed.more === null || crossed.more.includes('kind=mcp')) && (await same(page)),
    'the old list\'s more, answered after a new kind, is dropped',
    JSON.stringify({ ...crossed, firstPage, mcpTotal }),
  );
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
  await page.selectOption('[data-sheet] select[data-pick]', 'python');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('runtime') === 'python', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const chosen = await page.evaluate(() => document.querySelector('[data-sheet] select[data-pick]')?.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim());
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

// 8. one column and its lines, at a 5K-wide window: the HUD, the bar, the
// sidebar, the grid and the footer keep to the same edges, and the sidebar's
// runtime list to the search's; an item's side starts level with its head, its
// publisher first, its text and code as wide as the column. Then the theme:
// switched, kept for the next page from its first paint, the homepage's
// included, whose scene turns to day with it, and switched back from there.
{
  const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => (window.__themeAtReady = document.documentElement.dataset.theme ?? 'dark')));
  await page.goto(`${base}/harness/`, { waitUntil: 'networkidle' });
  const lines = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const x = (v) => Math.round(v);
    const [heading, count, pick, card] = ['.browse__side .filters__group h2', '.results__count', '.browse__side .pick__select', '.grid .card'].map(r);
    const words = (el) => {
      const range = document.createRange();
      range.selectNodeContents([...el.childNodes].find((n) => n.textContent.trim()));
      return range.getBoundingClientRect().left;
    };
    return {
      left: [r('.hud .brand').left, r('.browse .search').left, r('.browse__side .filters').left, r('.page-foot .brand').left].map(x),
      right: [r('.hud .menu-btn').right, r('.grid').right, r('.sort').right].map(x),
      columns: [r('.browse .kinds').left, r('.grid').left].map(x),
      rows: [x(heading.top + heading.height / 2), x(count.top + count.height / 2)],
      first: [x(pick.top), x(card.top)],
      sideLeft: [r('.browse .search').left, r('.browse__side .filters').left, pick.left].map(x),
      sideRight: [r('.browse .search').right, r('.browse__side .filters').right, pick.right].map(x),
      // the chosen runtime's name, as the list shows it, and a tag's
      words: [words(document.querySelector('.browse__side selectedcontent .pick__name') ?? document.querySelector('.browse__side .pick__select')), words(document.querySelector('.browse__side .tags .chip'))].map(x),
    };
  });
  const level = (a, d = 1) => Math.max(...a) - Math.min(...a) <= d;
  report(
    level(lines.left) && level(lines.right) && level(lines.columns) && level(lines.rows, 2) && level(lines.first),
    'one column: the HUD, bar, sidebar, grid and footer share their edges',
    JSON.stringify(lines),
  );
  report(
    level(lines.sideLeft) && level(lines.sideRight) && level(lines.words),
    'the sidebar: the runtime list on the search’s edges, its words where a tag’s are',
    JSON.stringify({ left: lines.sideLeft, right: lines.sideRight, words: lines.words }),
  );

  // an item whose description (text and code) is kept here, not only at its source
  await page.goto(`${base}/harness/anthropics/mcp-builder`, { waitUntil: 'networkidle' });
  const item = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    const img = document.querySelector('.publisher img.avatar');
    return {
      head: Math.round(r('.head__badges').top),
      side: Math.round(r('.side__inner > .panel').top),
      order: [...document.querySelectorAll('.side__inner > .panel')].map((p) => [...p.classList].find((c) => c !== 'panel')).join(' '),
      code: r('.readme pre') ? Math.round(r('.readme pre').right) : null,
      text: r('.readme > p') ? Math.round(r('.readme > p').right) : null,
      column: Math.round(r('.toc').right),
      avatar: img ? img.complete && img.naturalWidth > 0 : 'letter',
    };
  });
  report(
    Math.abs(item.head - item.side) <= 1 &&
      item.order.startsWith('publisher install') &&
      (item.code === null || Math.abs(item.code - item.column) <= 1) &&
      item.text !== null &&
      Math.abs(item.text - item.column) <= 1 &&
      item.avatar !== false,
    'an item: its side level with its head, the publisher first, its text and code as wide as the column',
    JSON.stringify(item),
  );

  await page.click('.page-foot [data-theme-set="light"]');
  const switched = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('sr-theme'), bg: getComputedStyle(document.documentElement).backgroundColor }));
  await page.goto(`${base}/zh/harness/`, { waitUntil: 'networkidle' });
  const next = await page.evaluate(() => ({ atReady: window.__themeAtReady, pressed: document.querySelector('.page-foot [aria-pressed="true"]')?.dataset.themeSet }));
  await page.goto(`${base}/`, { waitUntil: 'load' });
  // the scene's own colour, in an empty corner of the sky: paper by day, night by night
  const sky = async () => {
    const shot = await page.screenshot({ clip: { x: 260, y: 150, width: 1, height: 1 } });
    const { data } = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = new OffscreenCanvas(1, 1).getContext('2d');
      c.drawImage(img, 0, 0);
      return { data: [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)] };
    }, shot.toString('base64'));
    return data;
  };
  const near = (rgb, target, d = 8) => rgb.every((v, i) => Math.abs(v - target[i]) <= d);
  await page.waitForTimeout(5200);
  const home = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? 'dark',
    atReady: window.__themeAtReady,
    bg: getComputedStyle(document.documentElement).backgroundColor,
    pressed: [...document.querySelectorAll('[aria-pressed="true"][data-theme-set]')].map((b) => b.dataset.themeSet).join(),
    shown: [...document.querySelectorAll('[data-theme-switch]')].every((s) => !s.hidden),
  }));
  home.sky = await sky();
  await page.click('.hud-foot [data-theme-set="dark"]');
  await page.waitForTimeout(300);
  const night = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? 'dark', stored: localStorage.getItem('sr-theme'), bg: getComputedStyle(document.documentElement).backgroundColor }));
  night.sky = await sky();
  report(
    switched.theme === 'light' && switched.stored === 'light' && switched.bg === 'rgb(246, 245, 241)' && next.atReady === 'light' && next.pressed === 'light',
    'the theme switches and holds from the next page’s first paint',
    JSON.stringify({ switched, next }),
  );
  report(
    home.theme === 'light' && home.atReady === 'light' && home.bg === 'rgb(246, 245, 241)' && home.pressed === 'light,light' && home.shown && near(home.sky, [246, 245, 241]) &&
      night.theme === 'dark' && night.stored === 'dark' && night.bg === 'rgb(5, 5, 7)' && night.sky.every((v) => v < 40),
    'the homepage too: its scene by day, and back to night from its own switch',
    JSON.stringify({ home, night }),
  );
  report(!errors.length, 'lines and themes: no errors', errors.join(' | '));
  await ctx.close();
}

// 9. prompts: their shelf as a gallery, pictures that move when pointed at, copying a whole prompt from
// a card or its page, prompts among other items in rows that still line up, and the page of one
{
  const { ctx, page, errors } = await open('/zh/harness/?kind=prompt');
  /** the distinct heights of the cards in each row: one per row when they line up */
  const rowHeights = () =>
    page.$$eval('[data-grid] > li', (lis) => {
      const rows = new Map();
      for (const li of lis) {
        const r = li.getBoundingClientRect();
        rows.set(Math.round(r.top), [...new Set([...(rows.get(Math.round(r.top)) ?? []), Math.round(r.height)])]);
      }
      return [...rows.values()];
    });
  const shelf = await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
    const covers = [...document.querySelectorAll('.pc__cover')];
    return {
      chip: document.querySelector('.kinds a[aria-current="page"]')?.textContent?.replace(/\s+/g, ' ').trim(),
      gallery: !!document.querySelector('[data-grid].grid--gallery'),
      cards: document.querySelectorAll('[data-grid] > li.pc').length,
      covers: covers.length,
      loaded: covers.filter((img) => img.complete && img.naturalWidth > 0).length,
      runtime: !!document.querySelector('.browse__side .pick__select'),
      copies: [...document.querySelectorAll('.pc__copy')].filter((b) => !b.hidden).length,
    };
  });
  const rows = await rowHeights();
  report(
    shelf.chip?.startsWith('提示词') && shelf.gallery && shelf.cards > 0 && shelf.covers > 0 && shelf.loaded === shelf.covers && !shelf.runtime && shelf.copies === shelf.cards && rows.every((r) => r.length === 1),
    'prompts: a gallery whose pictures are kept here, rows that line up, a copy button on each, no runtime list',
    JSON.stringify({ ...shelf, rows: rows.length }),
  );

  const moving = await page.$('.pc:has(.pc__motion)');
  if (moving) {
    await moving.scrollIntoViewIfNeeded();
    const still = await moving.$eval('.pc__motion', (img) => ({ shown: getComputedStyle(img).display, src: img.currentSrc || null }));
    await moving.hover();
    await page.waitForFunction((card) => {
      const img = card.querySelector('.pc__motion');
      return getComputedStyle(img).display === 'block' && img.complete && img.naturalWidth > 0;
    }, moving, { timeout: 8000 }).catch(() => {});
    const played = await moving.$eval('.pc__motion', (img) => ({ shown: getComputedStyle(img).display, width: img.naturalWidth }));
    report(still.shown === 'none' && !still.src && played.shown === 'block' && played.width > 0, 'a moving preview loads and plays only while its card is pointed at', JSON.stringify({ still, played }));
  } else report(true, 'a moving preview: none on this page');

  // copying from a card: the whole prompt, fetched when clicked
  const card = page.locator('[data-grid] > li.pc').first();
  const ref = (await card.locator('.pc__link').getAttribute('href')).replace(/^\/zh\/harness\//, '');
  const whole = await page.evaluate(async (r) => (await fetch(`/api/harness/v1/items/${r}/prompt`)).text(), ref);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await card.locator('.pc__copy').click();
  await page.waitForFunction(async (text) => (await navigator.clipboard.readText()) === text, whole, { timeout: 5000 }).catch(() => {});
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  report(whole.length > 0 && copied === whole, 'a card copies its whole prompt', `${copied.length} of ${whole.length} characters`);

  // more of the shelf comes in place, its copy buttons ready
  const more = page.locator('[data-more]');
  if (await more.count()) {
    await mark(page);
    const before = shelf.cards;
    await more.click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-grid] > li.pc').length > n, before, { timeout: 8000 }).catch(() => {});
    const after = await page.evaluate(() => ({ cards: document.querySelectorAll('[data-grid] > li.pc').length, hidden: [...document.querySelectorAll('.pc__copy')].filter((b) => b.hidden).length }));
    report((await same(page)) && after.cards > before && after.hidden === 0, 'more prompts load in place, with their copy buttons', JSON.stringify({ before, ...after }));
  }

  // prompts among other items: the same rows, the same heights
  await page.goto(`${base}/zh/harness/?q=video`, { waitUntil: 'networkidle' });
  const mixed = await page.evaluate(() => ({
    prompts: document.querySelectorAll('[data-grid] > li.card--prompt').length,
    others: document.querySelectorAll('[data-grid] > li.card:not(.card--prompt)').length,
  }));
  const mixedRows = await rowHeights();
  report(mixed.prompts > 0 && mixedRows.every((r) => r.length === 1), 'prompts quoted among other items, every row still level', JSON.stringify({ ...mixed, rows: mixedRows.slice(0, 4) }));

  // the page of one: the prompt to copy, the results made with it, its checks, nothing to install
  await page.goto(`${base}/zh/harness/${ref}`, { waitUntil: 'networkidle' });
  const one = await page.evaluate(() => ({
    text: document.getElementById('prompt-text')?.textContent ?? null,
    sections: [...document.querySelectorAll('[data-section]')].map((s) => s.id).join(' '),
    use: document.querySelector('.side .install h2')?.textContent,
    shots: document.querySelectorAll('#results .shot').length,
    credit: !!document.querySelector('.credit a[href^="mailto:"]'),
    copy: !document.querySelector('.side .use__copy')?.hidden,
  }));
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.click('.side .use__copy');
  await page.waitForFunction(async (text) => (await navigator.clipboard.readText()) === text, whole, { timeout: 5000 }).catch(() => {});
  const fromPage = await page.evaluate(() => navigator.clipboard.readText());
  report(
    one.text === whole && /^prompt( results)? checks/.test(one.sections) && !/permissions|files/.test(one.sections) && one.use === '使用' && one.credit && one.copy && fromPage === whole,
    'a prompt’s page: the prompt as written, copied whole from its Use panel, its results and checks, nothing to install',
    JSON.stringify({ ...one, text: one.text?.length, copied: fromPage.length }),
  );
  report(!errors.length, 'prompts: no errors', errors.join(' | '));
  await ctx.close();
}

// 10. assistants: their shelf of their own cards (a seal, what each may touch, rows that line up, no
// runtime list), more of it in place, assistants among other items, and the page of one: instructions,
// capabilities, its definition to download and to copy
{
  const { ctx, page, errors } = await open('/zh/harness/?kind=assistant');
  const rowHeights = () =>
    page.$$eval('[data-grid] > li', (lis) => {
      const rows = new Map();
      for (const li of lis) {
        const r = li.getBoundingClientRect();
        rows.set(Math.round(r.top), [...new Set([...(rows.get(Math.round(r.top)) ?? []), Math.round(r.height)])]);
      }
      return [...rows.values()];
    });
  const shelf = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-grid] > li.ac')];
    return {
      chip: document.querySelector('.kinds a[aria-current="page"]')?.textContent?.replace(/\s+/g, ' ').trim(),
      note: !!document.querySelector('.results__note'),
      cards: cards.length,
      others: document.querySelectorAll('[data-grid] > li:not(.ac)').length,
      seals: cards.filter((c) => c.querySelector('.seal svg .seal__node')).length,
      said: cards.filter((c) => /^可以|^这几类/.test(c.querySelector('.access[role="img"]')?.getAttribute('aria-label') ?? '')).length,
      runtime: !!document.querySelector('.browse__side .pick__select'),
    };
  });
  const rows = await rowHeights();
  report(
    shelf.chip?.startsWith('助手') && shelf.note && shelf.cards > 0 && !shelf.others && shelf.seals === shelf.cards && shelf.said === shelf.cards && !shelf.runtime && rows.every((r) => r.length === 1),
    'assistants: their own cards, each with a seal and what it may touch in words, rows that line up, no runtime list',
    JSON.stringify({ ...shelf, rows: rows.length }),
  );

  const more = page.locator('[data-more]');
  if (await more.count()) {
    await mark(page);
    await more.click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-grid] > li.ac').length > n, shelf.cards, { timeout: 8000 }).catch(() => {});
    const after = await page.evaluate(() => ({ cards: document.querySelectorAll('[data-grid] > li.ac').length, others: document.querySelectorAll('[data-grid] > li:not(.ac)').length }));
    report((await same(page)) && after.cards > shelf.cards && !after.others, 'more assistants load in place, as their own cards', JSON.stringify({ before: shelf.cards, ...after }));
  }

  // among other items: an ItemCard with its seal, the same rows, the same heights
  await page.goto(`${base}/zh/harness/?q=reviewer`, { waitUntil: 'networkidle' });
  const mixed = await page.evaluate(() => ({
    assistants: document.querySelectorAll('[data-grid] > li.card--assistant').length,
    sealed: document.querySelectorAll('[data-grid] > li.card--assistant .card__title .seal').length,
    dots: document.querySelectorAll('[data-grid] > li.card--assistant .access--compact[aria-label]').length,
  }));
  const mixedRows = await rowHeights();
  report(
    mixed.assistants > 0 && mixed.sealed === mixed.assistants && mixed.dots === mixed.assistants && mixedRows.every((r) => r.length === 1),
    'assistants among other items: a seal before the title, four dots that read as words, every row level',
    JSON.stringify({ ...mixed, rows: mixedRows.slice(0, 4) }),
  );

  // the page of one kept here: its sections, its definition to download and to copy
  await page.goto(`${base}/zh/harness/?kind=assistant`, { waitUntil: 'networkidle' });
  const href = await page.locator('[data-grid] > li.ac a').first().getAttribute('href');
  await page.goto(`${base}${href}`, { waitUntil: 'networkidle' });
  const one = await page.evaluate(() => {
    const download = document.querySelector('.side .install a[download]');
    return {
      sections: [...document.querySelectorAll('[data-section]')].map((s) => s.id).join(' '),
      seal: !!document.querySelector('.head__title .seal'),
      install: document.querySelector('.side .install h2')?.textContent,
      file: download?.getAttribute('download'),
      blob: download?.getAttribute('href'),
      copy: !document.querySelector('.side .install .use__copy')?.hidden,
      starters: document.querySelectorAll('#examples .starter').length,
      starterCopies: document.querySelectorAll('#examples .starter .copy:not([hidden])').length,
    };
  });
  const definition = one.blob ? await page.evaluate(async (u) => (await fetch(u)).text(), one.blob) : '';
  await page.evaluate(() => navigator.clipboard.writeText(''));
  if (one.copy) await page.click('.side .install .use__copy');
  await page.waitForFunction(async (text) => (await navigator.clipboard.readText()) === text, definition, { timeout: 5000 }).catch(() => {});
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  report(
    /^instructions( examples)? capabilities permissions checks/.test(one.sections) && !/files|readme|server/.test(one.sections) && one.seal && one.install === '安装' &&
      /\.md$/.test(one.file ?? '') && /^\/api\/harness\/v1\/blobs\/[0-9a-f]{64}$/.test(one.blob ?? '') && definition.startsWith('---') && copied === definition &&
      one.starterCopies === one.starters,
    'an assistant’s page: instructions and capabilities, no file list, its definition downloaded and copied whole',
    JSON.stringify({ ...one, definition: definition.length, copied: copied.length }),
  );

  // on a phone the kinds run past the screen: the one on show (the last) is scrolled into view, the row fading where it runs on
  const phone = await open('/zh/harness/?kind=assistant', { phone: true });
  const kinds = await phone.page.evaluate(() => {
    const row = document.querySelector('.kinds');
    const a = row.getBoundingClientRect();
    const b = row.querySelector('[aria-current="page"]').getBoundingClientRect();
    return { runsOn: row.scrollWidth > row.clientWidth, inView: b.left >= a.left - 1 && b.right <= a.right + 1, before: row.classList.contains('has-before'), after: row.classList.contains('has-more') };
  });
  report(!kinds.runsOn || (kinds.inView && kinds.before), 'on a phone, the kind on show is in its row’s view, the row fading where it runs on', JSON.stringify(kinds));
  await phone.ctx.close();
  errors.push(...phone.errors);

  report(!errors.length, 'assistants: no errors', errors.join(' | '));
  await ctx.close();
}

// 11. Space, the assistant and open source: in the frame, with their HUD link
// current; a preview below the fold fills in as it scrolls into view (one
// already in view is simply there); the hero's drawing waits while it is off
// screen; "Get your ring" opens signing in; the closing still stays night in
// the light theme; nothing is wider than a phone; and reduced motion holds
// every drawing still.
for (const [path, twin] of [
  ['/space/', '/zh/space/'],
  ['/zh/assistant/', '/assistant/'],
  ['/open-source/', '/zh/open-source/'],
]) {
  const { ctx, page, errors } = await open(path);
  const seen = await page.evaluate(() => ({
    current: document.querySelector('.nav__link[aria-current="page"]')?.getAttribute('href'),
    dot: document.querySelector('.nav__dot')?.classList.contains('is-on'),
    twin: document.querySelector('.page-foot [data-lang-switch]')?.getAttribute('href'),
    h1: document.querySelector('main h1')?.textContent?.trim(),
    art: !!document.querySelector('.lead__art svg'),
  }));
  report(seen.current === path && seen.dot && seen.twin === twin && !!seen.h1 && seen.art, `${path}: in the frame, its HUD link current, its drawing there`, JSON.stringify(seen));

  const preview = await page.evaluate(() => {
    const el = document.querySelector('[data-reveal]');
    if (!el) return null;
    const rows = [...el.querySelectorAll('[data-arrive]')];
    return { inView: el.getBoundingClientRect().top < innerHeight, waiting: el.classList.contains('is-waiting'), hidden: rows.filter((r) => getComputedStyle(r).opacity === '0').length, rows: rows.length };
  });
  if (preview) {
    await page.locator('[data-reveal]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    const shown = await page.evaluate(() => [...document.querySelectorAll('[data-reveal] [data-arrive]')].every((r) => getComputedStyle(r).opacity === '1'));
    const before = preview.inView ? !preview.waiting && preview.hidden === 0 : preview.waiting && preview.hidden === preview.rows;
    report(before && shown, `${path}: the preview ${preview.inView ? 'is there from the start' : 'fills in as it scrolls into view'}`, JSON.stringify({ ...preview, shown }));
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(500);
  const away = await page.evaluate(() => {
    const art = document.querySelector('[data-art]');
    const svg = art?.querySelector('svg[data-smil]');
    const closing = document.querySelector('.closing__art');
    return { paused: art?.classList.contains('is-paused'), smil: svg ? svg.animationsPaused() : null, closing: closing?.complete && closing.naturalWidth > 0 };
  });
  report(away.paused && away.smil !== false && away.closing, `${path}: the drawing waits off screen; the closing ring is there`, JSON.stringify(away));

  const claim = page.locator('main .lead [data-account-card]');
  if (await claim.count()) {
    await claim.click();
    await page.waitForTimeout(400);
    const dialog = await page.evaluate(() => ({ open: document.querySelector('[data-account-dialog]')?.open, out: !document.querySelector('[data-account-view="out"]')?.hidden }));
    await page.keyboard.press('Escape');
    report(dialog.open && dialog.out, `${path}: "Get your ring" opens signing in`, JSON.stringify(dialog));
  }

  await page.evaluate(() => localStorage.setItem('sr-theme', 'light'));
  await page.reload({ waitUntil: 'networkidle' });
  const light = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    page: getComputedStyle(document.body).backgroundColor,
    closing: getComputedStyle(document.querySelector('.closing')).backgroundColor,
    words: getComputedStyle(document.querySelector('.closing__title')).color,
  }));
  report(light.theme === 'light' && light.closing === 'rgb(5, 5, 7)' && light.words === 'rgb(236, 234, 244)', `${path}: light, the closing still night`, JSON.stringify(light));
  report(!errors.length, `${path}: no errors`, errors.join(' | '));
  await ctx.close();

  const phone = await open(path, { phone: true });
  const wide = await phone.page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: innerWidth }));
  report(wide.page <= wide.screen && !phone.errors.length, `${path}: nothing wider than a phone`, JSON.stringify(wide));
  await phone.ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const still = [];
  for (const path of ['/space/', '/assistant/', '/open-source/']) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    still.push(
      await page.evaluate(() => {
        const moving = [...document.querySelectorAll('.lead__art *')].filter((el) => getComputedStyle(el).animationName !== 'none').length;
        const svg = document.querySelector('.lead__art svg[data-smil]');
        return { moving, smil: svg ? svg.animationsPaused() : 'none' };
      }),
    );
  }
  report(still.every((s) => s.moving === 0 && s.smil !== false), 'reduced motion: every drawing holds still', JSON.stringify(still));
  await ctx.close();
}

await browser.close();
console.log(failed ? `${failed} failed` : 'all pages ok');
process.exit(failed ? 1 : 0);
