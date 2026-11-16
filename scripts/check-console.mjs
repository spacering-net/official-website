// The HUD's end and the console, against a preview build (`pnpm build`, then
// `pnpm preview --port 4322`). API answers are synthetic: this never signs
// in. `--shots` also saves pictures to shots/console-*.png.
//
//   node scripts/check-console.mjs [origin] [--shots]
import { chromium } from 'playwright';

const origin = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4322';
const shots = process.argv.includes('--shots');
let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};

const ID = '01900000-0000-7000-8000-000000000001';
const AVATAR = `/api/avatars/${ID}/0123456789abcdef.png`;
const ME = { number: 10000, name: 'xintaofei', image: AVATAR };
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const uuid = (n) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const ACCOUNT = {
  account_srn: 10000,
  user: { ...ME, email: 'xintaofei@example.com', since: '2026-10-07T03:12:00.000Z' },
  providers: [
    { provider: 'github', linked_at: '2026-10-07T03:12:00.000Z' },
    { provider: 'google', linked_at: '2026-10-21T08:30:00.000Z' },
  ],
  sessions: 3,
  clients: 3,
  last_sign_in: { at: hours(-2), user_agent: MAC, provider: 'github' },
};
const CLIENTS = {
  account_srn: 10000,
  next_cursor: null,
  clients: [
    { id: uuid(11), client_name: 'Codeg', client_type: 'desktop', client_origin: null, device_name: 'MacBook Pro', platform: 'macos', created_at: hours(-200), last_used_at: hours(-1), expires_at: hours(700), status: 'active' },
    { id: uuid(12), client_name: 'Codeg', client_type: 'web', client_origin: 'https://codeg.example.com', device_name: null, platform: 'web', created_at: hours(-120), last_used_at: hours(-5), expires_at: hours(700), status: 'active' },
    { id: uuid(13), client_name: 'Codeg', client_type: 'desktop', client_origin: null, device_name: 'Studio PC', platform: 'windows', created_at: hours(-90), last_used_at: hours(-26), expires_at: hours(690), status: 'active' },
    { id: uuid(14), client_name: 'Codeg', client_type: 'desktop', client_origin: null, device_name: 'Old laptop', platform: 'linux', created_at: hours(-1500), last_used_at: hours(-760), expires_at: hours(-40), status: 'expired' },
  ],
};
const SESSIONS = {
  account_srn: 10000,
  sessions: [
    { id: uuid(21), current: true, created_at: hours(-50), updated_at: hours(-0.1), expires_at: hours(700), ip_address: '203.0.113.7', user_agent: MAC },
    { id: uuid(22), current: false, created_at: hours(-300), updated_at: hours(-20), expires_at: hours(500), ip_address: '198.51.100.24', user_agent: IPHONE },
    { id: uuid(23), current: false, created_at: hours(-600), updated_at: hours(-160), expires_at: hours(400), ip_address: '192.0.2.81', user_agent: WINDOWS },
  ],
};
const event = (n, type, at, extra = {}) => ({ id: uuid(100 - n), type, created_at: hours(at), user_agent: MAC, this_network: true, provider: null, client_name: null, count: null, ...extra });
const ACTIVITY = {
  account_srn: 10000,
  next_cursor: null,
  events: [
    event(1, 'session.created', -2, { provider: 'github' }),
    event(2, 'client.connected', -3, { client_name: 'Codeg', user_agent: 'codeg/0.9.2 (macos)' }),
    event(3, 'client.authorized', -3.01),
    event(4, 'session.revoked', -26, { count: 2 }),
    event(5, 'ring_card.shared', -27),
    event(6, 'client.code_reused', -50, { this_network: false, user_agent: 'codeg/0.9.2 (windows)' }),
    event(7, 'session.created', -75, { provider: 'google', user_agent: IPHONE, this_network: false }),
    event(8, 'account.linked', -75.01, { provider: 'google', user_agent: IPHONE, this_network: false }),
    event(9, 'user.created', -900),
  ],
};
const CARD = { card: { number: 10000, name: 'xintaofei', image: AVATAR, since: '2026-10-07T03:12:00.000Z', shared: false, showName: true, showImage: false } };
// a picture as a provider would give: a five-by-five pattern, mirrored
const cells = [1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0];
const AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 70"><rect width="70" height="70" fill="#f0f0f0"/>${cells
  .map((on, i) => (on ? [i % 3, 4 - (i % 3)].map((x) => `<rect x="${10 + x * 10}" y="${10 + Math.floor(i / 3) * 10}" width="10" height="10" fill="#5a9bd5"/>`).join('') : ''))
  .join('')}</svg>`;

/** Answers the account API as for a signed-in user (or signed out). */
async function mock(context, { signedIn = true } = {}) {
  const calls = [];
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    calls.push(`${method} ${url.pathname}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/avatars/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: AVATAR_SVG });
    if (!signedIn) return json({ error: 'signed_out' }, 401);
    if (url.pathname === '/api/me') return json({ user: ME });
    if (url.pathname === '/api/me/account') return json(ACCOUNT);
    if (url.pathname === '/api/me/clients' && method === 'GET') return json(CLIENTS);
    if (url.pathname.startsWith('/api/me/clients/') && method === 'DELETE') return json({ ok: true });
    if (url.pathname === '/api/me/sessions') return json(SESSIONS);
    if (url.pathname.startsWith('/api/me/sessions/')) return json({ ok: true, signed_out: 2 });
    if (url.pathname === '/api/me/activity') return json(ACTIVITY);
    if (url.pathname === '/api/me/card') return json(CARD);
    if (url.pathname === '/api/auth/sign-out') return json({ success: true });
    return json({ error: 'not_found' }, 404);
  });
  return calls;
}

