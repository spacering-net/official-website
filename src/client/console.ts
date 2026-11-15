import { account, scroll } from './page';
import { backTo, ownImage, type Me } from './account';
import { initCardView } from './card';
import { socialSignIn } from './social-sign-in';
import { consoleDicts, type ConsoleSection } from '../i18n/console';
import { AVATAR_SIDE, cleanName, NAME_MAX, nameLength, nameProblem } from '../lib/profile';

/** GET /api/me/account */
interface AccountData {
  account_srn: number;
  user: { number: number; name: string; image: string | null; email: string; since: string };
  providers: { provider: string; linked_at: string }[];
  sessions: number;
  clients: number;
  last_sign_in: { at: string; user_agent: string | null; provider: string | null } | null;
}

/** GET /api/me/clients */
interface Client {
  id: string;
  client_name: string;
  client_type: 'desktop' | 'web';
  client_origin: string | null;
  device_name: string | null;
  platform: string;
  created_at: string;
  last_used_at: string;
  status: 'active' | 'expired' | 'revoked' | 'disabled';
}

/** GET /api/me/sessions */
interface Session {
  id: string;
  current: boolean;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

/** GET /api/me/activity */
interface LogEvent {
  id: string;
  type: string;
  created_at: string;
  user_agent: string | null;
  this_network: boolean;
  provider: string | null;
  client_name: string | null;
  count: number | null;
}

type Child = Node | string | null | undefined | false;

/** An element with its attributes and children; text is always text, never markup. */
function h(tag: string, attrs: Record<string, string | boolean | null | undefined> = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** A picture fetched and decoded, so an image shows it the moment it is given it; at most a few seconds' wait. */
const loaded = (src: string) => {
  const img = new Image();
  img.src = src;
  return Promise.race([img.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
};

/**
 * A picture the holder chose, as the API keeps pictures: its middle square,
 * AVATAR_SIDE across at most (never enlarged), as JPEG, or as PNG when part
 * of it is see-through (the two the ring card's renderer can draw). Large
 * pictures are halved step by step on the way down, which keeps them smooth
 * in every browser. Throws 'size' for a file too large to open, 'image' for
 * one the browser cannot read.
 */
async function squarePicture(file: File): Promise<Blob> {
  if (file.size > 20 * 1024 * 1024) throw new Error('size');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Error('image');
    });
    const { naturalWidth: w, naturalHeight: h } = img;
    let size = Math.min(w, h);
    if (!size) throw new Error('image');
    const out = Math.min(AVATAR_SIDE, size);
    let source: CanvasImageSource = img;
    let sx = (w - size) / 2;
    let sy = (h - size) / 2;
    let canvas: HTMLCanvasElement | null = null;
    const draw = (side: number) => {
      const next = document.createElement('canvas');
      next.width = next.height = side;
      const g = next.getContext('2d');
      if (!g) throw new Error('image');
      g.imageSmoothingQuality = 'high';
      g.drawImage(source, sx, sy, size, size, 0, 0, side, side);
      source = canvas = next;
      sx = sy = 0;
      size = side;
    };
    // (a canvas wider than this is more than some phones will draw)
    if (size > 4096) draw(4096);
    while (size / 2 >= out) draw(Math.round(size / 2));
    if (!canvas || size !== out) draw(out);
    const made = canvas as HTMLCanvasElement | null;
    const g = made?.getContext('2d');
    if (!made || !g) throw new Error('image');
    const { data } = g.getImageData(0, 0, made.width, made.height);
    let clear = false;
    for (let i = 3; i < data.length && !clear; i += 4) clear = data[i] < 255;
    const blob = await toBlob(made, clear ? 'image/png' : 'image/jpeg', 0.9);
    if (!blob) throw new Error('image');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const root = document.querySelector<HTMLElement>('[data-console]');
if (root) start(root);

/**
 * The console (components/console/Console.astro): who is signed in, from
 * /api/me/account, and the section on show, from its own address. Every
 * answer names the account it is about; when that is not the one the page
 * shows, the page starts again with the one signed in now, and nothing it
 * showed before can be acted on. Signed out, it asks to sign in, and the
 * provider brings the visitor back to this same address.
 */
function start(root: HTMLElement) {
  const lang = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  const c = consoleDicts[lang];
  const locale = lang === 'zh' ? 'zh-CN' : 'en';
  const section = root.dataset.section as ConsoleSection;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const loading = $('[data-console-loading]')!;
  const failed = $('[data-console-failed]')!;
  const changed = $('[data-console-changed]')!;
  const gate = $('[data-console-gate]')!;
  // the ring number the page shows, and the load it belongs to: an answer for an earlier one is dropped
  let srn: number | null = account.me()?.number ?? null;
  let epoch = 0;

  // ------------------------------------------------------------ formatting
  const day = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  // the telemetry's clock, in both languages
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
  // a time the page cannot read is left out, never allowed to stop the rest
  const known = (iso: string | null | undefined): iso is string => !!iso && Number.isFinite(Date.parse(iso));
  const date = (iso: string | null | undefined) => (known(iso) ? day.format(new Date(iso)) : '');
  /** midnight of the day a time falls on, here */
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  /** a day of the log: today and yesterday by those words, with the date */
  const dayHeading = (iso: string) => {
    const back = Math.round((midnight(new Date()) - midnight(new Date(iso))) / 86400000);
    if (back !== 0 && back !== 1) return date(iso);
    const words = relative.format(-back, 'day');
    return `${words[0].toLocaleUpperCase(locale)}${words.slice(1)} · ${date(iso)}`;
  };
  /** a phrase with a time in it, or nothing without one */
  const at = (text: string, key: 'date' | 'time', iso: string | null | undefined) => {
    const value = key === 'date' ? date(iso) : ago(iso);
    return value ? fill(text, { [key]: value }) : null;
  };
  const ago = (iso: string | null | undefined) => {
    if (!known(iso)) return '';
    const s = (Date.parse(iso) - Date.now()) / 1000;
    const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [2592000, 'day'], [31536000, 'month']];
    const abs = Math.abs(s);
    if (abs < 45) return relative.format(0, 'second');
    const units: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, month: 2592000, year: 31536000 };
    const unit = steps.find(([limit]) => abs < limit)?.[1] ?? 'year';
    return relative.format(Math.round(s / units[unit]), unit);
  };
  /** A browser and its system, from what it said it was; an app by its own name. */
  const device = (agent: string | null) => {
    if (!agent) return c.device.unknown;
    const browser = /Edg(?:e|A|iOS)?\//.test(agent)
      ? 'Edge'
      : /OPR\/|Opera/.test(agent)
        ? 'Opera'
        : /Firefox\/|FxiOS/.test(agent)
          ? 'Firefox'
          : /SamsungBrowser/.test(agent)
            ? 'Samsung Internet'
            : /Chrome\/|CriOS/.test(agent)
              ? 'Chrome'
              : /Version\/.*Safari\//.test(agent)
                ? 'Safari'
                : null;
    const os = /iPhone|iPod/.test(agent)
      ? 'iOS'
      : /iPad/.test(agent)
        ? 'iPadOS'
        : /Android/.test(agent)
          ? 'Android'
          : /CrOS/.test(agent)
            ? 'ChromeOS'
            : /Macintosh|Mac OS X/.test(agent)
              ? 'macOS'
              : /Windows/.test(agent)
                ? 'Windows'
                : /Linux/.test(agent)
                  ? 'Linux'
                  : null;
    if (browser && os) return fill(c.device.on, { browser, os });
    const app = /^([A-Za-z][\w.-]{0,30})\/\d/.exec(agent)?.[1];
    return browser ?? os ?? (app ? app[0].toUpperCase() + app.slice(1) : c.device.unknown);
  };
  /** What a client said it runs on, as the systems call themselves. */
  const SYSTEMS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', ipados: 'iPadOS', android: 'Android', chromeos: 'ChromeOS' };
  const system = (platform: string) => SYSTEMS[platform.toLowerCase()] ?? platform;
  const icon = (name: string) => (document.querySelector<HTMLTemplateElement>(`template[data-icon="${name}"]`)?.content.firstElementChild?.cloneNode(true) as Element | undefined) ?? null;
  const time = (iso: string, text: string) => h('time', { datetime: iso, title: known(iso) ? new Date(iso).toLocaleString(locale) : null }, text);

  // ----------------------------------------------------------------- state
  const setState = (state: 'loading' | 'in' | 'out' | 'error') => {
    root.dataset.state = state;
    loading.hidden = state !== 'loading';
    failed.hidden = state !== 'error';
    gate.hidden = state !== 'out';
  };

  const signedOut = () => {
    epoch++;
    srn = null;
    profile?.close();
    setState('out');
    if (account.me()) account.set(null);
  };

  /** JSON from the API; 'out' once signed out, null when it could not be had. */
  async function get<T>(url: string): Promise<T | 'out' | null> {
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (res.status === 401) return 'out';
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /** A change on the account's behalf: the account it is meant for goes with it. */
  const send = (url: string, method: 'POST' | 'DELETE') =>
    fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_srn: srn }),
    }).catch(() => null);

  /** The account signed in here is not the one on show: start again with it, and nothing listed for the other stays actionable. */
  const accountChanged = () => {
    changed.hidden = false;
    root.querySelectorAll('[data-list]').forEach((list) => list.replaceChildren());
    void load();
  };

  /** A button that asks once more before it acts. */
  const confirmed = (button: HTMLButtonElement, act: () => Promise<void>) => {
    const label = button.textContent ?? '';
    let armed = 0;
    const disarm = () => {
      clearTimeout(armed);
      armed = 0;
      button.textContent = label;
      button.classList.remove('is-armed');
    };
    button.addEventListener('click', async () => {
      if (!armed) {
        button.textContent = c.confirm;
        button.classList.add('is-armed');
        armed = window.setTimeout(disarm, 4000);
        return;
      }
      disarm();
      button.disabled = true;
      await act();
      button.disabled = false;
    });
    button.addEventListener('blur', () => armed && disarm());
  };

  const empty = (text: string) => h('li', { class: 'row row--empty' }, text);
  /**
   * A row's line of details, each kept whole: a narrow row breaks between
   * them, not inside one. Those that may not fit a narrow line may break
   * inside: a long phrase, or anything longer than an IPv4 address with no
   * space to break at (an IPv6 address).
   */
  const long = (item: string) => item.length > 24 || (item.length > 15 && !/\s/.test(item));
  const details = (items: (string | null | undefined)[]) =>
    h('span', { class: 'row__meta' }, ...items.filter((item): item is string => !!item).map((item) => h('span', { class: long(item) ? 'row__detail row__detail--long' : 'row__detail' }, item)));
  const rowError = (row: HTMLElement) => {
    row.querySelector('.row__error')?.remove();
    row.querySelector('.row__main')?.append(h('span', { class: 'row__error', role: 'alert' }, c.notDone));
  };
  const more = (list: HTMLElement, next: () => Promise<unknown>) => {
    const button = h('button', { class: 'btn btn--ghost btn--small', type: 'button' }, c.more) as HTMLButtonElement;
    button.addEventListener('click', async () => {
      button.disabled = true;
      await next();
      button.disabled = false;
    });
    list.append(h('li', { class: 'row row--more', 'data-more': true }, button));
  };

  // -------------------------------------------------------------- the account
  function showAccount(data: AccountData) {
    const email = $('[data-email]');
    if (email) email.textContent = data.user.email;
    const methods = $('[data-methods]');
    if (methods) methods.replaceChildren(...data.providers.map((p) => h('span', { class: 'profile__method' }, icon(p.provider), PROVIDERS[p.provider] ?? p.provider)));
    const tile = (key: string, text: string) => {
      const el = $(`[data-tile="${key}"]`);
      if (el) el.textContent = text;
    };
    tile('clients', data.clients ? c.overview.clients.value(data.clients) : c.overview.clients.none);
    tile('sessions', c.overview.sessions.value(data.sessions));
    tile('last', (data.last_sign_in && ago(data.last_sign_in.at)) || c.overview.lastSignIn.none);
    tile('last-device', data.last_sign_in ? device(data.last_sign_in.user_agent) : '');
  }

  const PROVIDERS: Record<string, string> = { github: 'GitHub', google: 'Google' };

  // ---------------------------------------------------------------- clients
  async function loadClients(cursor?: string) {
    const list = $('[data-list="clients"]')!;
    const mine = epoch;
    const owner = srn;
    const data = await get<{ account_srn: number; clients: Client[]; next_cursor: string | null }>(
      `/api/me/clients${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (mine !== epoch) return;
    if (data === 'out') return signedOut();
    if (!data) {
      if (!cursor) setState('error');
      return;
    }
    if (data.account_srn !== owner) return accountChanged();
    if (!cursor) list.replaceChildren();
    else list.querySelector('[data-more]')?.remove();
    if (!data.clients.length && !cursor) list.append(empty(c.clients.empty));
    for (const item of data.clients) list.append(clientRow(item));
    if (data.next_cursor) more(list, () => loadClients(data.next_cursor!));
  }

  function clientRow(item: Client) {
    const live = item.status === 'active' || item.status === 'disabled';
    // A Web connection is held by the service at that address; device and
    // platform are only what the client said about itself.
    const title = item.client_origin ? `${item.client_name} Web · ${item.client_origin}` : `${item.client_name} · ${item.device_name ?? system(item.platform)}`;
    const meta = [item.client_origin || !item.device_name ? null : system(item.platform), at(c.clients.connected, 'date', item.created_at), at(c.clients.used, 'time', item.last_used_at)];
    const row = h(
      'li',
      { class: `row${live ? '' : ' row--off'}` },
      icon(item.client_type === 'web' ? 'web' : 'desktop'),
      h('span', { class: 'row__main' }, h('span', { class: 'row__title' }, title), details(meta)),
      h('span', { class: `status${item.status === 'active' ? ' status--on' : ''}` }, c.clients.status[item.status]),
    );
    // Expired and disconnected ones cannot be used again. A disabled
    // service's connections come back if it is turned on again, so they can
    // still be disconnected.
    if (live) {
      const button = h('button', { class: 'row__action', type: 'button' }, c.clients.disconnect) as HTMLButtonElement;
      confirmed(button, async () => {
        const mine = epoch;
        const res = await send(`/api/me/clients/${encodeURIComponent(item.id)}`, 'DELETE');
        if (mine !== epoch) return;
        if (res?.ok) return void (await loadClients());
        if (res?.status === 401) return signedOut();
        if (res?.status === 409) return accountChanged();
        rowError(row);
      });
      row.append(button);
    }
    return row;
  }

  // --------------------------------------------------------------- security
  function showMethods(data: AccountData) {
    const list = $('[data-list="methods"]')!;
    list.replaceChildren(
      ...Object.entries(PROVIDERS).map(([id, name]) => {
        const linked = data.providers.find((p) => p.provider === id);
        return h(
          'li',
          { class: `row${linked ? '' : ' row--off'}` },
          h('span', { class: 'row__icon row__icon--brand' }, icon(id)),
          h('span', { class: 'row__main' }, h('span', { class: 'row__title' }, name), h('span', { class: 'row__meta' }, linked ? (at(c.security.linked, 'date', linked.linked_at) ?? '') : c.security.notLinked)),
        );
      }),
    );
  }

  async function loadSessions() {
    const list = $('[data-list="sessions"]')!;
    const othersButton = $<HTMLButtonElement>('[data-revoke-others]')!;
    const mine = epoch;
    const data = await get<{ account_srn: number; sessions: Session[] }>('/api/me/sessions');
    if (mine !== epoch) return;
    if (data === 'out') return signedOut();
    if (!data) return setState('error');
    if (data.account_srn !== srn) return accountChanged();
    const sessions = [...data.sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.updated_at.localeCompare(a.updated_at));
    list.replaceChildren(...sessions.map(sessionRow));
    const alone = sessions.every((s) => s.current);
    if (alone) list.append(empty(c.security.noOthers));
    othersButton.hidden = alone;
  }

  function sessionRow(session: Session) {
    const meta = [at(c.security.signedIn, 'date', session.created_at), at(c.security.active, 'time', session.updated_at), session.ip_address];
    const row = h(
      'li',
      { class: 'row' },
      icon('browser'),
      h(
        'span',
        { class: 'row__main' },
        h('span', { class: 'row__title' }, device(session.user_agent), session.current && h('span', { class: 'chip chip--bead' }, c.security.current)),
        details(meta),
      ),
    );
    const button = h('button', { class: 'row__action', type: 'button' }, c.security.signOut) as HTMLButtonElement;
    confirmed(button, async () => {
      // this browser signs out the usual way, and the console asks to sign in again
      if (session.current) {
        if (await account.signOut()) signedOut();
        else rowError(row);
        return;
      }
      const mine = epoch;
      const res = await send(`/api/me/sessions/${encodeURIComponent(session.id)}`, 'DELETE');
      if (mine !== epoch) return;
      if (res?.ok || res?.status === 404) return void (await loadSessions());
      if (res?.status === 401) return signedOut();
      if (res?.status === 409) return accountChanged();
      rowError(row);
    });
    row.append(button);
    return row;
  }

  const others = $<HTMLButtonElement>('[data-revoke-others]');
  if (others)
    confirmed(others, async () => {
      const mine = epoch;
      const res = await send('/api/me/sessions/revoke-others', 'POST');
      if (mine !== epoch) return;
      if (res?.ok) return void (await loadSessions());
      if (res?.status === 401) return signedOut();
      if (res?.status === 409) return accountChanged();
      const list = $('[data-list="sessions"]');
      list?.querySelector('[data-others-error]')?.remove();
      list?.append(h('li', { class: 'row row--empty row__error', role: 'alert', 'data-others-error': true }, c.notDone));
    });

  // --------------------------------------------------------------- activity
  let lastDay = '';
  async function loadActivity(cursor?: string) {
    const list = $('[data-list="activity"]')!;
    const mine = epoch;
    const data = await get<{ account_srn: number; events: LogEvent[]; next_cursor: string | null }>(
      `/api/me/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (mine !== epoch) return;
    if (data === 'out') return signedOut();
    if (!data) {
      if (!cursor) setState('error');
      return;
    }
    if (data.account_srn !== srn) return accountChanged();
    if (!cursor) {
      list.replaceChildren();
      lastDay = '';
    } else list.querySelector('[data-more]')?.remove();
    if (!data.events.length && !cursor) list.append(empty(c.activity.empty));
    for (const event of data.events) {
      const today = date(event.created_at);
      if (today && today !== lastDay) {
        lastDay = today;
        list.append(h('li', { class: 'rows__day mono' }, dayHeading(event.created_at)));
      }
      list.append(eventRow(event));
    }
    if (data.next_cursor) more(list, () => loadActivity(data.next_cursor!));
  }

  function eventRow(event: LogEvent) {
    const words = c.activity.events;
    const variant = event.provider ?? (event.type === 'session.revoked' && event.count === 1 ? '1' : null);
    let title = (variant && words[`${event.type}.${variant}`]) || words[event.type] || c.activity.other;
    title = fill(title, { n: String(event.count ?? '') });
    if (event.client_name) title = `${title} · ${event.client_name}`;
    return h(
      'li',
      { class: `row row--event${event.type === 'client.code_reused' ? ' row--alert' : ''}` },
      h('span', { class: 'row__time mono' }, time(event.created_at, known(event.created_at) ? clock.format(new Date(event.created_at)) : '')),
      h(
        'span',
        { class: 'row__main' },
        h('span', { class: 'row__title' }, title),
        // where it came from, and whether that was this network, in plain words (on nearly every row, a mark would be noise)
        details([device(event.user_agent), event.this_network ? c.activity.thisNetwork : null]),
      ),
    );
  }

  // ---------------------------------------------------------------- profile
  const dialog = $<HTMLDialogElement>('[data-profile-dialog]');
  const profile = dialog ? profileEditor(dialog) : null;

  /**
   * The profile, in a dialog the overview's face and Edit profile open, and
   * the side's account card on every section: the holder changes their
   * picture and their name. A new picture is made here (the middle square,
   * at most AVATAR_SIDE across) and shown in the dialog's face until saved or
   * dropped; one Save sends whatever changed, for the account the page shows.
   */
  function profileEditor(dialog: HTMLDialogElement) {
    const p = c.profile;
    const q = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
    const face = q<HTMLButtonElement>('[data-face]');
    const preview = q<HTMLImageElement>('[data-avatar-preview]');
    const file = q<HTMLInputElement>('[data-avatar-file]');
    const picks = [...dialog.querySelectorAll<HTMLButtonElement>('[data-avatar-pick]')];
    const remove = q<HTMLButtonElement>('[data-avatar-remove]');
    const form = q<HTMLFormElement>('[data-profile-form]');
    const input = q<HTMLInputElement>('[data-profile-name]');
    const count = q('[data-profile-count]');
    const save = q<HTMLButtonElement>('[data-profile-save]');
    const cancel = q<HTMLButtonElement>('[data-profile-cancel]');
    const shut = q<HTMLButtonElement>('[data-profile-close]');
    const errors = { picture: q('[data-profile-error="picture"]'), name: q('[data-profile-error="name"]'), form: q('[data-profile-error="form"]') };
    // where "Saved" is said: by Edit profile on the overview, to screen readers elsewhere
    const saved = $('[data-profile-saved]');
    const saveLabel = save.textContent ?? '';
    // fine pointers get the name ready to type; on touch screens the keyboard waits to be asked for
    const typing = window.matchMedia('(pointer: fine)');
    // the picture waiting for Save: a new one, none (removed), or null for the one there is
    let pending: { blob: Blob; url: string } | 'none' | null = null;
    let editing = false;
    let busy = false;
    // the picture still being made from the file just chosen: Save waits for it
    let making: Promise<unknown> | null = null;
    // bumped whenever the dialog opens or closes, or another picture is chosen: work for an earlier round is dropped
    let round = 0;
    let savedTimer = 0;
    // what opened the dialog, where focus goes back to
    let opener: HTMLElement | null = null;

    /** One problem at a time, said where it belongs: under the picture, under the name, or over the buttons. */
    const problem = (text: string | null, where: keyof typeof errors = 'form') => {
      for (const [key, el] of Object.entries(errors)) {
        const on = !!text && key === where;
        el.textContent = on ? text : '';
        el.hidden = !on;
      }
      if (text && where === 'name') input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    const nameIssue = (issue: 'empty' | 'long') => fill(issue === 'empty' ? p.problems.empty : p.problems.long, { max: String(NAME_MAX) });
    const counted = () => {
      const n = nameLength(cleanName(input.value));
      count.textContent = `${n}/${NAME_MAX}`;
      count.classList.toggle('is-over', n > NAME_MAX);
    };
    const setPending = (next: typeof pending) => {
      if (pending && pending !== 'none') URL.revokeObjectURL(pending.url);
      pending = next;
      if (next === null) delete face.dataset.pending;
      else face.dataset.pending = next === 'none' ? 'none' : 'new';
      preview.hidden = !next || next === 'none';
      if (next && next !== 'none') preview.src = next.url;
      else preview.removeAttribute('src');
      // a picture to remove: the new one, or the one kept here
      remove.hidden = next === 'none' || (next === null && !ownImage(account.me()?.image));
    };
    // while saving, what is being sent holds still and the dialog stays open; while a picture is being made, Save waits
    const setBusy = (on: boolean) => {
      busy = on;
      save.disabled = on || making !== null;
      for (const button of [cancel, shut, remove, ...picks]) button.disabled = on;
      input.readOnly = on;
      save.textContent = on ? (save.dataset.busy ?? saveLabel) : saveLabel;
      form.toggleAttribute('aria-busy', on);
    };
    const said = (text: string) => {
      if (!saved) return;
      saved.textContent = text;
      clearTimeout(savedTimer);
      if (text) savedTimer = window.setTimeout(() => (saved.textContent = ''), 3000);
    };

    function open(from: HTMLElement, focus: 'name' | 'picture') {
      const me = account.me();
      if (editing || !me || root.dataset.state !== 'in') return;
      editing = true;
      round++;
      opener = from;
      input.value = me.name;
      counted();
      problem(null);
      setPending(null);
      setBusy(false);
      said('');
      dialog.showModal();
      scroll.stop();
      if (focus === 'name' && typing.matches) {
        input.focus();
        input.select();
      } else face.focus();
    }

    /** However the dialog closed (Save, Cancel, the close button, Escape, the veil, the page): nothing waiting is kept. */
    function reset() {
      if (!editing) return;
      editing = false;
      round++;
      // a picture still being made is dropped when it is ready
      making = null;
      face.removeAttribute('aria-busy');
      delete face.dataset.fresh;
      setBusy(false);
      setPending(null);
      problem(null);
      scroll.start();
      // back to what opened it (the browser does this too, but not every browser focuses a button when it is clicked)
      const back = opener;
      opener = null;
      if (back?.isConnected && (!document.activeElement || document.activeElement === document.body || dialog.contains(document.activeElement))) back.focus();
    }

    function close() {
      if (dialog.open) dialog.close();
      reset();
    }

    dialog.addEventListener('close', reset);
    // while saving it stays open (a browser may still close it on a second Escape: the answer then only updates the page)
    dialog.addEventListener('cancel', (e) => {
      if (busy) e.preventDefault();
    });
    // a click on the veil closes it, but not one that began inside (text selected past the edge)
    let downOnVeil = false;
    dialog.addEventListener('pointerdown', (e) => (downOnVeil = e.target === dialog));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && downOnVeil && !busy) close();
      downOnVeil = false;
    });
    shut.addEventListener('click', close);
    cancel.addEventListener('click', close);

    root.querySelectorAll<HTMLElement>('[data-profile-open]').forEach((button) =>
      button.addEventListener('click', () => open(button, button.dataset.profileOpen === 'picture' ? 'picture' : 'name')),
    );

    picks.forEach((button) =>
      button.addEventListener('click', () => {
        if (editing && !busy) file.click();
      }),
    );
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen || !editing || busy) return;
      const mine = ++round;
      problem(null);
      const job = squarePicture(chosen).catch((err: Error) => err);
      making = job;
      face.setAttribute('aria-busy', 'true');
      setBusy(busy);
      const made = await job;
      if (making !== job) return;
      making = null;
      face.removeAttribute('aria-busy');
      setBusy(busy);
      if (mine !== round) return;
      if (made instanceof Error) return problem(made.message === 'size' ? p.problems.imageSize : p.problems.image, 'picture');
      setPending({ blob: made, url: URL.createObjectURL(made) });
      face.dataset.fresh = '';
    });
    face.addEventListener('pointerleave', () => delete face.dataset.fresh);

    remove.addEventListener('click', () => {
      if (busy) return;
      problem(null);
      setPending('none');
      // the button is gone: focus stays with the picture
      picks.at(-1)?.focus();
    });
    input.addEventListener('input', () => {
      counted();
      if (input.hasAttribute('aria-invalid')) problem(null);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const me = account.me();
      if (!me || busy || making || srn === null) return;
      const name = cleanName(input.value);
      const issue = nameProblem(name);
      if (issue) {
        problem(nameIssue(issue), 'name');
        input.focus();
        return;
      }
      const body = new FormData();
      body.set('expected_srn', String(srn));
      if (name !== me.name) body.set('name', name);
      const picture = pending && pending !== 'none' ? pending : null;
      if (pending === 'none' && me.image) body.set('remove_avatar', '1');
      else if (picture) body.set('avatar', picture.blob, picture.blob.type === 'image/png' ? 'avatar.png' : 'avatar.jpg');
      // nothing changed: nothing to send
      if ([...body.keys()].length === 1) return close();
      problem(null);
      setBusy(true);
      const mine = epoch;
      const sent = round;
      const res = await fetch('/api/me/profile', { method: 'PATCH', credentials: 'same-origin', body }).catch(() => null);
      const answer = res ? ((await res.json().catch(() => null)) as { account_srn?: number; user?: Me; error?: string; reason?: string } | null) : null;
      if (mine !== epoch) return;
      if (res?.ok && answer?.user) {
        if (answer.account_srn !== srn) return accountChanged();
        // the copy kept here, loaded before it takes the preview's place: the old picture never shows in between
        const image = ownImage(answer.user.image);
        if (image && picture) await loaded(image);
        if (mine !== epoch) return;
        account.set(answer.user);
        // the dialog may have been closed meanwhile (and even opened again): only the one that sent this closes
        if (sent === round) close();
        said(p.saved);
        return;
      }
      if (sent !== round) return;
      setBusy(false);
      if (res?.status === 401) return signedOut();
      if (res?.status === 409) return accountChanged();
      if (answer?.error === 'invalid_name') {
        problem(nameIssue(answer.reason === 'empty' ? 'empty' : 'long'), 'name');
        input.focus();
        return;
      }
      if (answer?.error === 'invalid_image' || res?.status === 413) return problem(p.problems.image, 'picture');
      if (res?.status === 429) return problem(p.problems.limited);
      problem(c.notDone);
    });

    return { close };
  }

  // ------------------------------------------------------------------- card
  const cardRoot = $('[data-card-view]');
  const card = cardRoot ? initCardView({ root: cardRoot, signedOut }) : null;

  // ------------------------------------------------------------------ load
  async function load() {
    const mine = ++epoch;
    profile?.close();
    setState('loading');
    const data = await get<AccountData>('/api/me/account');
    if (mine !== epoch) return;
    if (data === 'out') return signedOut();
    if (!data) return setState('error');
    if (srn !== null && srn !== data.user.number) changed.hidden = false;
    srn = data.user.number;
    account.set({ number: data.user.number, name: data.user.name, image: data.user.image });
    showAccount(data);
    setState('in');
    if (section === 'clients') await loadClients();
    else if (section === 'security') {
      showMethods(data);
      await loadSessions();
    } else if (section === 'activity') await loadActivity();
    else if (section === 'card') card?.load();
  }

  $('[data-console-retry]')?.addEventListener('click', () => void load());

  const signOut = $<HTMLButtonElement>('[data-console-signout]');
  const signOutError = $('[data-console-signout-error]');
  signOut?.addEventListener('click', async () => {
    signOut.disabled = true;
    if (signOutError) signOutError.hidden = true;
    const done = await account.signOut();
    signOut.disabled = false;
    if (done) signedOut();
    else if (signOutError) signOutError.hidden = false;
  });

  // Signing in from here comes back here, to this section.
  const providers = [...gate.querySelectorAll<HTMLButtonElement>('[data-gate-provider]')];
  const gateError = gate.querySelector<HTMLElement>('[data-gate-error]');
  if (gateError) gateError.hidden = !account.signInFailed;
  providers.forEach((button) =>
    button.addEventListener('click', async () => {
      providers.forEach((b) => (b.disabled = true));
      const label = button.querySelector('span');
      const text = label?.textContent ?? '';
      if (label) label.textContent = button.dataset.busy ?? text;
      if (await socialSignIn(button.dataset.gateProvider ?? '', backTo('signed-in'), backTo('sign-in-error'))) return;
      if (gateError) gateError.hidden = false;
      if (label) label.textContent = text;
      providers.forEach((b) => (b.disabled = false));
    }),
  );

  // Signed out anywhere on the page (the dialog, the ring card's view), even
  // while the account is still loading: nothing asked for before then may
  // bring it back. Signed in found there while this asks to sign in: load.
  account.watch((me) => {
    if (!me && root.dataset.state !== 'out') signedOut();
    else if (me && root.dataset.state === 'out') void load();
  });
  // On narrow screens the sections are a row that scrolls: the one on show is
  // brought into it from the start, where CSS cannot do it (scroll-initial-target).
  const tab = $('.console__nav [aria-current="page"]');
  const row = tab?.closest<HTMLElement>('.console__nav');
  if (tab && row && !CSS.supports('scroll-initial-target', 'nearest')) {
    const over = tab.getBoundingClientRect().right + (parseFloat(getComputedStyle(row).scrollPaddingRight) || 0) - row.getBoundingClientRect().right;
    if (over > 0) row.scrollLeft += over;
  }
  // back to this page from the history: what it showed may have changed since
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void load();
  });
  void load();
}
