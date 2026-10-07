import Lenis from 'lenis';
import { Stage, type RingPose, type StageState } from './scene/stage';
import { Chapters } from './chapters';
import { Intro } from './intro';
import { initMenu } from './menu';
import { initAccount } from './account';
import { initScramble } from './scramble';
import { initNavRail } from './navrail';
import { detectQuality } from './quality';
import { clamp, easeInOutCubic } from './math';
import { viewW } from './viewport';

const root = document.documentElement;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Switching language loads the other page. The running scene is handed over
 * through sessionStorage so the new page starts exactly where this one was,
 * instead of replaying the intro. The inline script in Base.astro reads it
 * before the first paint.
 */
interface Handoff {
  /** Date.now() at the click */
  at: number;
  /** scene clock, in seconds */
  time: number;
  chapter: number;
  menu: boolean;
  /** activated from the keyboard, so focus should land on the switch again */
  keyboard: boolean;
  mouse: { x: number; y: number; active: boolean };
  stage?: StageState;
}

/** A jump across several chapters, in flight. */
interface Trip {
  to: number;
  /** scroll position (in chapters) where it started */
  s0: number;
  /** where the ring was; null without WebGL */
  from: RingPose | null;
}

function pad(n: number, width = 2) {
  return String(Math.floor(n)).padStart(width, '0');
}

