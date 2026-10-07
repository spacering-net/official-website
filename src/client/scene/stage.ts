import * as THREE from 'three';
import type { QualityProfile } from '../quality';
import { clamp, damp, DEG, easeInOutCubic, lerp, smootherstep } from '../math';
import { createEnvironment } from './environment';
import { createRing, RING } from './ring';
import { createDisk } from './disk';
import { createStars } from './stars';
import { createNebula } from './nebula';
import { createCorona } from './corona';
import { createBeam } from './beam';
import { createGlow } from './glow';
import { createConstruction } from './construction';
import { createPost } from './post';
import { viewW } from '../viewport';

/** Where the ring sits for one chapter, in CSS pixels, plus its in-plane roll. */
export interface RingLayout {
  x: number;
  y: number;
  /** projected outer radius in px */
  r: number;
  /** degrees; −30 puts the node at the lower left (the logo pose) */
  roll: number;
  /** orbit-field band to brighten, ring-local radius (0 = none) */
  band: number;
}

/** The ring's placement in one frame, as a jump can start from it. */
export interface RingPose extends RingLayout {
  /** how brightly `band` is lit, 0–1 */
  bandAmt: number;
  /** spin about the ring's own axis, in turns */
  turns: number;
}

/** A jump across several chapters, played as one move from `from` to chapter `to`. */
export interface Travel {
  from: RingPose;
  to: number;
  /** 0 → 1 */
  t: number;
}

/** What a freshly loaded page needs to carry on from this one (see main.ts). */
export interface StageState {
  phase: number;
  mx: number;
  my: number;
  mouseAmt: number;
  dpr: number;
}

export interface Projection {
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  dir: 'rtl' | 'ltr' | 'ttb';
  scan: number;
  intensity: number;
  front: number;
}

export interface IntroState {
  stars: number;
  nebula: number;
  construct: number;
  constructAlpha: number;
  corona: number;
  bead: number;
  spike: number;
  env: number;
  birth: number;
  exposure: number;
  ca: number;
  pose: number;
  done: boolean;
}

export interface FrameInput {
  dt: number;
  time: number;
  s: number;
  /** a multi-chapter jump in progress; overrides `s` for the ring's placement */
  travel: Travel | null;
  mouse: { x: number; y: number; active: boolean };
  intro: IntroState;
  projection: Projection | null;
  reduceMotion: boolean;
}

