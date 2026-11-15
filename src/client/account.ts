import { initCardView } from './card';
import { socialSignIn } from './social-sign-in';
import type { ScrollLock } from './scroll-lock';

/** What the page knows about the signed-in user (GET /api/me). */
export interface Me {
  number: number;
  name: string;
  image: string | null;
}

interface AccountOptions {
  scroll: ScrollLock;
  /** the narrow screens' menu: it closes before the dialog opens */
  sheet: { isOpen(): boolean; closeNow(after?: () => void): void };
  /** Whether the page may scroll again once the dialog closes (not during the intro or under the menu). */
  scrollable: () => boolean;
  /** The ring number to engrave on the homepage's band, or null; `fresh` right after signing in. */
  onRing?: (number: number | null, fresh: boolean) => void;
}

/** The account as the rest of the page sees it (the console). */
export interface Account {
  /** who is signed in, as far as the page knows */
  me(): Me | null;
  /** told whenever that changes */
  watch(fn: (me: Me | null) => void): void;
  /** who the server says is signed in, from an answer the caller had */
  set(me: Me | null): void;
  /** signs this browser out; false if the server did not */
  signOut(): Promise<boolean>;
  /** the visitor came back from a provider without signing in (?sign-in-error) */
  signInFailed: boolean;
}

/** This page's address with a flag added to its query, for the providers to send the visitor back to. */
export const backTo = (flag: string) => `${location.pathname}${location.search ? `${location.search}&` : '?'}${flag}${location.hash}`;

/** A picture kept here (avatars.ts) is shown; one still at the provider is not (these pages load images from this site only). */
export const ownImage = (image: string | null | undefined) => (image && image.startsWith('/api/avatars/') ? image : null);

/** The first letter of a name, for a face without a picture. */
export const initialOf = (name: string | null | undefined) => (Array.from(name?.trim() ?? '')[0] ?? '').toUpperCase();

/**
 * Signing in from a ring card page's button: once back, the dialog opens on
 * the visitor's own card. Kept for the trip through the provider.
 */
const INTENT = 'sr-after-sign-in';
const intend = (what: 'card' | null) => {
  try {
    if (what) sessionStorage.setItem(INTENT, what);
    else sessionStorage.removeItem(INTENT);
  } catch {
    /* without storage the dialog just stays closed */
  }
};
const intended = () => {
  try {
    return sessionStorage.getItem(INTENT);
  } catch {
    return null;
  }
};

/**
 * The last signed-in user, kept so a returning visitor's band is engraved and
 * the HUD shows them on the first frame (account-hint.js reads it before this
 * runs). It is only a hint: /api/me has the last word, and a page without it
 * never calls the API, so anonymous visits stay fully static.
 */
const HINT = 'sr-account';

const readHint = (): Me | null => {
  try {
    const me = JSON.parse(localStorage.getItem(HINT) || 'null') as Me | null;
    return me && Number.isInteger(me.number) && typeof me.name === 'string' ? me : null;
  } catch {
    return null;
  }
};

const writeHint = (me: Me | null) => {
  try {
    if (me) localStorage.setItem(HINT, JSON.stringify(me));
    else localStorage.removeItem(HINT);
  } catch {
    /* private mode: the band is engraved after /api/me instead */
  }
};

/** undefined: the API could not be reached, so nothing is known. */
async function fetchMe(): Promise<Me | null | undefined> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (res.status === 401) return null;
    if (!res.ok) return undefined;
    return ((await res.json()) as { user: Me | null }).user;
  } catch {
    return undefined;
  }
}

/**
 * Who is signed in, wherever the page shows it: the HUD's end (the name and
 * the picture in the ring, or "Sign in" and the ring), the dialog, the
 * console. Without a picture kept here, the face shows the name's first letter.
 */