function boot() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const handoff = (window as Window & { __srHandoff?: Handoff }).__srHandoff ?? null;

  const lenis = new Lenis({
    autoRaf: false,
    smoothWheel: !reduceMotion,
    lerp: 0.085,
    wheelMultiplier: 0.9,
    touchMultiplier: 1.15,
  });
  lenis.stop();

  const chapters = new Chapters(reduceMotion);
  chapters.measure();
  const hashIndex = chapters.indexOfHash(location.hash);
  const startAt = handoff ? clamp(Math.round(handoff.chapter) || 0, 0, chapters.count - 1) : hashIndex;

  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  let stage: Stage | null = null;
  if (canvas) {
    try {
      stage = new Stage(canvas, detectQuality());
      stage.setLayouts(chapters.layouts(), chapters.introLayout());
      if (handoff?.stage) stage.restore(handoff.stage);
    } catch (err) {
      console.warn('[spacering] WebGL unavailable, showing the static ring.', err);
      root.classList.add('no-webgl');
      stage = null;
    }
  }

  let seen = false;
  try {
    seen = sessionStorage.getItem('sr-intro') === '1';
  } catch {
    /* ignore */
  }
  const intro = new Intro({ fast: seen, instant: reduceMotion || !stage || startAt > 0 || !!handoff });

  // --------------------------------------------------------------------- HUD
  const rail = initNavRail();
  const dialItems = [...document.querySelectorAll<HTMLElement>('.dial__item')];
  const dialBead = document.querySelector<HTMLElement>('.dial__bead');
  const telTheta = document.querySelector<HTMLElement>('[data-tel="theta"]');
  const telClock = document.querySelector<HTMLElement>('[data-tel="clock"]');
  const loaderPct = document.querySelector<HTMLElement>('[data-loader-pct]');
  let activeIndex = -1;
  let lastTel = 0;
  // the scene clock carries on across a language switch
  const bootTime = performance.now() - (handoff ? Math.max(0, handoff.time * 1000 + (Date.now() - handoff.at)) : 0);

  const setActive = (index: number) => {
    if (index === activeIndex) return;
    activeIndex = index;
    root.dataset.chapter = String(index);
    dialItems.forEach((item, i) => {
      if (i === index) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    const item = dialItems[index];
    if (item && dialBead) {
      dialBead.style.setProperty('--bx', item.style.getPropertyValue('--x'));
      dialBead.style.setProperty('--by', item.style.getPropertyValue('--y'));
    }
    rail.setCurrent(index);
  };

  /** Move focus with the projection, so Tab continues inside the new chapter. */
  const focusChapter = (i: number) => {
    const heading = chapters.items[i]?.el.querySelector<HTMLElement>('h1, h2');
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  };

  let trip: Trip | null = null;
  let focusing = false;
  const endTrip = () => {
    trip = null;
    chapters.travelTo = null;
  };

  const goTo = (index: number, immediate = false, moveFocus = false) => {
    const i = clamp(Math.round(index), 0, chapters.count - 1);
    const s = lenis.scroll / chapters.unit;
    const distance = Math.abs(i - s);
    // Further than the next chapter, the jump is one move: the panels on the
    // way stay dark, the ring flies straight there, and the wheel waits.
    const jump = !immediate && !reduceMotion && distance > 1.05;
    endTrip();
    // Starting a scroll during the intro: let the scroller run now, because the
    // intro's hand-over would otherwise reset it halfway (see onDone).
    if (!intro.done && !menu.isOpen()) lenis.start();
    if (jump) {
      trip = { to: i, s0: s, from: stage?.ringPose() ?? null };
      chapters.travelTo = i;
      setActive(i);
    }
    const mine = trip;
    lenis.scrollTo(i * chapters.unit, {
      immediate,
      force: true,
      lock: jump,
      duration: immediate ? 0 : jump ? 1.2 + Math.min(distance - 1, 4) * 0.06 : 1.0 + Math.min(distance, 4) * 0.28,
      easing: easeInOutCubic,
      onComplete: () => {
        if (trip === mine) endTrip();
      },
    });
    if (moveFocus) {
      focusing = true;
      focusChapter(i);
      focusing = false;
    }
  };

  // ------------------------------------------------------------- interaction
  const menu = initMenu({ lenis, goTo, reduceMotion });
  initScramble(document, root.dataset.scramble || '');
  initAccount({
    lenis,
    menu,
    scrollable: () => intro.done && !menu.isOpen(),
    onRing: (number, fresh) => stage?.setInscription(number === null ? null : `SRN ${number}`, fresh && !reduceMotion),
  });

  intro.onUi = () => root.classList.remove('is-intro');
  intro.onHero = () => {
    chapters.enabled = true;
  };
  intro.onDone = () => {
    if (!menu.isOpen()) lenis.start();
    try {
      sessionStorage.setItem('sr-intro', '1');
    } catch {
      /* ignore */
    }
    if (startAt > 0 && !handoff) goTo(startAt, true);
  };

  document.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLElement>('[data-goto]');
    if (!link || link.closest('[data-menu]')) return;
    e.preventDefault();
    if (!intro.done) intro.skip();
    const index = Number(link.dataset.goto);
    goTo(index, false, true);
    // the hero keeps a clean address; every other chapter is a #fragment
    const href = link.getAttribute('href');
    if (index === 0) {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    } else if (href?.startsWith('#')) history.replaceState(null, '', href);
  });

  document.querySelector('[data-skip-intro]')?.addEventListener('click', () => intro.skip());
  const skipOnInput = () => {
    if (!intro.done) intro.skip();
  };
  window.addEventListener('wheel', skipOnInput, { passive: true });
  window.addEventListener('touchstart', skipOnInput, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (menu.isOpen() || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
    const current = trip ? trip.to : Math.round(lenis.scroll / chapters.unit);
    let next: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') next = current + 1;
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') next = current - 1;
    else if (e.key === ' ' && !target.closest('a, button')) next = e.shiftKey ? current - 1 : current + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = chapters.count - 1;
    if (next === null) return;
    e.preventDefault();
    if (!intro.done) intro.skip();
    goTo(next, false, true);
  });

  // Tabbing into a chapter brings it into projection.
  document.addEventListener('focusin', (e) => {
    const chapter = (e.target as Element | null)?.closest<HTMLElement>('.chapter[data-chapter]');
    if (focusing || !chapter || !intro.done) return;
    const index = Number(chapter.dataset.chapter);
    const heading = trip ? trip.to : Math.round(lenis.targetScroll / chapters.unit);
    if (index !== heading) goTo(index);
  });

  // The frosted glass lights up where the pointer touches it.
  let litPane: HTMLElement | null = null;
  let paneEvent: PointerEvent | null = null;
  let paneRaf = 0;
  const lightPane = () => {
    paneRaf = 0;
    const e = paneEvent;
    const pane = (e?.target as Element | null)?.closest<HTMLElement>('.projection') ?? null;
    if (pane !== litPane) {
      litPane?.classList.remove('is-pointer');
      pane?.classList.add('is-pointer');
      litPane = pane;
    }
    if (pane && e) {
      const r = pane.getBoundingClientRect();
      pane.style.setProperty('--mx', `${(e.clientX - r.left).toFixed(1)}px`);
      pane.style.setProperty('--my', `${(e.clientY - r.top).toFixed(1)}px`);
    }
  };

  const mouse = { x: 0, y: 0 };
  let lastMove = -1e9;
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      mouse.x = (e.clientX / viewW()) * 2 - 1;
      mouse.y = 1 - (e.clientY / window.innerHeight) * 2;
      lastMove = performance.now();
      paneEvent = e;
      if (!paneRaf) paneRaf = requestAnimationFrame(lightPane);
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    lastMove = -1e9;
    paneEvent = null;
    lightPane();
  });

  // ---------------------------------------------------------- language switch
  document.querySelectorAll<HTMLAnchorElement>('[data-lang-switch]').forEach((a) => {
    a.addEventListener('click', (e) => {
      try {
        localStorage.setItem('sr-lang', a.dataset.langSwitch || '');
      } catch {
        /* storage may be unavailable */
      }
      // a new tab or window starts fresh
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const now = performance.now();
      const state: Handoff = {
        at: Date.now(),
        time: (now - bootTime) / 1000,
        chapter: trip ? trip.to : clamp(Math.round(lenis.scroll / chapters.unit), 0, chapters.count - 1),
        menu: menu.isOpen(),
        keyboard: e.detail === 0,
        mouse: { x: mouse.x, y: mouse.y, active: now - lastMove < 2500 },
        stage: stage?.state(),
      };
      try {
        sessionStorage.setItem('sr-handoff', JSON.stringify(state));
      } catch {
        /* the next page simply plays its intro */
      }
    });
    // fetch the other page while the pointer is on its way to the switch
    const warm = () => {
      if (document.querySelector(`link[rel="prefetch"][href="${a.getAttribute('href')}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = a.getAttribute('href') || a.href;
      document.head.append(link);
    };
    a.addEventListener('pointerenter', warm, { once: true });
    a.addEventListener('focus', warm, { once: true });
  });

  // ------------------------------------------------------------------ layout
  let layoutRaf = 0;
  const relayout = () => {
    const prevUnit = chapters.unit;
    const chapter = trip ? trip.to : clamp(Math.round(lenis.targetScroll / prevUnit), 0, chapters.count - 1);
    chapters.measure();
    stage?.resize(viewW(), window.innerHeight);
    stage?.setLayouts(chapters.layouts(), chapters.introLayout());
    rail.layout();
    // The runway is measured in svh; when that changes (rotation), stay on
    // the same chapter rather than the same pixel offset.
    if (Math.abs(chapters.unit - prevUnit) > 1) {
      lenis.resize();
      goTo(chapter, true);
    }
  };
  window.addEventListener('resize', () => {
    cancelAnimationFrame(layoutRaf);
    layoutRaf = requestAnimationFrame(relayout);
  });
  document.fonts?.ready.then(relayout);

  // --------------------------------------------------------------- hand-over
  // Arriving from the other language: the chapter that was on screen is
  // already projected and settled, the HUD is in place, and the old page stays
  // on screen (see `vt-hold` in global.css) until this one has drawn itself.
  let reveal: (() => void) | null = null;
  if (handoff) {
    lenis.scrollTo(startAt * chapters.unit, { immediate: true, force: true });
    chapters.enabled = true;
    chapters.showNow(startAt);
    setActive(startAt);
    // their entrance animations already played on the other page
    for (const anim of chapters.items[startAt]?.el.getAnimations({ subtree: true }) ?? []) {
      if (anim.effect?.getTiming().iterations !== Infinity) anim.finish();
    }
    if (startAt > 0) history.replaceState(null, '', `#${chapters.items[startAt].el.id}`);
    mouse.x = handoff.mouse.x;
    mouse.y = handoff.mouse.y;
    if (handoff.mouse.active) lastMove = performance.now();
    // Focus goes back where it was: the switch for keyboard users, otherwise
    // the menu itself (if it was open) so Tab and Escape keep working.
    let refocus: HTMLElement | null = null;
    if (handoff.menu) {
      const menuEl = document.querySelector<HTMLElement>('[data-menu]');
      menuEl?.setAttribute('tabindex', '-1');
      refocus = (handoff.keyboard ? menuEl?.querySelector<HTMLElement>('[data-lang-switch]') : menuEl) ?? null;
      menu.openNow(refocus);
    } else if (handoff.keyboard) {
      refocus = document.querySelector<HTMLElement>('.hud [data-lang-switch]');
      refocus?.focus({ preventScroll: true });
    }
    // Text set in a fallback face would reflow when the web fonts arrive, so
    // hold the old page a moment longer for them (they are in the cache).
    const fonts = Promise.race([
      Promise.all(
        ['300 1em "Jost Variable"', '400 1em "IBM Plex Mono"', '500 1em "IBM Plex Mono"'].map((f) => document.fonts?.load(f)),
      ).catch(() => {}),
      new Promise((done) => setTimeout(done, 450)),
    ]);
    reveal = () => {
      fonts.then(() => {
        relayout();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            root.classList.remove('vt-hold');
            requestAnimationFrame(() => {
              root.classList.remove('is-handoff');
              // Chrome can drop focus set while the page was still held back
              if (refocus && document.activeElement !== refocus) refocus.focus({ preventScroll: true });
            });
          }),
        );
      });
    };
  }

  // ---------------------------------------------------------------- snapping
  let lastScrollAt = 0;
  let lastDir = 1;
  lenis.on('scroll', (l: Lenis) => {
    lastScrollAt = performance.now();
    if (l.direction) lastDir = l.direction;
  });

  const snap = (now: number) => {
    if (!intro.done || menu.isOpen() || trip || lenis.isScrolling || now - lastScrollAt < 170) return;
    const s = lenis.scroll / chapters.unit;
    const base = Math.floor(s);
    const frac = s - base;
    if (frac < 0.003 || frac > 0.997) return;
    const target = lastDir > 0 ? (frac > 0.16 ? base + 1 : base) : frac < 0.84 ? base : base + 1;
    goTo(target);
  };

  // -------------------------------------------------------------------- loop
  stage?.warmup();
  if (!intro.done && intro.t === 0 && !handoff) window.scrollTo(0, 0);

  let last = performance.now();
  // While the menu covers the page the scene stops drawing. The frame drawn as
  // the menu opens becomes the blurred still behind it.
  let menuWasOpen = false;
  let sceneHidden = false;
  const frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    lenis.raf(now);
    let s = lenis.scroll / chapters.unit;
    // Something stopped a jump on its way (a reset of the scroller can also
    // leave it reporting a native scroll that never ends): carry on from
    // wherever the ring is now.
    if (trip && lenis.isScrolling !== 'smooth') {
      if (Math.abs(s - trip.to) < 0.01) endTrip();
      else {
        goTo(trip.to);
        s = lenis.scroll / chapters.unit;
      }
    }
    const state = intro.update(dt);
    const projection = chapters.update(s, dt, lenis.targetScroll / chapters.unit);
    const travel = trip?.from
      ? { from: trip.from, to: trip.to, t: trip.to === trip.s0 ? 1 : clamp((s - trip.s0) / (trip.to - trip.s0)) }
      : null;
    const opened = menu.isOpen() && !menuWasOpen;
    menuWasOpen = menu.isOpen();
    const hidden = menu.covers();
    if (stage && (!hidden || opened)) {
      // the menu's opening and closing frames say nothing about the scene's own cost
      if (opened || sceneHidden) stage.resetFrameStats();
      stage.update({
        dt,
        time: (now - bootTime) / 1000,
        s,
        travel,
        mouse: { x: mouse.x, y: mouse.y, active: now - lastMove < 2500 },
        intro: state,
        projection,
        reduceMotion,
      });
      if (opened) menu.capture(stage.canvas);
    }
    sceneHidden = hidden;
    if (intro.done || chapters.enabled) setActive(trip ? trip.to : clamp(Math.round(s), 0, chapters.count - 1));
    snap(now);
    if (reveal) {
      reveal();
      reveal = null;
    }

    if (now - lastTel > 120) {
      lastTel = now;
      if (telTheta && stage) telTheta.textContent = `${stage.thetaDeg.toFixed(1).padStart(5, '0')}°`;
      if (telClock) {
        const t = (now - bootTime) / 1000;
        telClock.textContent = `${pad(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)}`;
      }
      if (loaderPct && !intro.done) loaderPct.textContent = pad(intro.calibration * 100, 3);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
