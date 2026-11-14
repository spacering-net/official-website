import { socialSignIn } from './social-sign-in';
import type { Me } from './account';

const root = document.querySelector<HTMLElement>('[data-authorize]');
if (root) {
  const zh = root.dataset.lang === 'zh';
  const say = (en: string, cn: string) => zh ? cn : en;
  const el = <T extends HTMLElement = HTMLElement>(key: string) => root.querySelector<T>(`[data-${key}]`)!;
  const status = el('status');
  const error = el('error');
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
  const language = el<HTMLAnchorElement>('language');
  let me: Me | null = null;
  let callback: string | null = null;
  let clientOrigin: string | null = null;
  let busy = false;
  let sequence = 0;
  const fail = (message: string) => { error.textContent = message; error.hidden = false; };
  const disable = (value: boolean) => root.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = value; });
  const load = async () => {
    const asked = ++sequence;
    error.hidden = true;
    el('request').hidden = true;
    el('reload').hidden = true;
    status.textContent = say('Loading request…', '正在读取授权请求…');
    if (!validId) { status.textContent = say('Invalid request. Start again from Codeg.', '授权请求无效，请从 Codeg 重新发起。'); return; }
    try {
      const res = await post('lookup', {}, 'omit');
      const data = await res.json();
      if (asked !== sequence) return;
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          status.textContent = say('The request could not be checked yet.', '暂时无法检查授权请求。');
          fail(res.status === 429 ? say('Too many requests. Wait a moment, then refresh.', '请求过于频繁，请稍后刷新状态。') : say('The service is temporarily unavailable. Refresh to retry.', '服务暂时不可用，请刷新状态重试。'));
          el('reload').hidden = false;
          return;
        }
        clearRequest();
        status.textContent = say('This request is expired or unavailable. Start again from Codeg.', '请求已过期或不可用，请从 Codeg 重新发起。'); return;
      }
      if (data.status !== 'pending') { clearRequest(); status.textContent = say('This request was already decided. Start a new connection from Codeg if needed.', '此请求已完成决定。需要重试时，请从 Codeg 重新发起。'); return; }
      if (!Number.isFinite(Date.parse(data.expires_at))) throw new Error('invalid_response');
      clientOrigin = data.client.type === 'web' ? data.client.origin : null;
      el('web-note').hidden = !clientOrigin;
      el('client').textContent = clientOrigin ? `${data.client.name} Web · ${clientOrigin}` : `${data.client.name} ${say('desktop', '桌面端')}`;
      el('expiry').textContent = `${say('Request expires: ', '请求到期时间：')}${new Date(data.expires_at).toLocaleString(zh ? 'zh-CN' : 'en')}`;
      const account = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!account.ok && account.status !== 401) throw new Error('unavailable');
      const user = account.ok ? (await account.json()).user as Me : null;
      if (asked !== sequence) return;
      me = user;
      el('signed-in').hidden = !me;
      el('signed-out').hidden = !!me;
      if (me) {
        el('name').textContent = me.name;
        el('srn').textContent = `SRN ${me.number}`;
        const image = el<HTMLImageElement>('avatar');
        image.hidden = !me.image?.startsWith('/api/avatars/');
        if (!image.hidden && me.image) image.src = me.image;
      }
      status.textContent = me ? say('Confirm this account before connecting.', '请确认以下账号后授权。') : say('Sign in to authorize Codeg.', '登录 SRN 后授权 Codeg。');
      el('request').hidden = false;
    } catch {
      if (asked !== sequence) return;
      fail(say('Unable to load. Check your connection and refresh.', '加载失败，请检查网络后刷新状态。'));
      el('reload').hidden = false;
    }
  };
  const decide = async (decision: 'approve' | 'deny') => {
    if (busy || !me || !validId) return;
    busy = true; disable(true); error.hidden = true;
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
      el('request').hidden = true;
      const open = el<HTMLAnchorElement>('open');
      open.href = callback;
      open.hidden = false;
      open.textContent = clientOrigin ? say('Return to Codeg Web', '返回 Codeg Web') : say('Return to Codeg', '返回 Codeg');
      status.textContent = decision === 'approve'
        ? say('Authorized. Returning to Codeg; Codeg will confirm the connection.', '已授权，正在返回 Codeg；连接结果请以 Codeg 内显示为准。')
        : say('Connection canceled. Returning to Codeg.', '已取消连接，正在返回 Codeg。');
      location.assign(callback);
    } catch {
      await load();
      fail(say('The result is uncertain. If already authorized, start again from Codeg.', '暂时无法确认结果。如果已授权，请从 Codeg 重新发起。'));
    } finally { busy = false; disable(false); }
  };
  el('approve').addEventListener('click', () => void decide('approve'));
  el('deny').addEventListener('click', () => void decide('deny'));
  el('reload').addEventListener('click', () => void load());
  root.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => button.addEventListener('click', async () => {
    if (busy || !validId) return;
    if (!rememberRequest()) { fail(say('Allow tab storage to finish sign-in, then start again from Codeg.', '请允许此网页使用标签页存储，再从 Codeg 重新发起登录。')); return; }
    busy = true; disable(true);
    if (!(await socialSignIn(button.dataset.provider!, back, `${back}?sign-in-error=1`))) {
      fail(say('Sign-in could not start. Try again.', '暂时无法发起登录，请重试。')); busy = false; disable(false);
    }
  }));
  language.addEventListener('click', event => {
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
    finally { busy = false; disable(false); }
  });
  void load().then(() => { if (signInError) fail(say('Sign-in was not completed. Try again.', '登录未完成，请重试。')); });
}
