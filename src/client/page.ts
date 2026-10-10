import { initAccount } from './account';
import { initMenu, type ScrollLock } from './menu';
import { initNavRail } from './navrail';
import { initScramble } from './scramble';
import { initTheme } from './theme-switch';

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

// light, dark or as the system is (client/theme-switch.ts)
initTheme();

// At the page's top the HUD is the homepage's, its ends at the window's edges;
// once the page scrolls under it, they gather into the column over a veil,
// and part again back at the top (site.css). The page opens with the HUD as
// it finds it, and the HUD eases between the two from the next frame on.
const hud = document.querySelector<HTMLElement>('.hud');
const dock = () => hud?.classList.toggle('is-scrolled', window.scrollY > 2);
window.addEventListener('scroll', dock, { passive: true });
dock();
requestAnimationFrame(() => requestAnimationFrame(() => hud?.classList.add('is-eased')));

// back to this page from the history: the menu was left open when it was left
window.addEventListener('pageshow', (e) => {
  if (e.persisted && menu.isOpen()) menu.closeNow();
});
