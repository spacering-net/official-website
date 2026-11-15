import { CHAPTER_IDS, PAGES, type Dict } from '../i18n';

export interface HudLink {
  label: string;
  href: string;
  /** on the homepage, the chapter it scrolls to instead */
  goto?: number;
  current?: 'page';
}

/**
 * The HUD's links, the same in its nav and in the narrow screens' menu.
 * Space, the assistant, Harness and open source open their pages (PAGES);
 * the ring opens the homepage, at its top (scrolled to, on the homepage).
 * The current page's link is marked: on the homepage the ring's, whichever
 * chapter is projected (the dial follows the chapters).
 */
export function hudLinks(t: Dict, page?: { current?: keyof typeof PAGES }): HudLink[] {
  const last = CHAPTER_IDS.length - 1;
  const link = (key: string, at: number) => {
    const own = PAGES[key as keyof typeof PAGES];
    if (own) return { href: `${t.path}${own}`, current: page?.current === key ? ('page' as const) : undefined };
    if (page) return { href: at === 0 ? t.path : `${t.path}#${key}` };
    return { href: `#${key}`, goto: at, current: at === 0 ? ('page' as const) : undefined };
  };
  return [
    { label: t.nav.ring, ...link(CHAPTER_IDS[0], 0) },
    ...(['space', 'assistant', 'harness'] as const).map((key) => ({ label: t.nav[key], ...link(key, CHAPTER_IDS.indexOf(key)) })),
    { label: t.nav.openSource, ...link(CHAPTER_IDS[last], last) },
  ];
}