const hint = (context) => context.addInitScript((me) => localStorage.setItem('sr-account', JSON.stringify(me)), ME);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/401|Failed to load resource/.test(m.text()) && errors.push(`${page.url()}: ${m.text()}`));
};
const shoot = async (page, name, clip) => shots && page.screenshot({ path: `shots/console-${name}.png`, ...(clip ? { clip } : {}) });

// ----------------------------------------------------- 1. the HUD's end
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, locale: 'en-US' });
  await mock(context, { signedIn: false });
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/privacy/`);
  const out = await page.evaluate(() => ({
    signIn: getComputedStyle(document.querySelector('.hud .account-btn')).display !== 'none',
    ring: !!document.querySelector('.hud .ring-btn .ring-btn__orbit') && getComputedStyle(document.querySelector('.hud .ring-btn__orbit')).display !== 'none',
    name: getComputedStyle(document.querySelector('.hud .ring-btn__name')).display,
    href: document.querySelector('.hud .ring-btn').getAttribute('href'),
    menu: !!document.querySelector('[data-menu-open], .orbit-menu'),
  }));
  report(out.signIn && out.ring && out.name === 'none' && out.href === '/console/' && !out.menu, 'signed out: "Sign in" and the ring, which leads to the console; no orbit menu', JSON.stringify(out));
  await shoot(page, 'hud-out', { x: 1000, y: 0, width: 600, height: 80 });
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, locale: 'en-US' });
  await mock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  // the first frame already shows the account: nothing is drawn before #hud-end
  await page.goto(`${origin}/privacy/`, { waitUntil: 'commit' });
  await page.waitForSelector('#hud-end', { state: 'attached' });
  const first = await page.evaluate(() => ({
    has: document.documentElement.classList.contains('has-account'),
    name: document.querySelector('.hud [data-account-name]').textContent,
    avatar: document.querySelector('.hud [data-account-avatar]').getAttribute('src'),
  }));
  report(first.has && first.name === 'xintaofei' && first.avatar === AVATAR, 'the hint is in the HUD as soon as it is parsed', JSON.stringify(first));
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  const signed = await page.evaluate(() => ({
    signIn: getComputedStyle(document.querySelector('.hud .account-btn')).display,
    name: getComputedStyle(document.querySelector('.hud .ring-btn__name')).display,
    label: document.querySelector('.hud .ring-btn').getAttribute('aria-label'),
    gap: Math.round(document.querySelector('.hud .ring-btn__face').getBoundingClientRect().left - document.querySelector('.hud .ring-btn__name').getBoundingClientRect().right),
    border: getComputedStyle(document.querySelector('.hud .ring-btn')).borderTopWidth,
  }));
  report(signed.signIn === 'none' && signed.name === 'block' && signed.label === 'xintaofei · SRN 10000 · Console' && signed.gap === 11 && signed.border !== '0px', 'signed in: the name, then the picture, in one band: one link', JSON.stringify(signed));
  await shoot(page, 'hud-in', { x: 1000, y: 0, width: 600, height: 80 });
  await page.hover('.hud .ring-btn');
  await page.waitForTimeout(900);
  await shoot(page, 'hud-in-hover', { x: 1000, y: 0, width: 600, height: 80 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.mouse.move(10, 400);
  await page.waitForTimeout(900);
  await shoot(page, 'hud-in-light', { x: 1000, y: 0, width: 600, height: 80 });
  await context.close();
}

// -------------------------------------------- 2. the narrow screens' menu
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await mock(context, { signedIn: false });
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/zh/space/`);
  await shoot(page, 'phone-out');
  await page.tap('.hud [data-nav-toggle]');
  await page.waitForTimeout(900);
  const open = await page.evaluate(() => ({
    open: !document.querySelector('[data-nav-sheet]').hidden,
    links: [...document.querySelectorAll('.nav-sheet__link')].map((a) => `${a.getAttribute('href')}${a.getAttribute('aria-current') ? '*' : ''}`).join(' '),
    signIn: getComputedStyle(document.querySelector('.nav-sheet__in')).display !== 'none',
    lang: document.querySelector('.nav-sheet [data-lang-switch]')?.getAttribute('href'),
    inert: document.querySelector('main').inert,
    toggle: document.querySelector('[data-nav-toggle]').textContent,
  }));
  report(
    open.open && open.links === '/zh/ /zh/space/* /zh/assistant/ /zh/harness/ /zh/open-source/' && open.signIn && open.lang === '/space/' && open.inert && open.toggle === '关闭',
    'phone: the menu has the HUD’s links, signing in, the languages; the page behind is inert',
    JSON.stringify(open),
  );
  await shoot(page, 'phone-sheet');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const closed = await page.evaluate(() => ({ hidden: document.querySelector('[data-nav-sheet]').hidden, inert: document.querySelector('main').inert }));
  report(closed.hidden && !closed.inert, 'the menu closes with Escape', JSON.stringify(closed));
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await mock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/zh/`);
  await page.waitForTimeout(6500);
  await shoot(page, 'phone-home-in');
  const face = await page.evaluate(() => ({
    name: getComputedStyle(document.querySelector('.hud .ring-btn__name')).display,
    face: getComputedStyle(document.querySelector('.hud .ring-btn__face')).display,
    toggle: getComputedStyle(document.querySelector('.hud .nav-toggle')).display,
  }));
  report(face.name === 'none' && face.face !== 'none' && face.toggle !== 'none', 'phone, signed in: the menu, then the face alone', JSON.stringify(face));
  await page.tap('.hud [data-nav-toggle]');
  await page.waitForTimeout(900);
  await shoot(page, 'phone-home-sheet');
  // the ring's link scrolls the homepage to its top, after the menu closes
  await page.tap('.nav-sheet__link[data-goto="0"]');
  await page.waitForTimeout(700);
  report(await page.evaluate(() => document.querySelector('[data-nav-sheet]').hidden), 'the ring’s link closes the menu on the homepage');
  await context.close();
}

// ------------------------------------------------------------ 3. the console
const sections = ['', 'clients/', 'security/', 'activity/', 'card/', 'backups/'];
for (const [lang, prefix] of [['en', ''], ['zh', '/zh']]) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: lang === 'zh' ? 'zh-CN' : 'en-US' });
  await mock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  for (const section of sections) {
    await page.goto(`${origin}${prefix}/console/${section}`);
    await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
    await page.waitForTimeout(section === 'card/' ? 1500 : 300);
    await shoot(page, `${lang}-${section.replace('/', '') || 'overview'}`);
  }
  const rows = await page.evaluate(() => document.querySelectorAll('.console__link').length);
  report(rows === 7, `${lang}: seven sections on the side`, String(rows));
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US' });
  const calls = await mock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/console/clients/`);
  await page.waitForFunction(() => document.querySelectorAll('[data-list="clients"] .row').length === 4);
  const listed = await page.evaluate(() => ({
    titles: [...document.querySelectorAll('[data-list="clients"] .row__title')].map((e) => e.textContent),
    actions: document.querySelectorAll('[data-list="clients"] .row__action').length,
  }));
  report(listed.titles[1] === 'Codeg Web · https://codeg.example.com' && listed.actions === 3, 'clients: each connection, and a way to end those still usable', JSON.stringify(listed));
  const button = page.locator('[data-list="clients"] .row__action').first();
  await button.click();
  const armed = await button.textContent();
  await button.click();
  await page.waitForTimeout(300);
  report(armed === 'Confirm' && calls.includes(`DELETE /api/me/clients/${uuid(11)}`), 'disconnecting asks once more, then sends', armed);

  await page.goto(`${origin}/console/security/`);
  await page.waitForFunction(() => document.querySelectorAll('[data-list="sessions"] .row').length === 3);
  const security = await page.evaluate(() => ({
    methods: [...document.querySelectorAll('[data-list="methods"] .row__title')].map((e) => e.textContent).join(),
    first: document.querySelector('[data-list="sessions"] .row__title').textContent,
    others: !document.querySelector('[data-revoke-others]').hidden,
  }));
  report(security.methods === 'GitHub,Google' && security.first === 'Chrome on macOSThis browser' && security.others, 'security: methods, this browser first, signing the others out', JSON.stringify(security));

  await page.goto(`${origin}/console/activity/`);
  await page.waitForFunction(() => document.querySelectorAll('[data-list="activity"] .row--event').length === 9);
  const log = await page.evaluate(() => ({
    first: document.querySelector('.row--event .row__title').textContent,
    alert: document.querySelectorAll('.row--alert').length,
    days: document.querySelectorAll('.rows__day').length,
    today: document.querySelector('.rows__day').textContent,
    chips: document.querySelectorAll('[data-list="activity"] .chip').length,
    meta: document.querySelector('.row--event .row__meta').textContent,
  }));
  report(log.first === 'Signed in with GitHub' && log.alert === 1 && log.days >= 3 && /^(Today|Yesterday) · /.test(log.today) && !log.chips && /This network/.test(log.meta), 'activity: words for each event, by day (today by name), the reused code marked, this network in plain words', JSON.stringify(log));

  // signing out from the side: the console asks to sign in again, and the HUD says so
  await page.click('[data-console-signout]');
  await page.waitForFunction(() => document.querySelector('[data-console]').dataset.state === 'out');
  const after = await page.evaluate(() => ({ has: document.documentElement.classList.contains('has-account'), hint: localStorage.getItem('sr-account'), gate: !document.querySelector('[data-console-gate]').hidden }));
  report(!after.has && after.hint === null && after.gate, 'signing out shows the way back in', JSON.stringify(after));
  await context.close();
}
// by day: the same frame in ink on paper
if (shots) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US' });
  await mock(context);
  await hint(context);
  await context.addInitScript(() => localStorage.setItem('sr-theme', 'light'));
  const page = await context.newPage();
  watch(page);
  for (const section of ['', 'security/', 'activity/']) {
    await page.goto(`${origin}/console/${section}`);
    await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
    await page.waitForTimeout(300);
    await shoot(page, `light-${section.replace('/', '') || 'overview'}`);
  }
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US' });
  await mock(context, { signedIn: false });
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/console/security/`);
  await page.waitForFunction(() => document.querySelector('[data-console]').dataset.state === 'out');
  await shoot(page, 'gate');
  report(await page.evaluate(() => !document.querySelector('.console__side').checkVisibility()), 'signed out: the way in, and nothing of the account');
  await context.close();
}
// Signing out while the console is still loading (a cookie, but no hint of
// it here): the answer asked for before then must not bring the account back.
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US' });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let signedOut = false;
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.startsWith('/api/avatars/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: AVATAR_SVG });
    if (path === '/api/me/account') {
      await held;
      return json(ACCOUNT);
    }
    if (path === '/api/auth/sign-out') {
      signedOut = true;
      return json({ success: true });
    }
    if (path === '/api/me') return signedOut ? json({ error: 'signed_out' }, 401) : json({ user: ME });
    return json({ error: 'not_found' }, 404);
  });
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/console/`);
  await page.click('.hud [data-account-open]');
  await page.waitForFunction(() => !document.querySelector('[data-account-view="in"]').hidden);
  await page.click('[data-account-signout]');
  // signed out once the dialog closes; only then does the earlier answer arrive
  await page.waitForFunction(() => !document.querySelector('[data-account-dialog]').open);
  release();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    state: document.querySelector('[data-console]').dataset.state,
    gate: !document.querySelector('[data-console-gate]').hidden,
    has: document.documentElement.classList.contains('has-account'),
    hint: localStorage.getItem('sr-account'),
    email: document.querySelector('[data-email]')?.textContent ?? '',
  }));
  report(after.state === 'out' && after.gate && !after.has && after.hint === null && after.email === '', 'signing out mid-load: the late answer does not bring the account back', JSON.stringify(after));
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await mock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  for (const section of ['', 'clients/', 'activity/']) {
    await page.goto(`${origin}/zh/console/${section}`);
    await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
    await page.waitForTimeout(300);
    await shoot(page, `phone-${section.replace('/', '') || 'overview'}`);
  }
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  report(wide, 'phone: nothing wider than the screen');
  // the sections first, under the HUD; who is signed in at the end, over the page's last line
  const order = await page.evaluate(() => {
    const top = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top + scrollY);
    const signOut = document.querySelector('[data-console-signout]');
    return {
      nav: top('.console__nav'),
      main: top('.console__main'),
      body: Math.round(document.querySelector('.console__body').getBoundingClientRect().bottom + scrollY),
      me: top('.console__me'),
      foot: top('.console__foot'),
      words: signOut.textContent.trim(),
      shown: signOut.querySelector('.console__signout-label').getBoundingClientRect().width > 20,
    };
  });
  report(order.nav < order.main && order.body <= order.me && order.me < order.foot && order.words === '退出登录' && order.shown, 'phone: the sections under the HUD; the account and signing out (in words) at the end, over the foot', JSON.stringify(order));
  // the overview on a phone: the sections in words, the heading down the middle, the figures as rows
  await page.goto(`${origin}/zh/console/`);
  await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
  const phone = await page.evaluate(() => {
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2);
    };
    const tiles = [...document.querySelectorAll('.tile')].map((t) => Math.round(t.getBoundingClientRect().left));
    return {
      icons: [...document.querySelectorAll('.console__nav .console-icon')].some((i) => i.getBoundingClientRect().width > 0),
      face: mid(document.querySelector('.profile > .face')),
      name: mid(document.querySelector('.profile__name')),
      edit: mid(document.querySelector('.profile__edit')),
      screen: Math.round(innerWidth / 2),
      rows: new Set(tiles).size === 1 && document.querySelector('.tiles').getBoundingClientRect().height < 360,
    };
  });
  report(!phone.icons && [phone.face, phone.name, phone.edit].every((x) => Math.abs(x - phone.screen) <= 2) && phone.rows, 'phone overview: the sections in words, the heading down the middle, the figures as the rows of one panel', JSON.stringify(phone));
  // a row's details break between themselves, and a state goes with its button
  await page.goto(`${origin}/zh/console/clients/`);
  await page.waitForFunction(() => document.querySelectorAll('[data-list="clients"] .row').length === 4);
  const rows = await page.evaluate(() => {
    const row = document.querySelector('[data-list="clients"] .row');
    const box = (el) => el.getBoundingClientRect();
    return {
      details: [...row.querySelectorAll('.row__detail')].every((d) => d.getClientRects().length === 1 && getComputedStyle(d).whiteSpace === 'nowrap'),
      level: Math.abs(box(row.querySelector('.status')).top + box(row.querySelector('.status')).height / 2 - (box(row.querySelector('.row__action')).top + box(row.querySelector('.row__action')).height / 2)) <= 2,
      wide: Math.round(box(row.querySelector('.row__main')).right) >= Math.round(box(row.querySelector('.row__action')).right) - 1,
    };
  });
  report(rows.details && rows.level && rows.wide, 'phone rows: details kept whole, the words the full width, a state level with its button', JSON.stringify(rows));
  await page.goto(`${origin}/zh/console/relay/`);
  await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
  const tab = await page.evaluate(() => {
    const row = document.querySelector('.console__nav').getBoundingClientRect();
    const link = document.querySelector('.console__nav [aria-current="page"]').getBoundingClientRect();
    return { left: Math.round(link.left - row.left), right: Math.round(row.right - link.right), first: document.querySelector('.console__nav').scrollLeft };
  });
  report(tab.first > 0 && tab.left >= 0 && tab.right >= 16, 'phone: a section far along the row is in view from the start', JSON.stringify(tab));
  await page.goto(`${origin}/zh/console/clients/`);
  await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
  report((await page.evaluate(() => document.querySelector('.console__nav').scrollLeft)) === 0, 'phone: one already in view leaves the row where it starts');
  await context.close();
}

