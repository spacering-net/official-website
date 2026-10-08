import { initCardView } from './card';
import type { ScrollLock } from './menu';

/** What the page knows about the signed-in user (GET /api/me). */
export interface Me {
  number: number;
  name: string;
  image: string | null;
}

interface AccountOptions {
  scroll: ScrollLock;
  menu: { isOpen(): boolean; closeNow(after?: () => void): void };
  /** Whether the page may scroll again once the dialog closes (not during the intro or under the menu). */
  scrollable: () => boolean;
  /** The ring number to engrave on the homepage's band, or null; `fresh` right after signing in. */
  onRing?: (number: number | null, fresh: boolean) => void;
}

/** This page's address with a flag added to its query, for the providers to send the visitor back to. */
const backTo = (flag: string) => `${location.pathname}${location.search ? `${location.search}&` : '?'}${flag}${location.hash}`;

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
 * The last signed-in user, kept so a returning visitor's band is engraved on
 * the first frame. It is only a hint: /api/me has the last word, and a page
 * without it never calls the API, so anonymous visits stay fully static.
 */
const HINT = 'sr-account';

const readHint = (): Me | null => {
  try {
    const me = JSON.parse(localStorage.getItem(HINT) || 'null') as Me | null;
    return me && Number.isInteger(me.number) ? me : null;
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
 * Sign-in (GitHub, Google), the signed-in card, and the ring card's view.
 * Providers redirect back to the page the visitor left, with ?signed-in or
 * ?sign-in-error.
 */
export function initAccount({ scroll, menu, scrollable, onRing }: AccountOptions) {
  const dialog = document.querySelector<HTMLDialogElement>('[data-account-dialog]');
  const openers = [...document.querySelectorAll<HTMLButtonElement>('[data-account-open]')];
  // on a ring card's page: opens the visitor's own card, or signing in
  const cardOpeners = [...document.querySelectorAll<HTMLButtonElement>('[data-account-card]')];
  if (!dialog) return;
  const views = {
    out: dialog.querySelector<HTMLElement>('[data-account-view="out"]')!,
    in: dialog.querySelector<HTMLElement>('[data-account-view="in"]')!,
    card: dialog.querySelector<HTMLElement>('[data-account-view="card"]')!,
  };
  const error = dialog.querySelector<HTMLElement>('[data-account-error]');
  const providers = [...dialog.querySelectorAll<HTMLButtonElement>('[data-provider]')];
  const avatar = dialog.querySelector<HTMLImageElement>('[data-account-avatar]');
  const signOutButton = dialog.querySelector<HTMLButtonElement>('[data-account-signout]');
  const signOutError = dialog.querySelector<HTMLElement>('[data-account-signout-error]');
  let me: Me | null = null;
  // bumped when this page signs out: an /api/me answer asked for before then is stale
  let epoch = 0;
  // which view the dialog shows once signed in
  let view: 'in' | 'card' = 'in';
  // whether the ring card's view, on screen, has been loaded since it came on
  let cardLoaded = false;
  // set below; render() keeps it in step with what is on screen
  let syncCard = () => {};

  const render = () => {
    for (const b of openers) {
      if (me) {
        b.innerHTML = '';
        const srn = document.createElement('span');
        srn.className = 'account-btn__srn';
        srn.textContent = 'SRN';
        b.append(srn, String(me.number));
        b.setAttribute('aria-label', `${b.dataset.label} · SRN ${me.number}`);
      } else {
        b.textContent = b.dataset.signIn ?? '';
        b.removeAttribute('aria-label');
      }
    }
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
    if (me) {
      dialog.querySelector('[data-account-number]')!.textContent = String(me.number);
      dialog.querySelector('[data-account-name]')!.textContent = me.name;
      if (avatar) {
        avatar.hidden = !me.image;
        if (me.image) avatar.src = me.image;
      }
    }
    syncCard();
  };

  const setMe = (next: Me | null, fresh: boolean) => {
    const changed = (next?.number ?? null) !== (me?.number ?? null);
    me = next;
    writeHint(next);
    render();
    if (changed || fresh) onRing?.(next?.number ?? null, fresh);
  };

  const cardView = initCardView({
    root: views.card,
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
  syncCard = () => {
    const showing = dialog.open && !views.card.hidden;
    if (showing === cardLoaded) return;
    cardLoaded = showing;
    if (showing) cardView.load();
    else cardView.reset();
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
      syncCard();
      scroll.stop();
    };
    if (menu.isOpen()) menu.closeNow(show);
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
      try {
        const res = await fetch('/api/auth/sign-in/social', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          // back to this very page, with its query (a search, a filter) and fragment
          body: JSON.stringify({ provider: button.dataset.provider, callbackURL: backTo('signed-in'), errorCallbackURL: backTo('sign-in-error') }),
        });
        const data = (await res.json().catch(() => null)) as { url?: string } | null;
        if (res.ok && data?.url) {
          location.assign(data.url);
          return;
        }
      } catch {
        /* falls through to the error below */
      }
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
    const res = await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => null);
    signOutButton.disabled = false;
    if (!res?.ok) {
      if (signOutError) signOutError.hidden = false;
      return;
    }
    epoch++;
    setMe(null, false);
    dialog.close();
  });

  // ------------------------------------------------------------------ boot
  const params = new URLSearchParams(location.search);
  const signedIn = params.has('signed-in');
  const failed = params.has('sign-in-error');
  if (signedIn || failed) {
    for (const key of ['signed-in', 'sign-in-error', 'error']) params.delete(key);
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }

  const hint = readHint();
  if (hint) setMe(hint, false);
  else render();
  // back from signing in that began at a ring card's button: on to the visitor's own card
  const onToCard = signedIn && intended() === 'card';
  if (signedIn || failed) intend(null);
  if (signedIn || hint) {
    const asked = epoch;
    fetchMe().then((user) => {
      if (user === undefined || asked !== epoch) return;
      setMe(user, signedIn && !!user);
      if (onToCard && user && !dialog.open) open(false, 'card');
    });
  }
  if (failed) open(true);
}
