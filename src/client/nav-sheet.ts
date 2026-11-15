import type { ScrollLock } from './scroll-lock';

interface SheetOptions {
  scroll: ScrollLock;
  /** the homepage's chapters: the ring's link scrolls there instead */
  goTo?: (index: number, immediate?: boolean, moveFocus?: boolean) => void;
  reduceMotion: boolean;
}

export interface NavSheet {
  isOpen(): boolean;
  /** Open and done opening: nothing behind it can be seen. */
  covers(): boolean;
  /** Close at once, e.g. to make way for the account dialog; `after` runs once it is closed. */
  closeNow(after?: () => void): void;
}

/** How long the sheet takes to come and go (site.css). */
const IN = 450;
const OUT = 260;

/**
 * The narrow screens' menu (NavSheet.astro): the HUD's button opens it under
 * the HUD and closes it again. While it is open the page behind it is inert
 * and still; the HUD stays, as its way out.
 */
export function initNavSheet({ scroll, goTo, reduceMotion }: SheetOptions): NavSheet {
  const sheet = document.querySelector<HTMLElement>('[data-nav-sheet]');
  const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  if (!sheet || !toggle) return { isOpen: () => false, covers: () => false, closeNow: (after) => after?.() };
  const root = document.documentElement;
  const hud = toggle.closest<HTMLElement>('.hud');
  const narrow = window.matchMedia('(max-width: 1100px)');
  let open = false;
  let settled = false;
  let timer = 0;
  // everything but the HUD and the sheet itself goes inert while it is open
  const background = [...document.body.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== sheet && el !== hud && !(el instanceof HTMLScriptElement),
  );

  const set = (next: boolean, instant = false, after?: () => void) => {
    if (next === open) {
      after?.();
      return;
    }
    open = next;
    settled = false;
    clearTimeout(timer);
    toggle.setAttribute('aria-expanded', String(next));
    toggle.textContent = (next ? toggle.dataset.close : toggle.dataset.open) ?? '';
    const quick = instant || reduceMotion;
    if (next) {
      sheet.hidden = false;
      root.classList.add('nav-open');
      background.forEach((el) => (el.inert = true));
      scroll.stop();
      // from its closed state: the transition needs one frame of that first
      if (quick) sheet.classList.add('is-open');
      else requestAnimationFrame(() => requestAnimationFrame(() => open && sheet.classList.add('is-open')));
      sheet.querySelector<HTMLElement>('.nav-sheet__link')?.focus({ preventScroll: true });
      timer = window.setTimeout(() => (settled = open), quick ? 0 : IN);
      return;
    }
    sheet.classList.remove('is-open');
    const done = () => {
      sheet.hidden = true;
      root.classList.remove('nav-open');
      background.forEach((el) => (el.inert = false));
      scroll.start();
      after?.();
    };
    if (quick) done();
    else timer = window.setTimeout(done, OUT);
  };

  toggle.addEventListener('click', () => {
    set(!open);
    if (!open) toggle.focus({ preventScroll: true });
  });

  document.addEventListener('keydown', (e) => {
    if (!open || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    set(false);
    toggle.focus({ preventScroll: true });
  });

  // the homepage's ring: close, then scroll to its top
  sheet.querySelectorAll<HTMLAnchorElement>('[data-goto]').forEach((link) =>
    link.addEventListener('click', (e) => {
      if (!goTo) return;
      e.preventDefault();
      e.stopPropagation();
      const index = Number(link.dataset.goto);
      set(false, true, () => {
        goTo(index, false, true);
        if (index === 0 && location.hash) history.replaceState(null, '', location.pathname + location.search);
      });
    }),
  );

  // wide enough for the HUD's links again: there is no menu to have open
  narrow.addEventListener('change', () => {
    if (!narrow.matches) set(false, true);
  });
  // back to this page from the history: it was left with the menu open
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) set(false, true);
  });

  return {
    isOpen: () => open,
    covers: () => open && settled,
    closeNow: (after) => set(false, true, after),
  };
}