// ------------------------------------------------------------- 4. the profile
// The overview's heading: no ring number or forging date (the side has the
// number). The face and Edit profile open the profile in a dialog, as the
// side's account card does on every section; one Save sends both.
const NEW_AVATAR = `/api/avatars/${ID}/fedcba9876543210.jpg`;
/** a picture as a camera would give: wider than tall, larger than kept; or a mark with nothing round it (clear) */
const photo = async (page, { clear = false } = {}) =>
  Buffer.from(
    await page.evaluate(async (clear) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1200, height: 800 });
      const g = canvas.getContext('2d');
      const sky = g.createLinearGradient(0, 0, 1200, 800);
      sky.addColorStop(0, '#1d3557');
      sky.addColorStop(1, '#e76f51');
      g.fillStyle = sky;
      if (!clear) g.fillRect(0, 0, 1200, 800);
      g.fillStyle = clear ? '#e76f51' : '#f1faee';
      g.beginPath();
      g.arc(600, 400, 220, 0, Math.PI * 2);
      g.fill();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, clear),
  );
async function profileMock(context) {
  // next: answers to give instead; hold: a promise the next answer waits for
  const state = { user: { ...ME }, sent: [], next: [], hold: null };
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.startsWith('/api/avatars/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: path === NEW_AVATAR ? AVATAR_SVG.replaceAll('#5a9bd5', '#e76f51') : AVATAR_SVG });
    if (path === '/api/me') return json({ user: state.user });
    if (path === '/api/me/account') return json({ ...ACCOUNT, user: { ...ACCOUNT.user, ...state.user } });
    if (path === '/api/me/clients') return json(CLIENTS);
    if (path === '/api/me/profile' && request.method() === 'PATCH') {
      const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData();
      const fields = {};
      for (const [key, value] of form) fields[key] = typeof value === 'string' ? value : { type: value.type, size: value.size };
      state.sent.push({ fields, origin: request.headers().origin ?? null });
      if (state.hold) await state.hold;
      const forced = state.next.shift();
      if (forced) return json(forced.body, forced.status);
      if (fields.name) state.user.name = fields.name;
      if (fields.avatar) state.user.image = NEW_AVATAR;
      if (fields.remove_avatar) state.user.image = null;
      return json({ account_srn: 10000, user: state.user });
    }
    return json({ error: 'not_found' }, 404);
  });
  return state;
}
const isOpen = (page) => page.evaluate(() => document.querySelector('[data-profile-dialog]').open);
// closed, and done closing (the page is let go on the dialog's close event, a moment after)
const closed = (page) => page.waitForFunction(() => !document.querySelector('[data-profile-dialog]').open && !document.documentElement.classList.contains('is-locked'), null, { timeout: 10000 });
const error = (page, where) => page.evaluate((where) => document.querySelector(`[data-profile-error="${where}"]`).textContent, where);
const DIALOG = { x: 560, y: 230, width: 480, height: 540 };
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, locale: 'zh-CN' });
  const state = await profileMock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/zh/console/`);
  await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
  const view = await page.evaluate(() => {
    const head = document.querySelector('.profile');
    return {
      number: !!head.querySelector('[data-account-number]'),
      srn: /SRN/.test(head.textContent),
      forged: /锻造/.test(head.textContent),
      side: document.querySelector('.console__side [data-account-number]').textContent,
      email: head.querySelector('[data-email]').textContent,
      methods: !!head.querySelector('.profile__methods, [data-methods]'),
      edit: getComputedStyle(head.querySelector('.profile__edit')).visibility,
    };
  });
  report(!view.number && !view.srn && !view.forged && view.side === '10000', 'overview: no ring number or forging date in the heading; the side keeps the number', JSON.stringify(view));
  report(view.email === 'xintaofei@example.com' && !view.methods && view.edit === 'visible', 'overview: the email under the name, no sign-in methods, and Edit profile', JSON.stringify(view));
  // the side: the sections at the top, who is signed in at the foot, level with the page's last line
  const side = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return { nav: Math.round(box('.console__nav').top - box('.console__side').top), me: Math.round(box('.console__side').bottom - box('.console__me').bottom), line: Math.round(box('.console__me').top - box('.console__foot').top), name: document.querySelector('.console__me .console__name').textContent };
  });
  report(side.nav <= 21 && side.me === 0 && Math.abs(side.line) <= 1 && side.name === 'xintaofei', 'side: the sections first, the account at its foot, its hairline level with the page’s last line', JSON.stringify(side));
  await shoot(page, 'profile-view', { x: 0, y: 70, width: 1600, height: 300 });
  await page.hover('.console__id');
  await page.waitForTimeout(900);
  await shoot(page, 'side-account-hover', { x: 0, y: 880, width: 340, height: 120 });

  // Edit profile: the dialog, the name ready to type, the page held still behind it
  await page.click('.profile__edit');
  const opened = await page.evaluate(() => {
    const dialog = document.querySelector('[data-profile-dialog]');
    return {
      modal: dialog.matches(':modal'),
      value: document.querySelector('[data-profile-name]').value,
      focused: document.activeElement === document.querySelector('[data-profile-name]'),
      count: document.querySelector('[data-profile-count]').textContent,
      remove: !document.querySelector('[data-avatar-remove]').hidden,
      locked: document.documentElement.classList.contains('is-locked'),
      face: dialog.querySelector('[data-face] [data-account-avatar]').getAttribute('src'),
    };
  });
  report(opened.modal && opened.value === 'xintaofei' && opened.focused && opened.count === '9/32' && opened.remove && opened.locked && opened.face === AVATAR, 'Edit profile opens the dialog: the picture with its tools, the name focused and counted, the page locked behind', JSON.stringify(opened));
  await page.waitForTimeout(500);
  await shoot(page, 'profile-dialog', DIALOG);
  await page.fill('[data-profile-name]', ' \u200b ');
  await page.click('[data-profile-save]');
  const empty = { error: await error(page, 'name'), invalid: await page.getAttribute('[data-profile-name]', 'aria-invalid') };
  await page.fill('[data-profile-name]', 'x'.repeat(33));
  const over = await page.evaluate(() => document.querySelector('[data-profile-count]').className);
  await page.keyboard.press('Enter');
  const long = await error(page, 'name');
  report(empty.error === '请输入名字。' && empty.invalid === 'true' && /is-over/.test(over) && long === '名字最多 32 个字。' && state.sent.length === 0, 'an empty or too long name is caught before sending, under the name', JSON.stringify({ empty, over, long }));
  await page.waitForTimeout(400);
  await shoot(page, 'profile-dialog-error', DIALOG);
  await page.keyboard.press('Escape');
  await closed(page);
  const escaped = await page.evaluate(() => ({ name: document.querySelector('.profile__name').textContent, focus: document.activeElement?.classList.contains('profile__edit'), locked: document.documentElement.classList.contains('is-locked') }));
  report(escaped.name === 'xintaofei' && escaped.focus && !escaped.locked, 'Escape closes it with nothing changed, focus back on Edit profile', JSON.stringify(escaped));

  // the veil closes it; a drag that began inside it does not
  await page.click('.profile__edit');
  await page.mouse.click(40, 500);
  const veil = !(await isOpen(page));
  await page.click('.profile__edit');
  const field = await page.locator('[data-profile-name]').boundingBox();
  await page.mouse.move(field.x + 20, field.y + field.height / 2);
  await page.mouse.down();
  await page.mouse.move(40, 500, { steps: 4 });
  await page.mouse.up();
  const dragged = await isOpen(page);
  await page.click('[data-profile-cancel]');
  await closed(page);
  report(veil && dragged, 'a click on the veil closes it; selecting past its edge does not', JSON.stringify({ veil, dragged }));

  // the face opens it too; the dialog's face takes a picture, made square and smaller here, shown until saved
  await page.click('.profile > .face');
  const fromFace = await page.evaluate(() => ({ open: document.querySelector('[data-profile-dialog]').open, focus: document.activeElement === document.querySelector('[data-profile-dialog] [data-face]') }));
  const chooser = page.waitForEvent('filechooser');
  await page.click('[data-profile-dialog] [data-face]');
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await photo(page) });
  await page.waitForFunction(() => document.querySelector('[data-face]').dataset.pending === 'new' && document.querySelector('[data-avatar-preview]').complete);
  const previewed = await page.evaluate(() => {
    const img = document.querySelector('[data-avatar-preview]');
    return { w: img.naturalWidth, h: img.naturalHeight, heading: document.querySelector('.profile > .face [data-account-avatar]').getAttribute('src'), hud: document.querySelector('.hud [data-account-avatar]').getAttribute('src') };
  });
  report(fromFace.open && fromFace.focus && previewed.w === 384 && previewed.h === 384 && previewed.hud === AVATAR && previewed.heading === AVATAR, 'the face opens it too; a new picture: the middle square at 384 px, shown in the dialog only', JSON.stringify({ fromFace, previewed }));
  await page.fill('[data-profile-name]', '  新名字   Ada ');
  await page.mouse.move(40, 500);
  await page.waitForTimeout(400);
  await shoot(page, 'profile-preview', DIALOG);
  await page.click('[data-profile-save]');
  await closed(page);
  const saved = await page.evaluate(() => ({
    hud: document.querySelector('.hud .ring-btn__name').textContent,
    side: document.querySelector('.console__side .console__name').textContent,
    title: document.querySelector('.profile__name').textContent,
    avatar: document.querySelector('.hud [data-account-avatar]').getAttribute('src'),
    face: document.querySelector('.profile > .face [data-account-avatar]').getAttribute('src'),
    pending: document.querySelector('[data-face]').dataset.pending ?? null,
    hint: JSON.parse(localStorage.getItem('sr-account')),
    status: document.querySelector('[data-profile-saved]').textContent,
    label: document.querySelector('.hud [data-console-link]').getAttribute('aria-label'),
    focus: document.activeElement === document.querySelector('.profile > .face'),
  }));
  const first = state.sent[0]?.fields ?? {};
  report(
    state.sent.length === 1 && first.expected_srn === '10000' && first.name === '新名字 Ada' && first.avatar?.type === 'image/jpeg' && first.avatar.size > 0 && state.sent[0].origin === origin,
    'Save sends one form: the ring number shown, the name cleaned, the photo as JPEG (what the ring card can draw)',
    JSON.stringify(state.sent[0]),
  );
  report(
    saved.hud === '新名字 Ada' && saved.side === '新名字 Ada' && saved.title === '新名字 Ada' && saved.avatar === NEW_AVATAR && saved.face === NEW_AVATAR && saved.pending === null && saved.hint.name === '新名字 Ada' && saved.hint.image === NEW_AVATAR && saved.status === '已保存' && saved.label.startsWith('新名字 Ada · SRN 10000') && saved.focus,
    'saved: the dialog closes, the HUD, the side, the heading and the hint all show it at once, focus back on the face',
    JSON.stringify(saved),
  );
  await shoot(page, 'profile-saved', { x: 0, y: 70, width: 1600, height: 300 });

  // removing the picture, from the side's card: previewed as the initial, then sent alone
  await page.click('.console__id');
  await page.click('[data-avatar-remove]');
  const removing = await page.evaluate(() => ({
    pending: document.querySelector('[data-face]').dataset.pending,
    initial: document.querySelector('[data-profile-dialog] .face__initial').checkVisibility({ visibilityProperty: true }),
    remove: document.querySelector('[data-avatar-remove]').hidden,
    focus: document.activeElement?.matches('.editor__tool[data-avatar-pick]'),
  }));
  await page.click('[data-profile-save]');
  await closed(page);
  const removed = await page.evaluate(() => ({ avatar: document.querySelector('.hud [data-account-avatar]').hidden, initial: document.querySelector('.hud .ring-btn__initial').textContent, focus: document.activeElement?.classList.contains('console__id') }));
  report(
    removing.pending === 'none' && removing.initial && removing.remove && removing.focus && JSON.stringify(state.sent[1]?.fields) === JSON.stringify({ expected_srn: '10000', remove_avatar: '1' }) && removed.avatar && removed.initial === '新' && removed.focus,
    'from the side’s card: removing the picture shows the initial until saved, then only the removal is sent',
    JSON.stringify({ removing, sent: state.sent[1], removed }),
  );

  // nothing changed: nothing sent
  await page.click('.profile__edit');
  await page.click('[data-profile-save]');
  await closed(page);
  report(state.sent.length === 2, 'Save with nothing changed just closes');

  // a picture still being made (decoding held back here): Save waits for it, then sends it
  const clear = await photo(page, { clear: true });
  await page.evaluate(() => {
    const decode = (window.__decode = HTMLImageElement.prototype.decode);
    HTMLImageElement.prototype.decode = function () {
      return new Promise((resolve) => setTimeout(resolve, 1200)).then(() => decode.call(this));
    };
  });
  await page.click('.profile__edit');
  const slowChooser = page.waitForEvent('filechooser');
  await page.click('.editor__tool[data-avatar-pick]');
  await (await slowChooser).setFiles({ name: 'mark.png', mimeType: 'image/png', buffer: clear });
  await page.fill('[data-profile-name]', 'Ada Slow');
  const waiting = await page.evaluate(() => document.querySelector('[data-profile-save]').disabled);
  await page.press('[data-profile-name]', 'Enter');
  await page.waitForTimeout(300);
  const sentWhileMaking = state.sent.length;
  await page.waitForFunction(() => document.querySelector('[data-face]').dataset.pending === 'new');
  const ready = await page.evaluate(() => !document.querySelector('[data-profile-save]').disabled);
  await page.click('[data-profile-save]');
  await closed(page);
  await page.evaluate(() => (HTMLImageElement.prototype.decode = window.__decode));
  const slow = state.sent.at(-1).fields;
  report(
    waiting && sentWhileMaking === 2 && ready && slow.avatar?.type === 'image/png' && slow.name === 'Ada Slow',
    'a picture still being made: Save waits for it, then sends it; one with see-through parts goes as PNG',
    JSON.stringify({ waiting, sentWhileMaking, ready, slow }),
  );

  // while saving, it holds still: Escape and the veil leave it open
  let release;
  state.hold = new Promise((resolve) => (release = resolve));
  await page.click('.profile__edit');
  await page.fill('[data-profile-name]', 'Ada Held');
  await page.click('[data-profile-save]');
  await page.waitForFunction(() => document.querySelector('[data-profile-save]').textContent === '正在保存…');
  await page.keyboard.press('Escape');
  await page.mouse.click(40, 500);
  const holding = await page.evaluate(() => ({ open: document.querySelector('[data-profile-dialog]').open, cancel: document.querySelector('[data-profile-cancel]').disabled, close: document.querySelector('[data-profile-close]').disabled, readOnly: document.querySelector('[data-profile-name]').readOnly }));
  state.hold = null;
  release();
  await closed(page);
  report(holding.open && holding.cancel && holding.close && holding.readOnly && (await page.textContent('.profile__name')) === 'Ada Held', 'while saving it stays open, nothing in it can change, then it closes with the answer', JSON.stringify(holding));

  // what the API refuses is said in the dialog, which stays open
  state.next.push({ status: 400, body: { error: 'invalid_name', reason: 'long' } });
  await page.click('.profile__edit');
  await page.fill('[data-profile-name]', 'Ada');
  await page.click('[data-profile-save]');
  await page.waitForFunction(() => !document.querySelector('[data-profile-error="name"]').hidden);
  const refused = await page.evaluate(() => ({ error: document.querySelector('[data-profile-error="name"]').textContent, open: document.querySelector('[data-profile-dialog]').open, enabled: !document.querySelector('[data-profile-save]').disabled }));
  state.next.push({ status: 429, body: { error: 'rate_limited' } });
  await page.click('[data-profile-save]');
  await page.waitForFunction(() => /频繁/.test(document.querySelector('[data-profile-error="form"]').textContent));
  const limited = await page.evaluate(() => document.querySelector('[data-profile-error="name"]').hidden);
  state.next.push({ status: 400, body: { error: 'invalid_image' } });
  await page.click('[data-profile-save]');
  await page.waitForFunction(() => !document.querySelector('[data-profile-error="picture"]').hidden);
  report(refused.error === '名字最多 32 个字。' && refused.open && refused.enabled && limited, 'a refusal is said where it belongs (the name, the picture, the form), and the dialog stays open', JSON.stringify(refused));
  state.next.push({ status: 409, body: { error: 'account_changed' } });
  await page.click('[data-profile-save]');
  await page.waitForFunction(() => !document.querySelector('[data-console-changed]').hidden && !document.querySelector('[data-profile-dialog]').open);
  report(!(await page.evaluate(() => document.documentElement.classList.contains('is-locked'))), 'another account signed in meanwhile: the dialog closes, the page starts again with it');

  // on another section, from the side's card; "Saved" said to screen readers there
  await page.goto(`${origin}/zh/console/clients/`);
  await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
  await page.click('.console__id');
  await page.fill('[data-profile-name]', 'Ada Elsewhere');
  await page.click('[data-profile-save]');
  await closed(page);
  const elsewhere = await page.evaluate(() => ({ side: document.querySelector('.console__side .console__name').textContent, status: document.querySelector('[data-profile-saved]').textContent }));
  report(elsewhere.side === 'Ada Elsewhere' && elsewhere.status === '已保存', 'on every section the side’s card opens the profile', JSON.stringify(elsewhere));

  // by day
  if (shots) {
    await page.evaluate(() => localStorage.setItem('sr-theme', 'light'));
    await page.goto(`${origin}/zh/console/`);
    await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
    await page.click('.profile__edit');
    await page.waitForTimeout(500);
    await shoot(page, 'profile-dialog-light', DIALOG);
  }
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await profileMock(context);
  await hint(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}/zh/console/`);
  await page.waitForFunction(() => document.querySelector('[data-console]')?.dataset.state === 'in');
  await shoot(page, 'phone-profile-view', { x: 0, y: 0, width: 390, height: 520 });
  await page.tap('.profile__edit');
  await page.waitForTimeout(500);
  const fits = await page.evaluate(() => {
    const box = document.querySelector('[data-profile-dialog]').getBoundingClientRect();
    return { left: Math.round(box.left), right: Math.round(innerWidth - box.right), top: Math.round(box.top), bottom: Math.round(innerHeight - box.bottom), keyboard: document.activeElement === document.querySelector('[data-profile-name]') };
  });
  report(fits.left >= 13 && fits.right >= 13 && fits.top >= 13 && fits.bottom >= 13 && !fits.keyboard, 'phone: the dialog fits the screen, and the keyboard waits to be asked for', JSON.stringify(fits));
  await shoot(page, 'phone-profile-dialog');
  await context.close();
}

report(errors.length === 0, 'no script errors', errors.join(' | '));
await browser.close();
process.exitCode = failures ? 1 : 0;
