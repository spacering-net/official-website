import type { Projection, RingLayout } from './scene/stage';
import { clamp, easeInOutSine, easeOutCubic, lerp } from './math';
import { viewW } from './viewport';

type Side = 'left' | 'right' | 'center';
type Mode = 'idle' | 'in' | 'out';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Chapter {
  index: number;
  el: HTMLElement;
  target: HTMLElement;
  side: Side;
  shown: boolean;
  mode: Mode;
  t: number;
  scan: number;
  glass: number;
  settle: number;
  outFrom: { scan: number; glass: number; intensity: number };
  rect: Rect;
  written: string;
}

/** Orbit-field band highlighted for each chapter (ring-local radius, 0 = none). */
const BANDS = [0, 1.45, 1.8, 2.1, 2.4, 2.75, 3.15, 0];
const IN_DURATION = 1.15;
const OUT_DURATION = 0.42;
const SETTLE_DURATION = 0.9;
const PERSISTENT_BEAM = 0.34;

export class Chapters {
  readonly items: Chapter[];
  unit = window.innerHeight;
  mobile = false;
  /** Scroll-driven reveals start once the intro hands over. */
  enabled = false;
  /**
   * Destination of a jump across several chapters. While it is set, only that
   * chapter may project; the ones the scroll passes on the way stay dark.
   */
  travelTo: number | null = null;
  private probe: HTMLElement | null;

  constructor(private reduceMotion: boolean) {
    this.probe = document.querySelector('.svh-probe');
    this.items = [...document.querySelectorAll<HTMLElement>('.chapter[data-chapter]')].map((el, index) => ({
      index,
      el,
      target: el.querySelector<HTMLElement>('[data-projection]') ?? el,
      side: (el.dataset.side as Side) || 'left',
      shown: false,
      mode: 'idle',
      t: 0,
      scan: 0,
      glass: 0,
      settle: 1,
      outFrom: { scan: 0, glass: 0, intensity: 0 },
      rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      written: '',
    }));
  }

  get count() {
    return this.items.length;
  }

