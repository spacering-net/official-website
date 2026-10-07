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

// the HUD draws a veil once the page scrolls under it
const hud = document.querySelector<HTMLElement>('.hud');
const veil = () => hud?.classList.toggle('is-scrolled', window.scrollY > 2);
window.addEventListener('scroll', veil, { passive: true });
veil();

// back to this page from the history: the menu was left open when it was left
window.addEventListener('pageshow', (e) => {
  if (e.persisted && menu.isOpen()) menu.closeNow();
});