const CAM_DIST = 11;
const FOV = 28;
const TILT = 60 * DEG; // ring plane at 30° to the picture plane → ellipses with b/a = cos30°

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private pose = new THREE.Group();
  private spin = new THREE.Group();
  private ring: ReturnType<typeof createRing>;
  private disk: ReturnType<typeof createDisk>;
  private stars: ReturnType<typeof createStars>;
  private nebula: ReturnType<typeof createNebula>;
  private corona: ReturnType<typeof createCorona>;
  private beam: ReturnType<typeof createBeam>;
  private glow: ReturnType<typeof createGlow>;
  private construction: ReturnType<typeof createConstruction>;
  private post: ReturnType<typeof createPost>;

  private layouts: RingLayout[] = [];
  private introLayout: RingLayout = { x: 0, y: 0, r: 100, roll: -30, band: 0 };
  private vw = 1;
  private vh = 1;
  private dpr: number;
  private phase = 0;
  private mouse = new THREE.Vector2();
  private pointer = new THREE.Vector2();
  private mouseAmt = 0;
  private beadBoost = 0;
  private lastScan = 0;
  /** the last second of frame times, for adapt() */
  private frameTimes = new Float32Array(60);
  private frameCount = 0;
  private posed: RingPose = { x: 0, y: 0, r: 100, roll: -30, band: 0, bandAmt: 0, turns: 0 };
  /** The inscription inside the band: shown 0–1, burn-in progress, and whether its lettering is drawn. */
  private ink = { target: 0, amount: 0, reveal: 2, burning: false, ready: false };

  // scratch objects, reused every frame
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private q1 = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private e1 = new THREE.Euler();
  private xAxis = new THREE.Vector3(1, 0, 0);
  private zAxis = new THREE.Vector3(0, 0, 1);
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane();
  private posA = new THREE.Vector3();
  private posB = new THREE.Vector3();

  /** Read by the telemetry readout. */
  thetaDeg = 30;

  constructor(
    canvas: HTMLCanvasElement,
    private quality: QualityProfile,
  ) {
    this.dpr = quality.dpr;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(viewW(), window.innerHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(0x050507, 1);
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(FOV, viewW() / window.innerHeight, 0.1, 400);
    this.camera.position.set(0, 0, CAM_DIST);

    const env = createEnvironment(renderer);
    this.ring = createRing(env, quality.ringSegments, quality.tier !== 'low');
    this.ring.bake(renderer);
    this.disk = createDisk(quality.particles, CAM_DIST);
    this.stars = createStars(quality.stars);
    this.nebula = createNebula();
    this.corona = createCorona();
    this.beam = createBeam();
    this.glow = createGlow();
    this.construction = createConstruction();

    this.scene.add(this.nebula.mesh, this.stars.points, this.pose);
    this.pose.add(this.corona.mesh, this.spin, this.disk.points, this.construction.lines);
    this.spin.add(this.ring.mesh);
    this.scene.add(this.beam.mesh, this.beam.dust, this.glow.mesh);

    this.post = createPost(renderer, this.scene, this.camera, quality.samples);
    this.resize(viewW(), window.innerHeight);

    // Profiling switches, e.g. ?off=bloom,nebula,glow
    const off = new URLSearchParams(location.search).get('off')?.split(',') ?? [];
    if (off.includes('bloom')) this.post.bloom.enabled = false;
    if (off.includes('final')) this.post.final.enabled = false;
    if (off.includes('nebula')) this.nebula.mesh.visible = false;
    if (off.includes('corona')) this.corona.mesh.visible = false;
    if (off.includes('disk')) this.disk.points.visible = false;
    if (off.includes('glow')) this.glow.mesh.visible = false;
    if (off.includes('stars')) this.stars.points.visible = false;
    if (off.includes('iri')) this.ring.mesh.material.iridescence = 0;
    if (off.includes('ring')) this.ring.mesh.visible = false;
  }

  setLayouts(layouts: RingLayout[], intro: RingLayout) {
    this.layouts = layouts;
    this.introLayout = intro;
  }

  resize(vw: number, vh: number) {
    const sizeChanged = vw !== this.vw || vh !== this.vh;
    this.vw = Math.max(1, vw);
    this.vh = Math.max(1, vh);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.vw, this.vh, false);
    // At high pixel ratios the extra pixels already smooth edges, and the
    // bloom blur loses nothing at half resolution.
    this.post.setSamples(this.dpr >= 1.75 ? 0 : this.quality.samples);
    this.post.setBloomScale(this.dpr > 1.25 ? 0.5 : 1);
    this.post.composer.setPixelRatio(this.dpr);
    this.post.composer.setSize(this.vw, this.vh);
    if (sizeChanged) this.nebula.bake(this.renderer, this.vw, this.vh);
    this.post.final.uniforms.uRes.value.set(this.vw * this.dpr, this.vh * this.dpr);
    this.camera.aspect = this.vw / this.vh;
    this.camera.updateProjectionMatrix();
    this.disk.uniforms.uPx.value = this.dpr;
    this.stars.uniforms.uPx.value = this.dpr;
    this.beam.dustUniforms.uPx.value = this.dpr;
  }

  /** Where the ring is right now, for a jump to start from. */
  ringPose(): RingPose {
    return { ...this.posed };
  }

  /** Running state a page switch hands to the next page. */
  state(): StageState {
    return { phase: this.phase, mx: this.mouse.x, my: this.mouse.y, mouseAmt: this.mouseAmt, dpr: this.dpr };
  }

  restore(st: Partial<StageState>) {
    if (Number.isFinite(st.phase)) this.phase = st.phase!;
    if (Number.isFinite(st.mx) && Number.isFinite(st.my)) this.mouse.set(st.mx!, st.my!);
    if (Number.isFinite(st.mouseAmt)) this.mouseAmt = st.mouseAmt!;
    // a page that had to step its resolution down starts where it left off
    if (Number.isFinite(st.dpr) && st.dpr! < this.dpr) {
      this.dpr = Math.max(this.quality.minDpr, st.dpr!);
      this.resize(this.vw, this.vh);
    }
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Forget recent frame times, e.g. across a menu opening or closing: judge the frame rate afresh. */
  resetFrameStats() {
    this.frameCount = 0;
  }

  /**
   * Engrave `text` inside the band (null takes it away, fading). With `burn`,
   * a line of light writes it in once the band is lit; without, it is simply
   * there, as it was on the last visit.
   */
  setInscription(text: string | null, burn: boolean) {
    const ink = this.ink;
    ink.target = text ? 1 : 0;
    if (!text) {
      ink.burning = false;
      return;
    }
    this.ring.inscribe(text).then(() => {
      if (!ink.target) return;
      ink.ready = true;
      ink.amount = 1;
      ink.burning = burn;
      ink.reveal = burn ? -0.1 : 2;
    });
  }

  /** Compile shaders and render once, so the intro starts without a hitch. */
  warmup() {
    // The scene is drawn into the composer's buffer, never to the screen, and
    // its shaders differ per target (tone mapping, output colour space).
    this.renderer.setRenderTarget(this.post.composer.readBuffer);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.post.composer.render(0);
  }

  private halfHeight() {
    return CAM_DIST * Math.tan((FOV * DEG) / 2);
  }

  /** Screen placement → world position on the z = 0 plane; returns the scale. */
  private place(l: RingLayout, out: THREE.Vector3): number {
    const halfH = this.halfHeight();
    const halfW = halfH * (this.vw / this.vh);
    out.set((l.x / this.vw) * 2 * halfW - halfW, halfH - (l.y / this.vh) * 2 * halfH, 0);
    return ((l.r / (this.vh / 2)) * halfH) / RING.Ro;
  }

  update(f: FrameInput) {
    const { dt, time, intro } = f;
    this.adapt(dt);

    // ------------------------------------------------------------ choreography
    const n = this.layouts.length;
    let scale = 1;
    let roll = -30;
    let spinAngle = 0;
    let activity = 0;
    let band = 0;
    let bandAmt = 0;

    if (n > 0) {
      // The ring moves between two placements: the chapters either side of the
      // scroll position, or, during a jump, straight from where it was to the
      // destination, so the chapters in between never pull it around.
      let a: RingLayout;
      let b: RingLayout;
      let frac: number;
      let turnsFrom = 0;
      let turnsTo = 1;
      let bandFrom = 1;
      const trip = f.travel && this.layouts[f.travel.to] ? f.travel : null;
      if (trip) {
        a = trip.from;
        b = this.layouts[trip.to];
        frac = clamp(trip.t);
        turnsFrom = trip.from.turns;
        // one sweep of the node, ending on a whole turn
        turnsTo = Math.ceil(turnsFrom + 0.5);
        bandFrom = trip.from.bandAmt;
      } else {
        const s = clamp(f.s, 0, n - 1);
        const i = Math.min(Math.floor(s), Math.max(0, n - 2));
        frac = n > 1 ? s - i : 0;
        a = this.layouts[i];
        b = this.layouts[Math.min(i + 1, n - 1)];
      }
      const e = f.reduceMotion ? (frac < 0.5 ? 0 : 1) : smootherstep(clamp((frac - 0.1) / 0.8));
      const p = this.posed;
      p.x = lerp(a.x, b.x, e);
      p.y = lerp(a.y, b.y, e);
      p.r = lerp(a.r, b.r, e);
      p.roll = lerp(a.roll, b.roll, e);
      p.turns = f.reduceMotion ? 0 : lerp(turnsFrom, turnsTo, easeInOutCubic(clamp((frac - 0.2) / 0.6)));
      if (frac < 0.5) {
        p.band = a.band;
        p.bandAmt = a.band > 0 ? bandFrom * (1 - clamp(frac / 0.3)) : 0;
      } else {
        p.band = b.band;
        p.bandAmt = b.band > 0 ? 1 - clamp((1 - frac) / 0.3) : 0;
      }
      scale = this.place(p, this.v1);
      roll = p.roll;
      activity = f.reduceMotion ? 0 : Math.sin(Math.PI * e);
      this.v1.z += activity * 1.5;
      spinAngle = p.turns * Math.PI * 2;
      band = p.band;
      bandAmt = p.bandAmt;

      // intro: glide from the centred "logo moment" to the hero placement
      if (!intro.done) {
        const si = this.place(this.introLayout, this.v2);
        const k = easeInOutCubic(intro.pose);
        this.v1.lerp(this.v2, 1 - k);
        scale = lerp(si, scale, k);
        roll = lerp(this.introLayout.roll, roll, k);
      }
    }

    // gentle precession + cursor tilt
    this.mouse.x = damp(this.mouse.x, f.mouse.x, 3, dt);
    this.mouse.y = damp(this.mouse.y, f.mouse.y, 3, dt);
    const idle = f.reduceMotion ? 0 : 1;
    const tiltX = (Math.sin(time * 0.31) * 2.0 * idle - this.mouse.y * 6) * DEG;
    const tiltY = (Math.sin(time * 0.23) * 2.6 * idle + this.mouse.x * 9) * DEG;
    this.v1.y += Math.sin(time * 0.6) * 0.025 * idle;

    this.pose.position.copy(this.v1);
    this.pose.scale.setScalar(scale);
    this.q1.setFromAxisAngle(this.zAxis, roll * DEG);
    this.q2.setFromAxisAngle(this.xAxis, TILT);
    this.q1.multiply(this.q2);
    this.e1.set(tiltX, tiltY, 0);
    this.q2.setFromEuler(this.e1);
    this.pose.quaternion.copy(this.q2).multiply(this.q1);
    this.spin.rotation.y = spinAngle;
    this.thetaDeg = ((((roll + 210 + (spinAngle / DEG)) % 360) + 360) % 360);

    this.camera.position.set(this.mouse.x * 0.25, this.mouse.y * 0.16, CAM_DIST);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.pose.updateMatrixWorld(true);

    // ------------------------------------------------------------------- node
    const ringMesh = this.ring.mesh;
    const bead = this.v2.set(0, 0, RING.Ro + 0.006);
    ringMesh.localToWorld(bead);
    const normal = this.v3.set(0, 0, 1).transformDirection(ringMesh.matrixWorld);
    const toCam = this.posA.copy(this.camera.position).sub(bead).normalize();
    const facing = normal.dot(toCam);
    const visible = clamp((facing - 0.02) / 0.25);

    const proj = f.projection;
    const projI = proj ? proj.intensity : 0;
    const projF = proj ? proj.front : 0;
    // a short flare whenever a new scan starts
    const scan = proj ? proj.scan : 0;
    if (proj && scan < this.lastScan - 0.5) this.beadBoost = 0;
    if (proj && projF > 0.5 && scan < 0.08) this.beadBoost = Math.max(this.beadBoost, 1);
    this.lastScan = scan;
    this.beadBoost = damp(this.beadBoost, 0, 2.2, dt);

    const heartbeat = 1 + 0.08 * Math.sin(time * 2.1) + 0.05 * Math.sin(time * 5.3);
    const restBead = intro.done ? 1.15 + projI * 1.1 + projF * 1.6 + this.beadBoost * 2.2 : 0;
    const beadI = Math.max(intro.bead, restBead) * heartbeat;

    // The node stays dark through totality; only the glint and the flash light it.
    const ru = this.ring.uniforms;
    ru.uDotIntensity.value = 1.4 * intro.env + beadI * 5.5;
    // The veins light with the band, the first light running round from the
    // node as the orbit field unfurls; then pulses keep leaving the node.
    ru.uTime.value = time;
    ru.uVeins.value = intro.env;
    ru.uVeinFront.value = intro.birth * 1.6;
    ru.uVeinFlow.value = f.reduceMotion ? 0 : 1;
    const ink = this.ink;
    ink.amount = damp(ink.amount, ink.ready ? ink.target : 0, 4, dt);
    if (ink.burning && intro.done) {
      ink.reveal += dt / 1.8;
      if (ink.reveal > 1.25) {
        ink.burning = false;
        ink.reveal = 2;
      }
    }
    ru.uInscriptionI.value = ink.amount * intro.env;
    ru.uInscriptionReveal.value = ink.reveal;

    const ndc = this.posB.copy(bead).project(this.camera);
    const aspect = this.vw / this.vh;
    // projected direction of the ring's major axis, for the spikes
    const tip = this.v1.set(0.3, 0, RING.Ro);
    ringMesh.localToWorld(tip).project(this.camera);
    const spikeAngle = Math.atan2(tip.y - ndc.y, (tip.x - ndc.x) * aspect);

    const ringPx = (RING.Ro * scale * (this.vh / 2)) / this.halfHeight();
    const g = this.glow.uniforms;
    g.uCenter.value.set(ndc.x, ndc.y);
    g.uAspect.value = aspect;
    g.uSize.value = clamp(ringPx / (this.vh / 2) * 2.1, 0.32, 0.95);
    g.uCore.value = 0.032;
    g.uI.value = beadI * 0.42 * visible;
    g.uSpike.value = Math.max(intro.spike, 0.12 + projF * 0.1 + this.beadBoost * 0.25);
    g.uAngle.value = spikeAngle;
    g.uTime.value = time;

    // ------------------------------------------------------------------ beam
    if (proj && (projI > 0.002 || projF > 0.002) && visible > 0) {
      const r = proj.rect;
      let b0x: number, b0y: number, b1x: number, b1y: number;
      if (proj.dir === 'rtl') {
        b0x = b1x = r.right - proj.scan * r.width;
        b0y = r.top;
        b1y = r.bottom;
      } else if (proj.dir === 'ltr') {
        b0x = b1x = r.left + proj.scan * r.width;
        b0y = r.top;
        b1y = r.bottom;
      } else {
        b0y = b1y = r.top + proj.scan * r.height;
        b0x = r.left;
        b1x = r.right;
      }
      const toNdcX = (x: number) => (x / this.vw) * 2 - 1;
      const toNdcY = (y: number) => 1 - (y / this.vh) * 2;
      this.beam.set(ndc.x, ndc.y, toNdcX(b0x), toNdcY(b0y), toNdcX(b1x), toNdcY(b1y));
      this.beam.mesh.visible = true;
      this.beam.dust.visible = true;
      this.beam.uniforms.uI.value = projI * visible;
      this.beam.uniforms.uFront.value = projF * visible;
      this.beam.dustUniforms.uI.value = (projI * 0.9 + projF * 0.6) * visible;
    } else {
      this.beam.mesh.visible = false;
      this.beam.dust.visible = false;
    }
    this.beam.uniforms.uTime.value = time;
    this.beam.dustUniforms.uTime.value = time;

    // ------------------------------------------------------------ orbit field
    const speed = 1 + activity * 2.4;
    this.phase += dt * speed;
    const d = this.disk.uniforms;
    d.uPhase.value = this.phase;
    d.uTime.value = time;
    d.uBirth.value = intro.birth;
    d.uSizeScale.value = clamp(Math.sqrt(scale / 1.25), 0.65, 1.15);
    d.uHighlight.value.set(band || 1.5, band > 0 ? bandAmt * 0.9 : 0);

    // cursor → field-local coordinates
    let mouseTarget = 0;
    if (f.mouse.active && !f.reduceMotion) {
      this.raycaster.setFromCamera(this.pointer.set(f.mouse.x, f.mouse.y), this.camera);
      const up = this.v1.set(0, 1, 0).transformDirection(this.pose.matrixWorld);
      this.plane.setFromNormalAndCoplanarPoint(up, this.pose.position);
      const hit = this.raycaster.ray.intersectPlane(this.plane, this.v3);
      if (hit) {
        this.pose.worldToLocal(hit);
        d.uMouse.value.copy(hit);
        mouseTarget = 1;
      }
    }
    this.mouseAmt = damp(this.mouseAmt, mouseTarget, 4, dt);
    d.uMouseAmt.value = this.mouseAmt;

    // ----------------------------------------------------------- atmosphere
    this.stars.uniforms.uTime.value = time;
    this.stars.uniforms.uOpacity.value = intro.stars;
    this.stars.points.rotation.y = time * 0.004;

    const nb = this.nebula.uniforms;
    nb.uIntensity.value = intro.nebula;
    nb.uShift.value.set(-this.mouse.x * 0.006, -this.mouse.y * 0.004);

    const restCorona = intro.done ? 0.13 - activity * 0.05 : 0;
    this.corona.uniforms.uI.value = Math.max(intro.corona, restCorona);
    this.corona.uniforms.uTime.value = time;

    this.construction.uniforms.uDraw.value = intro.construct;
    this.construction.uniforms.uAlpha.value = intro.constructAlpha * 0.7;
    this.construction.lines.visible = intro.constructAlpha > 0.001;

    this.ring.mesh.material.envMapIntensity = intro.env;

    // ------------------------------------------------------------------ post
    const fin = this.post.final.uniforms;
    fin.toneMappingExposure.value = intro.exposure;
    fin.uTime.value = time;
    fin.uCA.value = intro.ca + activity * 0.02;

    this.post.composer.render(dt);
  }

  /**
   * Step the pixel ratio down while frames stay slower than ~50 fps. Judged on
   * the last second with its slowest tenth left out, so a passing hitch (a
   * font loading, the menu's first paint) is not mistaken for a slow GPU: each
   * step reallocates the canvas, which at 5K stalls the page for ~0.1 s, and
   * the glow visibly changes size.
   */
  private adapt(dt: number) {
    if (dt <= 0) return;
    const times = this.frameTimes;
    times[this.frameCount++ % times.length] = dt;
    if (this.frameCount < times.length || this.frameCount % 15 !== 0) return;
    const sorted = times.slice().sort();
    const keep = Math.floor(sorted.length * 0.9);
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += sorted[i];
    if (sum / keep > 1 / 50 && this.dpr > this.quality.minDpr) {
      this.dpr = Math.max(this.quality.minDpr, +(this.dpr - 0.25).toFixed(2));
      this.frameCount = 0;
      this.resize(this.vw, this.vh);
      console.info(`[spacering] frames are slow, pixel ratio → ${this.dpr}`);
    }
  }
}
