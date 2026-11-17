import { socialSignIn } from './social-sign-in';
import { initTheme } from './theme-switch';
import type { Me } from './account';

const root = document.querySelector<HTMLElement>('[data-authorize]');
if (root) {
  // light, dark or as the system is (client/theme-switch.ts)
  initTheme();
  const zh = root.dataset.lang === 'zh';
  const say = (en: string, cn: string) => zh ? cn : en;
  const el = <T extends HTMLElement = HTMLElement>(key: string) => root.querySelector<T>(`[data-${key}]`)!;
  const title = el('title');
  const status = el('status');
  const error = el('error');
  const link = root.querySelector<HTMLElement>('[data-link]')!;
  const params = new URLSearchParams(location.search);
  const signInError = params.has('sign-in-error');
  // Codeg opens this page with the request ID in the fragment, which the
  // browser never sends to a server.
  const fragment = new URLSearchParams(location.hash.slice(1));
  const STORAGE = 'srn-codeg-authorization';
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  const clearRequest = () => { try { sessionStorage.removeItem(STORAGE); } catch { /* tab storage is optional while this page remains open */ } };
  let saved: { request_id: string; retention_deadline: number } | null = null;
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE) ?? 'null') as { request_id?: unknown; retention_deadline?: unknown } | null;
    if (value && valid(value.request_id) && typeof value.retention_deadline === 'number' && Number.isFinite(value.retention_deadline) && value.retention_deadline > Date.now()) {
      saved = { request_id: value.request_id, retention_deadline: value.retention_deadline };
    } else clearRequest();
  } catch { clearRequest(); }
  let requestId: string | null = null;
  let retentionDeadline = Date.now() + 10 * 60 * 1000;
  if (fragment.has('request_id')) {
    const supplied = fragment.getAll('request_id');
    if (supplied.length === 1 && valid(supplied[0])) {
      requestId = supplied[0];
      if (saved?.request_id === requestId) retentionDeadline = saved.retention_deadline;
    }
    else clearRequest();
  } else if (saved) {
    requestId = saved.request_id;
    retentionDeadline = saved.retention_deadline;
  }
  // Remove request IDs before any fetch, provider handoff or error URL is
  // constructed. Only a short-lived tab-local request reference is retained.
  history.replaceState(history.state, '', location.pathname);
  // A new request opened in this same tab changes only the fragment, which
  // does not reload the page: reload so it is read like a first entry.
  addEventListener('hashchange', () => { if (new URLSearchParams(location.hash.slice(1)).has('request_id')) location.reload(); });
  const rememberRequest = () => {
    if (!requestId || retentionDeadline <= Date.now()) return false;
    // This is local tab retention, fixed at first entry. The API alone decides
    // whether the request has expired; browser and server clocks can differ.
    try { sessionStorage.setItem(STORAGE, JSON.stringify({ request_id: requestId, retention_deadline: retentionDeadline })); return true; }
    catch { return false; }
  };
  if (requestId) {
    rememberRequest();
    // An idle open tab lets go of the reference at its deadline, too.
    setTimeout(clearRequest, Math.max(0, retentionDeadline - Date.now()));
  }
  const validId = !!requestId;
  // The request ID goes in request bodies, never in a URL.
  const post = (step: 'lookup' | 'decision', body: Record<string, unknown>, credentials: RequestCredentials) => fetch(`/api/client/v1/login-requests/${step}`, {
    method: 'POST', credentials, cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_id: requestId, ...body }),
  });
  const back = zh ? '/zh/authorize/' : '/authorize/';
  const language = document.querySelector<HTMLAnchorElement>('[data-lang-switch]');
  // the request's own title, in its phrases, for whenever a request is on show again
  const heading = Array.from(title.childNodes, (node) => node.cloneNode(true));
  let me: Me | null = null;
  let callback: string | null = null;
  let clientOrigin: string | null = null;
  let busy = false;
  let sequence = 0;

  /**
   * Where the request stands: the root's state lays the page out
   * (styles/authorize.css), the line between the marks shows it.
   */
  type Line = 'loading' | 'pending' | 'busy' | 'linked' | 'canceled' | 'broken' | 'idle';
  // An error belongs with the decision while a request is on show, and under
  // the outcome's lede otherwise (a decision whose answer was lost, then
  // found already decided): never in a panel that is not shown.
  const decision = error.parentElement!;
  const next = root.querySelector<HTMLElement>('.authz__next')!;
  const show = (state: 'loading' | 'pending' | 'notice' | 'done', line: Line) => {
    root.dataset.state = state;
    link.dataset.link = line;
    if (state === 'notice' || state === 'done') { if (error.nextElementSibling !== next) next.before(error); }
    else if (error.parentElement !== decision) decision.prepend(error);
  };
  /**
   * The lede, in its sentences and clauses, each kept whole where it fits
   * (styles/authorize.css): a line breaks between them rather than inside a
   * word, which Chinese would do anywhere.
   */
  const tell = (text: string) => {
    const parts = text.split(/(?<=[。，；])|(?<=[.;]) /);
    status.replaceChildren(...parts.flatMap((part, i) => {
      const span = document.createElement('span');
      span.textContent = part;
      return i && !zh ? [' ', span] : [span];
    }));
  };
  /** An outcome other than a pending request: one centred column, its title and what to do next. */
  const NOTICES = {
    invalid: { line: 'broken', title: say('This link can’t be used', '这个链接无法使用'), text: say('Invalid request. Start again from Codeg.', '授权请求无效，请从 Codeg 重新发起。') },
    expired: { line: 'broken', title: say('This request is no longer valid', '授权请求已失效'), text: say('It expired or is unavailable. Start again from Codeg.', '请求已过期或不可用，请从 Codeg 重新发起。') },
    decided: { line: 'idle', title: say('Nothing left to confirm', '此请求已处理'), text: say('This request was already decided. To connect again, start from Codeg.', '此请求已完成决定。如需重新连接，请从 Codeg 发起。') },
    limited: { line: 'idle', title: say('Too many attempts', '操作过于频繁'), text: say('Wait a moment, then refresh. Your request is kept.', '请稍候再刷新，授权请求仍会保留。'), retry: true },
    unavailable: { line: 'idle', title: say('SRN is temporarily unavailable', 'SRN 服务暂时不可用'), text: say('The request could not be checked yet. Refresh to try again.', '暂时无法检查授权请求，请刷新重试。'), retry: true },
    offline: { line: 'idle', title: say('Couldn’t load the request', '无法加载授权请求'), text: say('Check your connection, then refresh.', '请检查网络后刷新。'), retry: true },
  } satisfies Record<string, { line: Line; title: string; text: string; retry?: boolean }>;
  const notice = (kind: keyof typeof NOTICES) => {
    const n: { line: Line; title: string; text: string; retry?: boolean } = NOTICES[kind];
    title.textContent = n.title;
    tell(n.text);
    el('reload').hidden = !n.retry;
    show('notice', n.line);
  };
  const fail = (message: string) => { error.textContent = message; error.hidden = false; };
  const ACTIONS = '[data-provider], [data-approve], [data-deny], [data-switch]';
  const disable = (value: boolean) => root.querySelectorAll<HTMLButtonElement>(ACTIONS).forEach(b => { b.disabled = value; });
  /** The pressed button says what it is doing (its data-busy) until the page is done with it. */
  const pressing = (button: HTMLButtonElement | null, on: boolean) => {
    const label = button?.querySelector('span');
    if (!button || !label) return;
    if (on) { button.dataset.label = label.textContent ?? ''; label.textContent = button.dataset.busy ?? ''; button.setAttribute('aria-busy', 'true'); }
    else if (button.dataset.label !== undefined) { label.textContent = button.dataset.label; delete button.dataset.label; button.removeAttribute('aria-busy'); }
  };

  /** After something the person did hid the control they were on, their place is the title. */
  const refocus = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || !active.getClientRects().length) title.focus({ preventScroll: true });
  };

  const load = async () => {
    const asked = ++sequence;
    error.hidden = true;
    el('reload').hidden = true;
    title.replaceChildren(...heading.map((node) => node.cloneNode(true)));
    // Read again while the request is on show (another account, a decision
    // that did not go through): it stays, quietly, until the answer is in.
    if (root.dataset.state === 'pending') link.dataset.link = 'loading';
    else {
      tell(say('Loading the request…', '正在读取授权请求…'));
      show('loading', 'loading');
    }
    if (!validId) { notice('invalid'); return; }
    try {
      const res = await post('lookup', {}, 'omit');
      const data = await res.json();
      if (asked !== sequence) return;
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) { notice(res.status === 429 ? 'limited' : 'unavailable'); return; }
        clearRequest();
        notice('expired'); return;
      }
      if (data.status !== 'pending') { clearRequest(); notice('decided'); return; }
      if (!Number.isFinite(Date.parse(data.expires_at))) throw new Error('invalid_response');
      clientOrigin = data.client.type === 'web' ? data.client.origin : null;
      el('web-note').hidden = !clientOrigin;
      el('client').dataset.kind = clientOrigin ? 'web' : 'desktop';
      el('client-name').textContent = clientOrigin ? `${data.client.name} Web` : say(`${data.client.name} desktop app`, `${data.client.name} 桌面端`);
      el('client-where').textContent = clientOrigin ?? say('On this computer', '在这台电脑上');
      const expiry = el('expiry');
      const expires = new Date(data.expires_at);
      expiry.textContent = expires.toLocaleTimeString(zh ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' });
      expiry.setAttribute('datetime', expires.toISOString());
      expiry.title = expires.toLocaleString(zh ? 'zh-CN' : 'en');
      const account = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!account.ok && account.status !== 401) throw new Error('unavailable');
      const user = account.ok ? (await account.json()).user as Me : null;
      if (asked !== sequence) return;
      me = user;
      el('signed-in').hidden = !me;
      el('signed-out').hidden = !!me;
      if (me) {
        el('name').textContent = me.name;
        el('name').title = me.name;
        el('srn').textContent = `SRN ${me.number}`;
        el('initial').textContent = (Array.from(me.name.trim())[0] ?? '').toUpperCase();
        const image = el<HTMLImageElement>('avatar');
        image.hidden = !me.image?.startsWith('/api/avatars/');
        if (!image.hidden && me.image) image.src = me.image;
      }
      tell(clientOrigin
        ? say('A Codeg Web service is asking to read your SRN profile. Nothing is shared until you approve.', '一个 Codeg Web 服务请求读取你的 SRN 资料。在你确认之前，不会共享任何信息。')
        : say('Codeg is asking to read your SRN profile. Nothing is shared until you approve.', 'Codeg 请求读取你的 SRN 资料。在你确认之前，不会共享任何信息。'));
      show('pending', 'pending');
    } catch {
      if (asked !== sequence) return;
      notice('offline');
    }
  };
  const decide = async (decision: 'approve' | 'deny') => {
    if (busy || !me || !validId) return;
    const button = el<HTMLButtonElement>(decision === 'approve' ? 'approve' : 'deny');
    busy = true; disable(true); error.hidden = true;
    pressing(button, true);
    if (decision === 'approve') link.dataset.link = 'busy';
    try {
      const res = await post('decision', { decision, expected_srn: me.number }, 'same-origin');
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'account_changed' || data.error === 'signed_out') {
          await load();
          fail(say('The signed-in account changed. Check it and confirm again.', '登录账号已变化，请重新核对并确认。'));
        } else { await load(); fail(say('Unable to confirm. Review the current status before retrying.', '未能确认，请先检查当前状态再重试。')); }
        return;
      }
      const url = new URL(data.callback_url);
      // Web: the instance's registered HTTPS address. Desktop: the loopback
      // port Codeg is listening on for this sign-in.
      const port = Number(url.port);
      const safe = clientOrigin ? url.protocol === 'https:' && url.origin === clientOrigin && url.pathname === '/auth/srn/callback'
        : url.protocol === 'http:' && url.hostname === '127.0.0.1' && port >= 1024 && port <= 65535 && url.pathname === '/auth/callback';
      if (!safe || url.username || url.password || url.hash) throw new Error('callback');
      callback = url.href;
      clearRequest();
      const open = el<HTMLAnchorElement>('open');
      open.href = callback;
      open.hidden = false;
      open.querySelector('span')!.textContent = clientOrigin ? say('Return to Codeg Web', '返回 Codeg Web') : say('Return to Codeg', '返回 Codeg');
      if (decision === 'approve') {
        title.textContent = say('Codeg is authorized', '已授权 Codeg');
        tell(say('Returning to Codeg. Codeg will confirm the connection.', '正在返回 Codeg，连接结果以 Codeg 内显示为准。'));
        show('done', 'linked');
      } else {
        title.textContent = say('Connection canceled', '已取消连接');
        tell(say('Codeg was not connected. Returning to Codeg.', 'Codeg 没有连接到你的账号，正在返回 Codeg。'));
        show('done', 'canceled');
      }
      refocus();
      location.assign(callback);
    } catch {
      await load();
      fail(say('The result is uncertain. If already authorized, start again from Codeg.', '暂时无法确认结果。如果已授权，请从 Codeg 重新发起。'));
    } finally { busy = false; disable(false); pressing(button, false); refocus(); }
  };
  el('approve').addEventListener('click', () => void decide('approve'));
  el('deny').addEventListener('click', () => void decide('deny'));
  el('reload').addEventListener('click', () => void load().then(refocus));
  root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => button.addEventListener('click', async () => {
    if (busy || !validId) return;
    if (!rememberRequest()) { fail(say('Allow tab storage to finish sign-in, then start again from Codeg.', '请允许此网页使用标签页存储，再从 Codeg 重新发起登录。')); return; }
    busy = true; disable(true); error.hidden = true;
    pressing(button, true);
    if (!(await socialSignIn(button.dataset.provider!, back, `${back}?sign-in-error=1`))) {
      fail(say('Sign-in could not start. Try again.', '暂时无法发起登录，请重试。')); busy = false; disable(false); pressing(button, false);
    }
  }));
  language?.addEventListener('click', event => {
    if (!validId) return;
    if (!rememberRequest()) { event.preventDefault(); fail(say('Language switching requires tab storage. Continue on this page or start again from Codeg.', '切换语言需要标签页存储。请在当前页面继续，或从 Codeg 重新发起。')); }
  });
  el('switch').addEventListener('click', async () => {
    if (busy) return;
    busy = true; disable(true);
    try {
      const res = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error('signout');
      await load();
    } catch { fail(say('Unable to switch accounts. Try again.', '未能退出当前账号，请重试。')); }
    finally { busy = false; disable(false); refocus(); }
  });
  void load().then(() => { if (signInError) fail(say('Sign-in was not completed. Try again.', '登录未完成，请重试。')); });
}