  indexOfHash(hash: string): number {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id) return -1;
    return this.items.findIndex((c) => c.el.id === id);
  }

  measure() {
    this.unit = this.probe?.getBoundingClientRect().height || window.innerHeight;
    this.mobile = window.matchMedia('(max-width: 760px)').matches;
    for (const c of this.items) {
      const r = c.target.getBoundingClientRect();
      c.rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
  }

  private hudHeight() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hud-h')) || 76;
  }

  /** Ring placement per chapter, always in the space the panel leaves free. */
  layouts(): RingLayout[] {
    const vw = viewW();
    const vh = window.innerHeight;
    const hud = this.hudHeight();
    const dial = vw > 1100 ? 110 : 0;
    return this.items.map((c, i) => {
      const r = c.rect;
      const band = BANDS[i] ?? 0;
      if (this.mobile) {
        const top = hud;
        const free = Math.max(r.top - 10 - top, vh * 0.18);
        const roll = i === 0 ? -30 : i % 2 ? 24 : -24;
        return { x: vw / 2, y: top + free * 0.5, r: Math.min(vw * 0.3, free * 0.4), roll, band };
      }
      if (i === 0) {
        return { x: vw * 0.64, y: vh * 0.43, r: Math.min(vw * 0.2, vh * 0.27), roll: -30, band };
      }
      if (c.side === 'center') {
        const free = Math.max(r.top - hud, vh * 0.2);
        return { x: vw / 2, y: hud + free * 0.5, r: Math.min(vw * 0.17, free * 0.4), roll: 0, band };
      }
      if (c.side === 'left') {
        const left = r.right;
        const right = vw - dial;
        return { x: (left + right) / 2, y: vh * 0.46, r: Math.min((right - left) * 0.3, vh * 0.26), roll: -30, band };
      }
      const right = r.left;
      return { x: right / 2, y: vh * 0.46, r: Math.min(right * 0.3, vh * 0.26), roll: 30, band };
    });
  }

  /** The centred "logo moment" at the start of the intro. */
  introLayout(): RingLayout {
    const vw = viewW();
    const vh = window.innerHeight;
    if (this.mobile) return { x: vw / 2, y: vh * 0.42, r: Math.min(vw * 0.36, vh * 0.22), roll: -30, band: 0 };
    return { x: vw / 2, y: vh * 0.47, r: Math.min(vw * 0.25, vh * 0.29), roll: -30, band: 0 };
  }

  private dir(c: Chapter): Projection['dir'] {
    if (this.mobile || c.side === 'center') return 'ttb';
    return c.side === 'left' ? 'rtl' : 'ltr';
  }

  private start(c: Chapter, mode: Mode) {
    if (mode === 'in') {
      c.shown = true;
      c.mode = 'in';
      c.t = 0;
      c.settle = 0;
      c.el.classList.add('is-shown');
    } else {
      c.outFrom = { scan: c.scan, glass: c.glass, intensity: this.beamBody(c) };
      c.mode = 'out';
      c.t = 0;
    }
    // while the scan runs, the masked content gets its own layer (see home.css)
    c.el.classList.add('is-scanning');
  }

  /** Show a chapter as if its projection had already played and settled. */
  showNow(index: number) {
    const c = this.items[index];
    if (!c) return;
    c.shown = true;
    c.mode = 'idle';
    c.t = 0;
    c.scan = 1;
    c.glass = 1;
    c.settle = 1;
    c.el.classList.add('is-shown');
    c.el.classList.remove('is-scanning');
    this.write(c, 0, 0);
  }

  private write(c: Chapter, ca: number, scanActive: number) {
    const css = `${c.scan.toFixed(4)}|${c.glass.toFixed(3)}|${ca.toFixed(3)}|${scanActive.toFixed(3)}`;
    if (css === c.written) return;
    c.written = css;
    const st = c.el.style;
    st.setProperty('--scan', c.scan.toFixed(4));
    st.setProperty('--glass-in', c.glass.toFixed(3));
    st.setProperty('--ca', ca.toFixed(3));
    st.setProperty('--scan-active', scanActive.toFixed(3));
  }

  private beamBody(c: Chapter): number {
    if (!c.shown) return 0;
    const persistent = c.index === 0 ? 0 : PERSISTENT_BEAM;
    if (c.mode === 'in') return 0.9;
    if (c.mode === 'out') return c.outFrom.intensity * (1 - clamp(c.t / OUT_DURATION));
    return lerp(0.9, persistent, easeOutCubic(c.settle));
  }

  /**
   * `s` is the scroll position in chapters; `aim` is where the scroll is
   * heading (Lenis's wheel target), so a fast flick does not flash every
   * chapter it passes.
   */
  update(s: number, dt: number, aim = s): Projection | null {
    let best: Chapter | null = null;
    for (const c of this.items) {
      const d = Math.abs(s - c.index);
      if (this.enabled) {
        if (this.travelTo !== null && c.index !== this.travelTo) {
          // a jump is passing through: whatever is up retracts at once
          if (c.shown && c.mode !== 'out') this.start(c, 'out');
        } else if (!c.shown && d < 0.3 && Math.abs(aim - c.index) < 0.6) this.start(c, 'in');
        else if (c.shown && c.mode !== 'out' && d > 0.38) this.start(c, 'out');
      }
      if (!c.shown) continue;

      let ca = 0;
      let scanActive = 0;
      if (c.mode === 'in') {
        c.t += dt;
        const dur = this.reduceMotion ? 0.001 : IN_DURATION;
        const k = clamp(c.t / dur);
        c.scan = easeInOutSine(k);
        c.glass = easeOutCubic(clamp(k / 0.22));
        ca = 1 - easeOutCubic(k);
        scanActive = clamp((1 - k) / 0.08);
        if (k >= 1) {
          c.mode = 'idle';
          c.t = 0;
          c.el.classList.remove('is-scanning');
        }
      } else if (c.mode === 'out') {
        c.t += dt;
        const dur = this.reduceMotion ? 0.001 : OUT_DURATION;
        const k = clamp(c.t / dur);
        c.scan = c.outFrom.scan * (1 - k);
        c.glass = c.outFrom.glass * (1 - easeOutCubic(k));
        if (k >= 1) {
          c.shown = false;
          c.mode = 'idle';
          c.scan = 0;
          c.glass = 0;
          c.el.classList.remove('is-shown', 'is-scanning');
        }
      } else {
        c.settle = clamp(c.settle + dt / SETTLE_DURATION);
      }

      this.write(c, ca, scanActive);

      if (c.shown && (!best || (c.mode === 'in' && best.mode !== 'in') || Math.abs(s - c.index) < Math.abs(s - best.index))) {
        best = c;
      }
    }

    if (!best) return null;
    const d = Math.abs(s - best.index);
    const gate = 1 - clamp((d - 0.1) / 0.2);
    const front = best.mode === 'in' && !this.reduceMotion ? clamp((1 - clamp(best.t / IN_DURATION)) / 0.08) : 0;
    return {
      rect: best.rect,
      dir: this.dir(best),
      scan: best.scan,
      intensity: this.beamBody(best) * gate * (this.reduceMotion ? 0.6 : 1),
      front: front * gate,
    };
  }
}
