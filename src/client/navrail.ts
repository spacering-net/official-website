/**
 * The HUD's orbit rail: a shallow arc under the nav links. A node slides
 * along it to the hovered link, and rests on the link to the page itself
 * (Hud.astro; the ring's on the homepage).
 */
export function initNavRail() {
  const nav = document.querySelector<HTMLElement>('.nav');
  const rail = nav?.querySelector<SVGSVGElement>('.nav__rail');
  const path = rail?.querySelector('path');
  const dot = nav?.querySelector<HTMLElement>('.nav__dot');
  if (!nav || !rail || !path || !dot) return { layout: () => {} };
  const links = [...nav.querySelectorAll<HTMLAnchorElement>('.nav__link')];
  const PAD = 13;
  const DEPTH = 18;
  let width = 0;
  const current = links.find((l) => l.getAttribute('aria-current') === 'page') ?? null;
  let hovering: HTMLAnchorElement | null = null;

  const curveY = (t: number) => (1 - t) * (1 - t) * 2 + 2 * (1 - t) * t * DEPTH + t * t * 2;

  const layout = () => {
    width = nav.clientWidth + PAD * 2;
    rail.setAttribute('viewBox', `0 0 ${width} 16`);
    rail.setAttribute('width', String(width));
    rail.setAttribute('height', '16');
    path.setAttribute('d', `M0 2 Q${width / 2} ${DEPTH} ${width} 2`);
    place(hovering ?? current);
  };

  const place = (link: HTMLAnchorElement | null) => {
    if (!link || !width) {
      dot.classList.remove('is-on');
      return;
    }
    const nb = nav.getBoundingClientRect();
    const lb = link.getBoundingClientRect();
    const x = lb.left + lb.width / 2 - nb.left;
    const t = (x + PAD) / width;
    dot.style.setProperty('--x', `${x}px`);
    dot.style.setProperty('--y', `${nav.clientHeight - 2 + curveY(t)}px`);
    dot.classList.add('is-on');
  };

  links.forEach((link) => {
    link.addEventListener('pointerenter', () => {
      hovering = link;
      place(link);
    });
    link.addEventListener('pointerleave', () => {
      hovering = null;
      place(current);
    });
  });

  layout();
  return { layout };
}
