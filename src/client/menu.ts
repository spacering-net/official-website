import type Lenis from 'lenis';

interface MenuOptions {
  lenis: Lenis;
  goTo: (index: number, immediate?: boolean, moveFocus?: boolean) => void;
  reduceMotion: boolean;
}

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

/**
 * The orbit menu: opens as an aperture from the menu button. Destinations on
 * the left; on the right an orbit chart in the logo's construction language,
 * where each project is a node on its own orbit.
 */
export function initMenu({ lenis, goTo, reduceMotion }: MenuOptions) {
  const menu = document.querySelector<HTMLElement>('[data-menu]');
  const opener = document.querySelector<HTMLButtonElement>('[data-menu-open]');
  if (!menu || !opener)
    return { isOpen: () => false, covers: () => false, capture: () => {}, openNow: () => {}, closeNow: (after?: () => void) => after?.() };
  const closer = menu.querySelector<HTMLButtonElement>('[data-menu-close]');
  const backdrop = menu.querySelector<HTMLCanvasElement>('[data-menu-backdrop]');
  const chart = menu.querySelector<SVGSVGElement>('.orrery');
  const bodies = [...menu.querySelectorAll<SVGGElement>('.orrery__body')];
  const root = document.documentElement;
  let open = false;
  let anim: Animation | null = null;
  let raf = 0;
  let last = 0;
  const angles = bodies.map((b) => Number(b.dataset.a0 || 0));
  // While the menu is open the rest of the page is inert: no stray focus or clicks.
  const background = [...document.body.children].filter((el): el is HTMLElement => el !== menu && el instanceof HTMLElement);
  const setInert = (on: boolean) => background.forEach((el) => (el.inert = on));

  const placeBodies = (dt: number) => {
    bodies.forEach((b, i) => {
      const r = Number(b.dataset.r || 100);
      const omega = reduceMotion ? 0 : 0.42 * Math.pow(r / 90, -1.5);
      angles[i] += omega * dt;
      const x = r * Math.cos(angles[i]);
      const y = r * COS30 * Math.sin(angles[i]);
      b.setAttribute('transform', `translate(${(x * COS30 - y * SIN30).toFixed(2)} ${(x * SIN30 + y * COS30).toFixed(2)})`);
    });
  };

  const loop = (now: number) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    placeBodies(dt);
    raf = requestAnimationFrame(loop);
  };

  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => el.offsetParent !== null);

  const setOpen = (next: boolean, after?: () => void, instant = false, focus?: HTMLElement | null) => {
    if (next === open) {
      after?.();
      return;
    }
    open = next;
    const b = opener.getBoundingClientRect();
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const far = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 20;
    const closed = `circle(0px at ${cx}px ${cy}px)`;
    const opened = `circle(${far}px at ${cx}px ${cy}px)`;
    anim?.cancel();
    menu.classList.add('is-animating');
    opener.setAttribute('aria-expanded', String(next));

    if (next) {
      menu.classList.add('is-open');
      root.classList.add('menu-open');
      setInert(true);
      lenis.stop();
      last = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
      // focus moves in at once, so Tab and Escape work while the aperture opens
      (focus ?? menu.querySelector<HTMLElement>('.menu-link'))?.focus({ preventScroll: true });
    } else {
      menu.classList.remove('is-open');
    }

    anim = menu.animate([{ clipPath: next ? closed : opened }, { clipPath: next ? opened : closed }], {
      duration: reduceMotion || instant ? 1 : next ? 780 : 520,
      easing: next ? 'cubic-bezier(0.72, 0, 0.18, 1)' : 'cubic-bezier(0.6, 0, 0.4, 1)',
      fill: 'forwards',
    });
    anim.onfinish = () => {
      menu.classList.remove('is-animating');
      if (!next) {
        root.classList.remove('menu-open');
        cancelAnimationFrame(raf);
        lenis.start();
        setInert(false);
        opener.focus({ preventScroll: true });
        after?.();
      }
    };
  };

  opener.addEventListener('click', () => setOpen(true));
  closer?.addEventListener('click', () => setOpen(false));

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      first.focus();
    }
  });

  menu.querySelectorAll<HTMLElement>('[data-goto]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const index = Number(link.dataset.goto);
      const href = link.getAttribute('href');
      setOpen(false, () => {
        goTo(index, false, true);
        if (href?.startsWith('#')) history.replaceState(null, '', href);
      });
    });
  });

  // Hovering a destination lights its orbit, node and label in the chart.
  const lit = (key: string | null) => {
    if (key) chart?.setAttribute('data-active', key);
    else chart?.removeAttribute('data-active');
    chart?.querySelectorAll<SVGElement>('[data-key]').forEach((el) => el.classList.toggle('is-active', el.dataset.key === key));
  };
  menu.querySelectorAll<HTMLElement>('[data-node]').forEach((link) => {
    const on = () => lit(link.dataset.node || null);
    const off = () => lit(null);
    link.addEventListener('pointerenter', on);
    link.addEventListener('focus', on);
    link.addEventListener('pointerleave', off);
    link.addEventListener('blur', off);
  });

  placeBodies(0);
  return {
    isOpen: () => open,
    /** Open and done opening: nothing behind the menu can be seen. */
    covers: () => open && !menu.classList.contains('is-animating'),
    /**
     * Keep a blurred still of the scene to show faintly through the menu. Call
     * it straight after a frame is drawn, while the canvas still holds it.
     */
    capture: (scene: HTMLCanvasElement) => {
      const g = backdrop?.getContext('2d');
      if (!backdrop || !g) return;
      backdrop.width = Math.max(1, Math.round(innerWidth / 8));
      backdrop.height = Math.max(1, Math.round(innerHeight / 8));
      g.filter = 'blur(3px)';
      g.drawImage(scene, 0, 0, backdrop.width, backdrop.height);
    },
    /** Open without the aperture, as the page that was just left had it. */
    openNow: (focus?: HTMLElement | null) => setOpen(true, undefined, true, focus ?? null),
    /** Close without the aperture, e.g. to make way for the account dialog; `after` runs once it is closed. */
    closeNow: (after?: () => void) => setOpen(false, after, true),
  };
}