function paint(me: Me | null) {
  const root = document.documentElement;
  root.classList.toggle('has-account', !!me);
  const image = ownImage(me?.image);
  document.querySelectorAll<HTMLElement>('[data-account-name]').forEach((el) => (el.textContent = me?.name ?? ''));
  document.querySelectorAll<HTMLElement>('[data-account-number]').forEach((el) => (el.textContent = me ? String(me.number) : ''));
  document.querySelectorAll<HTMLElement>('[data-account-initial]').forEach((el) => (el.textContent = initialOf(me?.name)));
  document.querySelectorAll<HTMLImageElement>('[data-account-avatar]').forEach((img) => {
    img.hidden = !image;
    if (!image) img.removeAttribute('src');
    else if (img.getAttribute('src') !== image) img.src = image;
  });
  document.querySelectorAll<HTMLElement>('[data-console-link]').forEach((a) => {
    a.setAttribute('aria-label', me ? `${me.name} · SRN ${me.number} · ${a.dataset.label}` : (a.dataset.label ?? ''));
  });
}

/**
 * Sign-in (GitHub, Google), the signed-in card, and the ring card's view.
 * Providers redirect back to the page the visitor left, with ?signed-in or
 * ?sign-in-error.
 */
export function initAccount({ scroll, sheet, scrollable, onRing }: AccountOptions): Account {
  const dialog = document.querySelector<HTMLDialogElement>('[data-account-dialog]');
  const openers = [...document.querySelectorAll<HTMLButtonElement>('[data-account-open]')];
  // on a ring card's page: opens the visitor's own card, or signing in
  const cardOpeners = [...document.querySelectorAll<HTMLButtonElement>('[data-account-card]')];
  const watchers: ((me: Me | null) => void)[] = [];
  let me: Me | null = null;
  // bumped when this page signs out: an /api/me answer asked for before then is stale
  let epoch = 0;

  const signOut = async () => {
    const res = await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => null);
    if (!res?.ok) return false;
    epoch++;
    setMe(null, false);
    return true;
  };

  // opens the dialog (set up below, when the page has it)
  let openDialog: (failed?: boolean, which?: 'in' | 'card') => void = () => {};
  // which view the dialog shows once signed in
  let view: 'in' | 'card' = 'in';
  // whether the ring card's view, on screen, has been loaded since it came on
  let cardLoaded = false;
  // set below, with the dialog; render() keeps it in step with what is on screen
  let render = () => {};

  function setMe(next: Me | null, fresh: boolean) {
    const changed = (next?.number ?? null) !== (me?.number ?? null);
    me = next;
    writeHint(next);
    paint(next);
    render();
    if (changed || fresh) onRing?.(next?.number ?? null, fresh);
    watchers.forEach((fn) => fn(next));
  }

  const account: Account = {
    me: () => me,
    watch: (fn) => void watchers.push(fn),
    set: (next) => {
      epoch++;
      setMe(next, false);
    },
    signOut,
    signInFailed: false,
  };

  if (dialog) {
    const views = {
      out: dialog.querySelector<HTMLElement>('[data-account-view="out"]')!,
      in: dialog.querySelector<HTMLElement>('[data-account-view="in"]')!,
      card: dialog.querySelector<HTMLElement>('[data-account-view="card"]')!,
    };
    const error = dialog.querySelector<HTMLElement>('[data-account-error]');
    const providers = [...dialog.querySelectorAll<HTMLButtonElement>('[data-provider]')];
    const signOutButton = dialog.querySelector<HTMLButtonElement>('[data-account-signout]');
    const signOutError = dialog.querySelector<HTMLElement>('[data-account-signout-error]');

    const refreshAccount = async () => {
      const asked = ++epoch;
      const next = await fetchMe();
      if (next !== undefined && asked === epoch) setMe(next, false);
    };

    const cardView = initCardView({
      root: views.card.querySelector<HTMLElement>('[data-card-view]')!,
      // the session ended while the view was open: back to signing in
      signedOut: () => {
        view = 'in';
        setMe(null, false);
        views.out.querySelector<HTMLElement>('[data-provider]')?.focus();
      },
    });
    // The card's view loads whenever it comes on screen, however it got there
    // (a button, or signing in finishing while it was asked for), and lets go
    // of whatever it was waiting for when it goes.
    const syncCard = () => {
      const showing = dialog.open && !views.card.hidden;
      if (showing === cardLoaded) return;
      cardLoaded = showing;
      if (showing) cardView.load();
      else cardView.reset();
    };

    render = () => {
      for (const b of cardOpeners) {
        const label = !me ? b.dataset.labelOut : String(me.number) === b.dataset.owner ? b.dataset.labelOwner : b.dataset.labelIn;
        b.textContent = label ?? '';
      }
      const shown = me ? view : 'out';
      views.out.hidden = shown !== 'out';
      views.in.hidden = shown !== 'in';
      views.card.hidden = shown !== 'card';
      dialog.classList.toggle('account--card', shown === 'card');
      dialog.setAttribute('aria-label', (me ? dialog.dataset.labelIn : dialog.dataset.labelOut) ?? '');
      syncCard();
    };

    /** Move between the signed-in card and the ring card's view, in the open dialog. */
    const showView = (next: 'in' | 'card') => {
      view = next;
      render();
      if (next === 'card') views.card.querySelector<HTMLElement>('[data-card-back]')?.focus();
      else views.in.querySelector<HTMLElement>('[data-card-open]')?.focus();
    };

    const open = (failed = false, which: 'in' | 'card' = 'in') => {
      if (error) error.hidden = !failed;
      if (signOutError) signOutError.hidden = true;
      view = which;
      const show = () => {
        render();
        dialog.showModal();
        // A valid website cookie can exist without the optional localStorage
        // hint, for example after authorizing from the dedicated Codeg page.
        void refreshAccount();
        syncCard();
        scroll.stop();
      };
      if (sheet.isOpen()) sheet.closeNow(show);
      else show();
    };

    dialog.addEventListener('close', () => {
      view = 'in';
      syncCard();
      if (scrollable()) scroll.start();
    });
    views.in.querySelector('[data-card-open]')?.addEventListener('click', () => showView('card'));
    views.card.querySelector('[data-card-back]')?.addEventListener('click', () => showView('in'));
    cardOpeners.forEach((b) =>
      b.addEventListener('click', () => {
        // signed out: sign in first, then on to the card
        intend(me ? null : 'card');
        open(false, 'card');
      }),
    );
    // a click on the veil around the card closes it
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.querySelector('[data-account-close]')?.addEventListener('click', () => dialog.close());
    openers.forEach((b) =>
      b.addEventListener('click', () => {
        intend(null);
        open();
      }),
    );

    providers.forEach((button) =>
      button.addEventListener('click', async () => {
        providers.forEach((b) => (b.disabled = true));
        const label = button.querySelector('span');
        const text = label?.textContent ?? '';
        if (label) label.textContent = button.dataset.busy ?? text;
        if (await socialSignIn(button.dataset.provider ?? '', backTo('signed-in'), backTo('sign-in-error'))) return;
        if (error) error.hidden = false;
        if (label) label.textContent = text;
        providers.forEach((b) => (b.disabled = false));
      }),
    );

    // Signed out only once the server says so: if the request fails, the session
    // (and its cookie) is still live, so the page must not pretend otherwise.
    signOutButton?.addEventListener('click', async () => {
      signOutButton.disabled = true;
      if (signOutError) signOutError.hidden = true;
      const done = await signOut();
      signOutButton.disabled = false;
      if (!done) {
        if (signOutError) signOutError.hidden = false;
        return;
      }
      dialog.close();
    });

    openDialog = open;
  }

  // ------------------------------------------------------------------ boot
  const params = new URLSearchParams(location.search);
  const signedIn = params.has('signed-in');
  const failed = params.has('sign-in-error');
  account.signInFailed = failed;
  if (signedIn || failed) {
    for (const key of ['signed-in', 'sign-in-error', 'error']) params.delete(key);
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }

  const hint = readHint();
  if (hint) setMe(hint, false);
  else {
    paint(null);
    render();
  }
  // back from signing in that began at a ring card's button: on to the visitor's own card
  const onToCard = signedIn && intended() === 'card';
  if (signedIn || failed) intend(null);
  // the console asks for itself (with more than /api/me says)
  const own = !!document.querySelector('[data-console]');
  if ((signedIn || hint) && !own) {
    const asked = epoch;
    fetchMe().then((user) => {
      if (user === undefined || asked !== epoch) return;
      setMe(user, signedIn && !!user);
      if (onToCard && user && !dialog?.open) openDialog(false, 'card');
    });
  }
  // the console says so on its own page
  if (failed && !own) openDialog(true);
  return account;
}
