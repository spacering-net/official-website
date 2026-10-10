/**
 * Light, dark, or as the system is, on every page: chosen with a switch
 * (ThemeSwitch.astro), remembered for the whole site (sr-theme), and followed
 * when another tab or the system changes it. client/theme.js applies the
 * choice before a page's first paint; this switches it in place.
 */
export type Theme = 'light' | 'dark' | 'system';

const root = document.documentElement;
const systemLight = window.matchMedia('(prefers-color-scheme: light)');

export function chosenTheme(): Theme {
  try {
    const t = localStorage.getItem('sr-theme');
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Show the switches and keep the page in the chosen theme. `onChange` hears
 * each turn to light (true) or dark: the homepage's scene is drawn, not
 * styled, so it has to be told.
 */
export function initTheme(onChange?: (light: boolean) => void) {
  const show = (theme: Theme) => {
    const light = theme === 'light' || (theme === 'system' && systemLight.matches);
    if (light !== (root.dataset.theme === 'light')) {
      // every colour changes at once rather than each easing on its own
      root.classList.add('theme-switching');
      if (light) root.dataset.theme = 'light';
      else delete root.dataset.theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f6f5f1' : '#050507');
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', light ? 'light' : 'dark');
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
      onChange?.(light);
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
    show(theme);
  });
  systemLight.addEventListener('change', () => chosenTheme() === 'system' && show('system'));
  window.addEventListener('storage', (e) => e.key === 'sr-theme' && show(chosenTheme()));
  // back to this page from the history: the theme may have been switched elsewhere since
  window.addEventListener('pageshow', (e) => e.persisted && show(chosenTheme()));
  show(chosenTheme());
}
