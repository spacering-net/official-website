import { initAccount } from './account';
import { initMenu, type ScrollLock } from './menu';
import { initNavRail } from './navrail';
import { initScramble } from './scramble';

/**
 * Every page but the homepage (layouts/Page.astro): the HUD, the orbit menu
 * and the account dialog, as on the homepage but without its scene. While
 * the menu or the dialog is open the page does not scroll.
 */
const root = document.documentElement;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const scroll: ScrollLock = {
  stop: () => root.classList.add('is-locked'),
  start: () => root.classList.remove('is-locked'),
};

const menu = initMenu({ scroll, reduceMotion });
initAccount({ scroll, menu, scrollable: () => !menu.isOpen() });
initScramble(document, root.dataset.scramble || '');
const rail = initNavRail();

let layoutRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(layoutRaf);
  layoutRaf = requestAnimationFrame(rail.layout);
});
document.fonts?.ready.then(rail.layout);

// the language chosen here is the one the homepage opens in next time
document.querySelectorAll<HTMLAnchorElement>('[data-lang-switch]').forEach((a) =>
  a.addEventListener('click', () => {
    try {
      localStorage.setItem('sr-lang', a.dataset.langSwitch || '');
    } catch {
      /* storage may be unavailable */
    }
  }),
);

// Light, dark, or as the system is (client/theme.js set it before the first
// paint): switched in place, remembered for these pages, and followed when
// another tab or the system changes it.
type Theme = 'light' | 'dark' | 'system';
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
const chosen = (): Theme => {
  try {
    const t = localStorage.getItem('sr-theme');
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
  }
};
const showTheme = (theme: Theme) => {
  const light = theme === 'light' || (theme === 'system' && systemLight.matches);
  if (light !== (root.dataset.theme === 'light')) {
    // every colour changes at once rather than each easing on its own
    root.classList.add('theme-switching');
    if (light) root.dataset.theme = 'light';
    else delete root.dataset.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f6f5f1' : '#050507');
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', light ? 'light' : 'dark');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  }
  document.querySelectorAll<HTMLButtonElement>('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)));
};
document.querySelectorAll<HTMLElement>('[data-theme-switch]').forEach((s) => (s.hidden = false));
document.addEventListener('click', (e) => {
  const button = (e.target as Element | null)?.closest<HTMLButtonElement>('[data-theme-set]');
  if (!button) return;
  const theme = button.dataset.themeSet as Theme;
  try {
    localStorage.setItem('sr-theme', theme);
  } catch {
    /* storage may be unavailable: this page switches all the same */
  }
  showTheme(theme);
});
systemLight.addEventListener('change', () => chosen() === 'system' && showTheme('system'));
window.addEventListener('storage', (e) => e.key === 'sr-theme' && showTheme(chosen()));
showTheme(chosen());

// the HUD draws a veil once the page scrolls under it
const hud = document.querySelector<HTMLElement>('.hud');
const veil = () => hud?.classList.toggle('is-scrolled', window.scrollY > 2);
window.addEventListener('scroll', veil, { passive: true });
veil();

// back to this page from the history: the menu was left open when it was
// left, and the theme may have been switched on another page since
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (menu.isOpen()) menu.closeNow();
  showTheme(chosen());
});
