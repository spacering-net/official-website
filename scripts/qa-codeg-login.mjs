// Run after pnpm build, against `wrangler dev --config dist/server/wrangler.json`.
// API replies are synthetic: this never signs in or reaches a Codeg loopback listener.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.CODEG_LOGIN_QA_URL ?? 'http://localhost:8911';
// A fresh build must not give the assets service any authorization HTML that
// could be returned by a path alias bypassing Worker-first path matching.
await assert.rejects(access(new URL('../dist/client/authorize/', import.meta.url)));
await assert.rejects(access(new URL('../dist/client/zh/authorize/', import.meta.url)));
const protect = (res, label) => {
  assert.equal(res.headers.get('cache-control'), 'no-store', label);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', label);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
  assert.ok(res.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), label);
};
for (const path of ['/authorize', '/authorize/', '/authorize/index.html', '/authorize.html', '/zh/authorize', '/zh/authorize/', '/zh/authorize/index.html', '/zh/authorize.html']) {
  const res = await fetch(`${origin}${path}`, { redirect: 'manual' });
  assert.equal(res.status, 200, path);
  protect(res, path);
  assert.ok((await res.text()).includes('data-authorize'), path);
}
const aliases = [
  ...['', '/zh'].flatMap(prefix => ['/index', '/index/', '//', '///', '//index', '/./index', '/x/../index', '.html/'].map(suffix => `${prefix}/authorize${suffix}`)),
  '/%61uthorize', '/%61uthorize/', '/%61uthorize/index', '/%2561uthorize/index',
  '/authorize%2findex', '/authorize%252findex', '/%2fauthorize//', '/%61%75%74%68%6f%72%69%7a%65',
  '/authorize%2ehtml', '/authorize%5cindex', '/%7ah/authorize', '/zh/%61uthorize/index',
  '/%257a%2568%252fauthorize//', '//authorize/index', '/zh//authorize/index/',
];
for (const path of aliases) {
  for (const headers of [{ accept: '*/*' }, { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }]) {
    const res = await fetch(`${origin}${path}`, { headers, redirect: 'follow' });
    assert.equal(new URL(res.url).origin, new URL(origin).origin, path);
    const body = await res.text();
    if (res.status === 200) {
      assert.ok(body.includes('data-authorize'), `${path} must serve protected authorization or reject`);
      protect(res, path);
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `${path}: ${res.status}`);
      assert.ok(!body.includes('data-authorize'), `${path} must not include authorization HTML in a rejection`);
    }
  }
}
const browser = await chromium.launch({ channel: process.env.CODEG_LOGIN_QA_BROWSER ?? 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  let srn = 10000;
  let decisions = 0;
  let detailStatus = 200;
  let requestStatus = 'pending';
  let signedIn = true;
  let lookupClient = { name: 'Codeg', type: 'desktop', origin: null };
  let providerBody;
  let revokeAttempts = 0;
  let revoked = false;
  await page.route('**/api/client/v1/login-requests/**', route => {
    // The request ID travels only in request bodies.
    assert.equal(route.request().method(), 'POST');
    assert.match(route.request().postDataJSON().request_id, /^[A-Za-z0-9_-]{43}$/);
    if (new URL(route.request().url()).pathname.endsWith('/decision')) {
      decisions++;
      assert.equal(route.request().postDataJSON().expected_srn, 10000);
      srn = 10001;
      return route.fulfill({ status: 409, json: { error: 'account_changed' } });
    }
    if (detailStatus !== 200) return route.fulfill({ status: detailStatus, json: { error: detailStatus === 429 ? 'rate_limited' : 'server_error' } });
    return route.fulfill({ json: { status: requestStatus, scope: 'profile:read', expires_at: new Date(Date.now() + 590000).toISOString(), client: lookupClient } });
  });
  await page.route('**/api/me', route => route.fulfill({ status: signedIn ? 200 : 401, json: { user: signedIn ? { number: srn, name: srn === 10000 ? 'Ada' : 'Grace', image: null } : null } }));
  // the console asks who is signed in for itself (client/console.ts)
  await page.route('**/api/me/account', route => route.fulfill(signedIn
    ? { json: { account_srn: srn, user: { number: srn, name: srn === 10000 ? 'Ada' : 'Grace', image: null, email: `${srn}@example.com`, since: '2026-10-07T00:00:00.000Z' }, providers: [], sessions: 1, clients: 1, last_sign_in: null } }
    : { status: 401, json: { error: 'signed_out' } }));
  await page.route('**/api/auth/sign-in/social', route => { providerBody = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { error: 'unavailable' } }); });
  await page.route('**/api/me/clients**', route => {
    if (route.request().method() === 'DELETE') {
      revokeAttempts++;
      if (route.request().postDataJSON().expected_srn !== srn) return route.fulfill({ status: 409, json: { error: 'account_changed' } });
      revoked = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { account_srn: srn, next_cursor: null, clients: [{ id: '01900000-0000-7000-8000-000000000001', client_name: 'Codeg', client_type: 'desktop', platform: 'web', device_name: `${srn} device`, created_at: new Date(Date.now() - 86400000).toISOString(), last_used_at: new Date().toISOString(), expires_at: new Date(Date.now() + 100000).toISOString(), revoked_at: revoked ? new Date().toISOString() : null, status: revoked ? 'revoked' : 'disabled', client_origin: null }] } });
  });
  // Codeg opens a new page; a fragment-only change to an open page would not
  // reload it, so each fresh entry starts from a blank page.
  const enter = async (target, path) => { await target.goto('about:blank'); await target.goto(`${origin}${path}`); };
  const clean = target => { const url = new URL(target.url()); return url.search === '' && url.hash === ''; };
  const query = `#request_id=${'a'.repeat(43)}`;
  await enter(page, `/authorize/${query}`);
  await page.locator('[data-approve]').waitFor({ state: 'visible' });
  assert.ok(clean(page), 'Request ID must immediately leave the address bar');
  assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('srn-codeg-authorization'))).sort()), ['request_id', 'retention_deadline']);
  assert.equal(decisions, 0, 'An existing website account must not grant automatically');
  // A request on show has nothing under its title; a desktop request names no server.
  assert.equal(await page.locator('[data-status]').textContent(), '');
  assert.equal(await page.locator('[data-origin]').isVisible(), false);
  // The terms are under the decision, and open beside it rather than in its place.
  for (const path of ['/terms/', '/privacy/']) {
    const terms = page.locator(`.authz__legal a[href="${path}"]`);
    assert.equal(await terms.isVisible(), true, path);
    assert.equal(await terms.getAttribute('target'), '_blank', path);
    assert.match(await terms.getAttribute('rel'), /noopener/, path);
    assert.equal(await page.locator(`.authz__foot a[href="${path}"]`).getAttribute('target'), '_blank', path);
  }
  await page.locator('[data-approve]').click();
  await page.getByText('SRN 10001', { exact: true }).waitFor();
  assert.ok((await page.locator('[data-error]').textContent()).includes('account changed'));
  assert.equal(decisions, 1);
  await page.reload();
  await page.locator('[data-approve]').waitFor({ state: 'visible' });
  await page.locator('[data-lang-switch]').click();
  await page.locator('[data-approve]').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/zh/authorize/');
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await page.locator('h1').textContent(), '使用 SRN 账号登录');
  // A new request in the same tab changes only the fragment: the page reloads to read it.
  await page.evaluate(() => { location.hash = `request_id=${'d'.repeat(43)}`; });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('srn-codeg-authorization') ?? 'null')?.request_id === 'd'.repeat(43));
  await page.locator('[data-approve]').waitFor({ state: 'visible' });
  assert.ok(clean(page));
  signedIn = false;
  await enter(page, `/authorize/${query}`);
  await page.locator('[data-provider="github"]').click();
  await page.locator('[data-error]').waitFor({ state: 'visible' });
  assert.equal(providerBody.callbackURL, '/authorize/');
  assert.equal(providerBody.errorCallbackURL, '/authorize/?sign-in-error=1');
  assert.ok(!JSON.stringify(providerBody).includes('request_id'));
  await page.goto(`${origin}/authorize/?sign-in-error=1`);
  await page.locator('[data-provider="github"]').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).search, '');
  signedIn = true;
  for (const code of [429, 503]) {
    detailStatus = code;
    await page.reload();
    await page.locator('[data-reload]').waitFor({ state: 'visible' });
    assert.ok(!(await page.locator('[data-status]').textContent()).includes('expired'));
    assert.ok(await page.evaluate(() => !!sessionStorage.getItem('srn-codeg-authorization')));
    detailStatus = 200;
    await page.locator('[data-reload]').click();
    await page.locator('[data-approve]').waitFor({ state: 'visible' });
  }
  for (const lang of ['', 'zh/']) {
    await page.setViewportSize({ width: 375, height: 812 });
    await enter(page, `/${lang}authorize/${query}`);
    await page.locator('[data-approve]').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile page must not overflow');
    assert.equal(await page.locator('[data-status]').textContent(), '');
    assert.equal(await page.locator('[data-approve]').evaluate(button => button.getBoundingClientRect().bottom <= innerHeight), true, 'The decision is in view on a phone');
    assert.equal(await page.locator('[data-origin]').isVisible(), false);
  }
  // A Codeg Web's address is shown whole even when it is long, on the
  // narrowest phone, and the page still fits.
  const host = 'codeg-workspace-production.engineering.internal.example-company-name.com';
  lookupClient = { name: 'Codeg', type: 'web', origin: `https://${host}` };
  await page.setViewportSize({ width: 320, height: 640 });
  for (const lang of ['', 'zh/']) {
    await enter(page, `/${lang}authorize/${query}`);
    await page.locator('[data-approve]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-origin]').isVisible(), true);
    assert.equal(await page.locator('[data-origin-host]').textContent(), host);
    assert.equal(await page.locator('[data-origin-host]').getAttribute('title'), `https://${host}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'A long Web address must not overflow');
  }
  // Anything but HTTPS on the standard port is shown exactly as sent.
  lookupClient = { name: 'Codeg', type: 'web', origin: 'https://codeg.example.com:8443' };
  await enter(page, `/authorize/${query}`);
  await page.locator('[data-approve]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-origin-host]').textContent(), 'https://codeg.example.com:8443');
  lookupClient = { name: 'Codeg', type: 'desktop', origin: null };
  await page.setViewportSize({ width: 375, height: 812 });
  requestStatus = 'consumed';
  await page.reload();
  await page.getByText(/already decided|已完成决定/).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('srn-codeg-authorization')), null);
  requestStatus = 'pending';
  await enter(page, '/authorize/#request_id=invalid');
  assert.equal(await page.locator('[data-approve]').isVisible(), false);
  assert.ok((await page.locator('[data-status]').textContent()).includes('Invalid request'));
  // A decision that goes through: the page follows the client's callback, and
  // offers it as a link; one that names any other address is not followed.
  // The page also follows the site's theme.
  for (const [client, decision, callbackUrl, followed] of [
    [{ name: 'Codeg', type: 'desktop', origin: null }, 'approve', `http://127.0.0.1:53682/auth/callback?code=${'c'.repeat(43)}&state=${'s'.repeat(43)}`, true],
    [{ name: 'Codeg', type: 'desktop', origin: null }, 'deny', `http://127.0.0.1:53682/auth/callback?error=access_denied&state=${'s'.repeat(43)}`, true],
    [{ name: 'Codeg', type: 'web', origin: 'https://codeg.example.com' }, 'approve', `https://codeg.example.com/auth/srn/callback?code=${'c'.repeat(43)}&state=${'s'.repeat(43)}`, true],
    [{ name: 'Codeg', type: 'web', origin: 'https://codeg.example.com' }, 'approve', `https://elsewhere.example.com/auth/srn/callback?code=${'c'.repeat(43)}&state=${'s'.repeat(43)}`, false],
  ]) {
    const context = await browser.newContext();
    // (about:blank, where each entry starts, has no storage)
    await context.addInitScript(() => { try { localStorage.setItem('sr-theme', 'light'); } catch { /* not this document */ } });
    const tab = await context.newPage();
    tab.on('pageerror', err => errors.push(err.message));
    const visited = [];
    await tab.route('**/api/client/v1/login-requests/lookup', route => route.fulfill({ json: { status: 'pending', scope: 'profile:read', expires_at: new Date(Date.now() + 590000).toISOString(), client } }));
    await tab.route('**/api/client/v1/login-requests/decision', async route => {
      assert.equal((await route.request().allHeaders()).origin, origin, 'Decisions carry the exact SRN Origin');
      assert.equal(route.request().postDataJSON().decision, decision);
      return route.fulfill({ json: { callback_url: callbackUrl } });
    });
    await tab.route('**/api/me', route => route.fulfill({ json: { user: { number: 10000, name: 'Ada', image: null } } }));
    // a 204 leaves the page where it is, so what it shows can be checked
    for (const host of ['http://127.0.0.1:53682/**', 'https://codeg.example.com/**', 'https://elsewhere.example.com/**']) {
      await tab.route(host, route => { visited.push(route.request().url()); return route.fulfill({ status: 204 }); });
    }
    await enter(tab, `/authorize/${query}`);
    assert.equal(await tab.evaluate(() => document.documentElement.dataset.theme), 'light');
    // A Codeg Web says so, and where it is asking from.
    await tab.locator(`[data-${decision}]`).waitFor({ state: 'visible' });
    if (client.origin) {
      assert.equal(await tab.locator('[data-origin]').isVisible(), true);
      assert.equal(await tab.locator('[data-origin-host]').textContent(), 'codeg.example.com');
      assert.equal(await tab.locator('[data-origin-host]').getAttribute('title'), client.origin);
      assert.match(await tab.locator('[data-origin]').textContent(), /^\s*From codeg\.example\.com\s*$/);
    } else assert.equal(await tab.locator('[data-origin]').isVisible(), false);
    await tab.locator(`[data-${decision}]`).click();
    if (followed) {
      await tab.waitForFunction(() => document.querySelector('[data-authorize]')?.dataset.state === 'done');
      await tab.waitForFunction(() => !document.querySelector('[data-open]')?.hidden);
      assert.equal(await tab.locator('[data-open]').getAttribute('href'), callbackUrl);
      assert.equal(await tab.locator('h1').count(), 1);
      assert.equal(await tab.evaluate(() => sessionStorage.getItem('srn-codeg-authorization')), null);
      for (let i = 0; i < 100 && !visited.length; i++) await tab.waitForTimeout(20);
      assert.deepEqual(visited, [callbackUrl]);
    } else {
      await tab.locator('[data-error]').waitFor({ state: 'visible' });
      assert.equal(await tab.locator('[data-open]').isVisible(), false);
      assert.deepEqual(visited, []);
    }
    await context.close();
  }
  // A decision whose answer is lost or refused, after which the request is no
  // longer pending or SRN cannot be reached: the page shows where the
  // request stands, and the warning stays in view with it.
  for (const [reply, after, standing, warning, retry] of [
    ['abort', { json: { status: 'authorized', scope: 'profile:read', expires_at: new Date(Date.now() + 590000).toISOString(), client: { name: 'Codeg', type: 'desktop', origin: null } } }, /already decided/, /uncertain/, false],
    [{ status: 500, json: { error: 'server_error' } }, { status: 503, json: { error: 'server_error' } }, /could not be checked/, /Unable to confirm/, true],
  ]) {
    const context = await browser.newContext();
    const tab = await context.newPage();
    tab.on('pageerror', err => errors.push(err.message));
    let decided = false;
    await tab.route('**/api/client/v1/login-requests/lookup', route => route.fulfill(decided ? after : { json: { status: 'pending', scope: 'profile:read', expires_at: new Date(Date.now() + 590000).toISOString(), client: { name: 'Codeg', type: 'desktop', origin: null } } }));
    await tab.route('**/api/client/v1/login-requests/decision', route => { decided = true; return reply === 'abort' ? route.abort() : route.fulfill(reply); });
    await tab.route('**/api/me', route => route.fulfill({ json: { user: { number: 10000, name: 'Ada', image: null } } }));
    await enter(tab, `/authorize/${query}`);
    await tab.locator('[data-approve]').click();
    await tab.locator('[data-error]').filter({ hasText: warning }).waitFor({ state: 'visible' });
    assert.match(await tab.locator('[data-status]').textContent(), standing);
    assert.equal(await tab.locator('[data-approve]').isVisible(), false);
    assert.equal(await tab.locator('[data-reload]').isVisible(), retry);
    await context.close();
  }
  // A cookie-only website session must be recognized when the account dialog
  // opens, even if authorization never wrote a homepage localStorage hint.
  srn = 10000;
  await page.evaluate(() => localStorage.removeItem('sr-account'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/assistant/`);
  await page.locator('[data-account-open]').first().click();
  await page.locator('[data-account-view="in"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-account-number]').textContent(), '10000');
  // Connections are managed in the console. Each answer names its account;
  // the console starts again with the account signed in now.
  srn = 10001; // Another tab changed the browser's authoritative cookie.
  await page.goto(`${origin}/console/clients/`);
  const side = page.locator('.console__side [data-account-number]');
  await page.locator('[data-list="clients"] .row').first().waitFor({ state: 'visible' });
  assert.equal(await side.textContent(), '10001');
  assert.equal(await page.locator('[data-console-changed]').isVisible(), true, 'The console says the account changed since this browser last showed it');
  assert.equal(revokeAttempts, 0);
  const revoke = page.getByRole('button', { name: 'Disconnect', exact: true });
  await revoke.waitFor({ state: 'visible' });
  assert.equal(await revoke.isEnabled(), true, 'Registration disabling must not prevent explicit revocation');
  srn = 10000; // The cookie changes after the list was displayed.
  await revoke.click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.console__side [data-account-number]')?.textContent === '10000');
  assert.equal(revoked, false, 'Mismatched expected_srn must not revoke the current cookie account');
  assert.equal(revokeAttempts, 1);
  await revoke.waitFor({ state: 'visible' });
  await revoke.click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.locator('[data-list="clients"] .status', { hasText: 'Disconnected' }).waitFor();
  assert.equal(revoked, true);
  assert.equal(await revoke.count(), 0, 'A disconnected connection offers nothing more to do');
  // Cloud expiry belongs to the server. A browser clock on either side of
  // it must not invalidate the tab reference or extend its local retention.
  for (const clockOffset of [-120000, 120000, 1200000]) {
    const skewContext = await browser.newContext();
    await skewContext.addInitScript(offset => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + offset;
    }, clockOffset);
    const skewPage = await skewContext.newPage();
    skewPage.on('pageerror', err => errors.push(err.message));
    let expired = false;
    let completed = false;
    await skewPage.route('**/api/client/v1/login-requests/lookup', route => expired
      ? route.fulfill({ status: 410, json: { error: 'request_expired' } })
      : route.fulfill({ json: { status: completed ? 'consumed' : 'pending', scope: 'profile:read', expires_at: new Date(Date.now() + 590000).toISOString(), client: { name: 'Codeg', type: 'desktop', origin: null } } }));
    await skewPage.route('**/api/me', route => route.fulfill({ status: 401, json: { user: null } }));
    let skewProviderBody;
    await skewPage.route('**/api/auth/sign-in/social', route => {
      skewProviderBody = route.request().postDataJSON();
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    });
    const provider = skewPage.locator('[data-provider="github"]');
    const reference = () => skewPage.evaluate(() => JSON.parse(sessionStorage.getItem('srn-codeg-authorization')));
    await enter(skewPage, `/authorize/#request_id=${'b'.repeat(43)}`);
    await provider.waitFor({ state: 'visible' });
    const first = await reference();
    assert.deepEqual(Object.keys(first).sort(), ['request_id', 'retention_deadline']);
    assert.ok(clean(skewPage));
    await skewPage.reload();
    await provider.waitFor({ state: 'visible' });
    assert.deepEqual(await reference(), first);
    await skewPage.locator('[data-lang-switch]').click();
    await provider.waitFor({ state: 'visible' });
    assert.deepEqual(await reference(), first);
    await provider.click();
    await skewPage.locator('[data-error]').waitFor({ state: 'visible' });
    assert.equal(skewProviderBody.callbackURL, '/zh/authorize/');
    assert.ok(!JSON.stringify(skewProviderBody).includes('request_id'));
    for (const returnPath of ['/zh/authorize/?sign-in-error=1', '/zh/authorize/']) {
      await skewPage.goto(`${origin}${returnPath}`);
      await provider.waitFor({ state: 'visible' });
      assert.deepEqual(await reference(), first);
    }
    // Reopening the same request also retains the original deadline.
    await enter(skewPage, `/authorize/#request_id=${'b'.repeat(43)}`);
    await provider.waitFor({ state: 'visible' });
    assert.deepEqual(await reference(), first);
    expired = true;
    await skewPage.reload();
    await skewPage.locator('[data-status]').filter({ hasText: /expired|过期/ }).waitFor();
    assert.equal(await reference(), null);
    expired = false;
    await enter(skewPage, `/authorize/#request_id=${'c'.repeat(43)}`);
    await provider.waitFor({ state: 'visible' });
    completed = true;
    await skewPage.reload();
    await skewPage.locator('[data-status]').filter({ hasText: /already decided|已完成决定/ }).waitFor();
    assert.equal(await reference(), null);
    await skewContext.close();
  }
  assert.deepEqual(errors, []);
  console.info(`SRN login QA passed: 8 canonical routes and ${aliases.length} encoded/slash/index aliases in ordinary/navigation requests; no authorization HTML assets; request IDs only in the fragment and request bodies (same-tab fragment changes reload); explicit consent with a Web request's whole address, account changes, decisions followed only to the client's own callback (approve, deny, Web) and offered as a link, warnings kept in view after a lost or refused decision, the site's theme, fixed local tab retention with clock offsets -2/+2/+20 minutes, no provider request IDs, retries/cleanup, EN/ZH mobile layout and connection revocation protections.`);
} finally { await browser.close(); }
