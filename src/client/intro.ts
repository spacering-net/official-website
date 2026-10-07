import type { IntroState } from './scene/stage';
import { easeInCubic, easeInOutCubic, easeOutCubic, lerp, span } from './math';

/** Moment of the "diamond ring" flash, in seconds from the start. */
const FLASH = 1.9;
const UI_AT = 3.0;
const HERO_AT = 3.15;
export const INTRO_END = 4.4;

/**
 * Totality → diamond ring. Construction lines calibrate the orbit, the ring
 * appears as a silhouette against its corona, then the node flashes and the
 * light reveals the band while the orbit field unfurls from the node.
 */
export function introState(t: number, done: boolean): IntroState {
  const stars = easeOutCubic(span(0, 1.5, t));
  const nebula = easeOutCubic(span(0.3, 2.6, t));
  const construct = easeInOutCubic(span(0.15, 1.45, t));
  const constructAlpha = span(0.05, 0.3, t) * (1 - span(FLASH, FLASH + 0.55, t));
  const corona =
    t < FLASH ? easeInCubic(span(0.55, FLASH, t)) * 1.5 : lerp(1.5, 0.13, easeInOutCubic(span(FLASH + 0.1, FLASH + 1.8, t)));
  const glint = Math.pow(span(1.45, FLASH, t), 2) * 0.22;
  const flash = t < FLASH ? 0 : t < FLASH + 0.07 ? (t - FLASH) / 0.07 : Math.exp(-(t - FLASH - 0.07) * 4.2);
  const settle = t > FLASH ? lerp(0, 1.15, span(FLASH, FLASH + 1.2, t)) : 0;
  const bead = Math.max(glint, flash * 6.5, settle);
  const spike = t < FLASH ? 0.04 : 0.12 + 0.95 * Math.exp(-(t - FLASH) * 1.6);
  const env = easeOutCubic(span(FLASH + 0.05, FLASH + 1.5, t));
  const birth = span(FLASH + 0.05, FLASH + 2.35, t);
  const exposure = 1 + 0.3 * Math.exp(-Math.pow((t - FLASH - 0.08) / 0.18, 2));
  const ca = 0.006 + 0.05 * Math.exp(-Math.pow((t - FLASH - 0.05) / 0.25, 2));
  const pose = easeInOutCubic(span(FLASH + 0.6, FLASH + 2.4, t));
  return { stars, nebula, construct, constructAlpha, corona, bead, spike, env, birth, exposure, ca, pose, done };
}

export class Intro {
  t = 0;
  speed = 1;
  done = false;
  private uiFired = false;
  private heroFired = false;
  onUi?: () => void;
  onHero?: () => void;
  onDone?: () => void;

  constructor(opts: { fast: boolean; instant: boolean }) {
    if (opts.fast) this.speed = 2;
    if (opts.instant) this.t = INTRO_END;
  }

  /** Fast-forward rather than cut, so the flash still reads. */
  skip() {
    if (!this.done) this.speed = Math.max(this.speed, 5);
  }

  /** Progress of the calibration drawing, for the loader readout. */
  get calibration() {
    return span(0.15, 1.45, this.t);
  }

  update(dt: number): IntroState {
    if (!this.done) {
      this.t = Math.min(INTRO_END, this.t + dt * this.speed);
      if (!this.uiFired && this.t >= UI_AT) {
        this.uiFired = true;
        this.onUi?.();
      }
      if (!this.heroFired && this.t >= HERO_AT) {
        this.heroFired = true;
        this.onHero?.();
      }
      if (this.t >= INTRO_END) {
        this.done = true;
        this.onDone?.();
      }
    }
    return introState(this.t, this.done);
  }
}
