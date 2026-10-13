import * as THREE from 'three';
import { SIMPLEX } from './glsl';
import { RING } from './ring';
import { INK, setInk } from './ink';
import { clamp, PHI } from '../math';

/**
 * The orbit field's gas: a nebula round the ring, in the field's plane, whose
 * stars are the field's particles (disk.ts). It has depth: five translucent
 * layers, each with clouds of its own, at heights in a disk half as thick by
 * the band as the band is and flaring outward. Front to back: a pale veil;
 * clouds over the midplane; the midplane, brightest, with the dust in it;
 * clouds under it; and a deep glow, broad and soft. The camera looks down
 * through them, so they slide over one another as the ring turns and the
 * cursor tilts it, most where it is seen most aslant, and the dust stands
 * dark against what lies behind it. The band is in focus: the gas nearer the
 * camera and farther off is softer.
 *
 * The band's light falls off outward through it, and its colour goes with it,
 * cloud by cloud rather than ring by ring: icy white by the band, Ion blue,
 * deep blue, violet at the fringes. The node lights it amber close by.
 *
 * It comes up to the band's wall, brightest there, where the band's light is
 * strongest. Along a line of sight that meets the band it ends there; where
 * it lies in front of the band it is a veil, only a third of itself (VEIL),
 * and the band shows through. Its annulus lies in front of the wall below the
 * plane; above it the band draws the gas in front of itself, and mirrors the
 * gas by night (ring.ts). Round the node it clears.
 *
 * Its clouds are noise drawn once into an atlas laid out log-polar (u round
 * the ring, v along ln r). In that layout a cloud has the same shape at every
 * radius, only larger farther out, as in a real disk. A small pass carries
 * the atlas round at the particles' own speeds, the inner gas faster
 * (ω ∝ r^-1.5), into the gas's fields, in the same layout. A second, every
 * frame, follows the line of sight through each point of the plane across
 * the layers, adding up the light along it and what of the light behind it
 * passes. The gas in the scene is a flat annulus that reads that, so the
 * screen pays one texture read a pixel, whatever its size. On an M2 the
 * fields take about 0.4 ms at 2048 × 512 texels and are drawn every other
 * frame while only the orbit moves (see uLag), the view about 0.5 ms, the
 * annulus about 0.25 ms at 5K.
 *
 * Shear winds any pattern into rings without end, so the flow restarts:
 * two copies of the atlas half a cycle apart, each carried round from a
 * fresh place in it, cross-fade so that each restarts unseen. The noise is
 * blended before it is shaped, keeping its contrast, so the clouds and
 * filaments morph from one copy to the other rather than fading through.
 */

/**
 * Where the gas lies, ring-local (inner radius 1): its textures span ln r over
 * r0–r1, from inside the band, where the band reads what lies in front of its
 * wall; the annulus starts at `inner`, inside the band too, which hides it.
 */
export const GAS = { r0: 1.04, r1: 4.7, inner: 1.12 } as const;
/**
 * The band's outer wall (ring.ts): Ro where it is least, bulging by 0.012 at
 * mid-height, straight to ±(H − corner), where it rounds into the band's
 * faces. As the shaders take it: r² = x + y (1 − (h / z)²) at height h,
 * with x = Ro², y = 2 Ro × 0.012 (to first order in the bulge); and the
 * point halfway round its lower edge.
 */
const BULGE = 0.012;
const WALL = RING.Ro + BULGE;
const STRAIGHT = new THREE.Vector3(RING.Ro * RING.Ro, 2 * RING.Ro * BULGE, RING.H - RING.corner);
const EDGE = new THREE.Vector2(RING.Ro - RING.corner * (1 - Math.SQRT1_2), -STRAIGHT.z - RING.corner * Math.SQRT1_2);
/** How much of the gas lying in front of the band shows: all of it fogged the band. */
const VEIL = 0.35;

/** The flow restarts every this much of the field's phase (seconds at rest). */
const CYCLE = 20;

const FULLSCREEN = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

// The atlas: four fields of signed noise, mean 0. R: the clouds; G: fine
// structure, which frays their edges and draws the wisps; B: dust; A: broad
// swells of the glow and of its colour.
const ATLAS = /* glsl */ `
  ${SIMPLEX}
  varying vec2 vUv;
  uniform vec2 uRange;
  const float TAU = 6.28318530718;
  float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      sum += amp * snoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      amp *= 0.5;
    }
    return sum;
  }
  void main() {
    float s = mix(uRange.x, uRange.y, vUv.y);
    float th = vUv.x * TAU;
    // on a cylinder round the disk, so the noise closes round the ring; a
    // little longer round than across: the flow shears the rest
    vec3 p = vec3(cos(th) * 1.7, sin(th) * 1.7, s * 2.2);
    // a gentle warp, so the clouds lean and fold a little
    vec3 w = vec3(fbm(p * 0.8 + 3.1, 2), fbm(p * 0.8 + 7.7, 2), fbm(p * 0.8 + 12.3, 2));
    vec3 pw = p + 0.55 * w;
    // octaves down to a few texels: fine detail where a cloud thins out
    float clouds = fbm(pw, 7) * 2.0;
    float wisps = fbm(pw * 3.1 + 21.0, 5) * 2.0;
    float dust = fbm(p * 1.3 + 0.5 * w + 41.0, 6) * 2.0;
    float broad = fbm(p * 0.55 + 61.0, 2) * 2.2;
    // in bytes: ±1.67 about 0.5, which the noise keeps well within
    gl_FragColor = vec4(clouds, wisps, dust, broad) * 0.3 + 0.5;
  }`;

// The gas's fields as they are now, in the atlas's layout, each 0–1, and
// mipmapped for the view, which blurs them. R: how cloudy; G: the wisps;
// B: the dust; A: the broad swells.
const FLOW = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tAtlas;
  uniform vec2 uRange;
  uniform float uPhase;
  uniform float uCycle;
  uniform vec3 uMouse;
  uniform float uMouseAmt;
  const float PI = 3.14159265359;
  const float TAU = 6.28318530718;

  float hash(float n) { return fract(sin(n * 91.345 + 47.853) * 43758.5453); }

  void main() {
    float th = vUv.x * TAU;
    float s = mix(uRange.x, uRange.y, vUv.y);
    float r = exp(s);
    vec2 rad = vec2(sin(th), cos(th));
    vec2 p = rad * r;

    // The cursor parts the gas as it parts the particles: what lies here
    // was pushed out from nearer the cursor (to first order, close enough
    // for a push this small).
    vec2 dm = p - uMouse.xz;
    float f = uMouseAmt * exp(-dot(dm, dm) / 0.16);
    vec2 push = normalize(dm + 1e-5) * (f * 0.3 / r);
    float tq = th - dot(push, vec2(rad.y, -rad.x));
    float vq = vUv.y - dot(push, rad) / (uRange.y - uRange.x);

    // Carried round at the particles' speed, ω = 0.34 r^-1.5, by two copies
    // half a cycle apart (see above), blended keeping the noise's contrast.
    // Each is as the atlas drew it halfway through its life, when it shows
    // most: sheared forward as it comes, back as it goes, as a cloud in a
    // shearing disk swings through.
    float w = 0.34 * exp(-1.5 * s);
    float c1 = uPhase / uCycle;
    float c2 = c1 + 0.5;
    vec4 a = texture2D(tAtlas, vec2((tq - w * (fract(c1) - 0.5) * uCycle) / TAU + hash(floor(c1)), vq));
    vec4 b = texture2D(tAtlas, vec2((tq - w * (fract(c2) - 0.5) * uCycle) / TAU + hash(floor(c2) + 0.5), vq));
    float wa = sin(PI * fract(c1));
    wa *= wa;
    float wb = 1.0 - wa;
    vec4 n = ((a - 0.5) * wa + (b - 0.5) * wb) * (inversesqrt(wa * wa + wb * wb) / 0.3);

    // clouds, their edges a little frayed by the fine structure; wisps along
    // the fine structure's ridges, round the clouds and between them; dust in
    // soft rifts
    float cloud = smoothstep(-0.15, 0.95, n.r + 0.12 * n.g);
    float wisp = pow(clamp(1.0 - abs(n.g) * 1.3, 0.0, 1.0), 5.0) * smoothstep(-0.8, 0.2, n.r);
    float dust = smoothstep(0.15, 0.8, n.b + 0.15 * n.g);
    gl_FragColor = vec4(cloud, wisp, dust, smoothstep(-0.8, 0.8, n.a));
  }`;

// The gas as the camera sees it, in the atlas's layout: for each point of the
// field's plane, the light along the line of sight through it, as far as the
// band if it meets the band (linear, before tone mapping), and in A what of
// the light from behind it passes.
const VIEW = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tFlow;
  uniform vec2 uRange;
  uniform float uTexel;
  uniform vec3 uCam;
  uniform float uLag;
  uniform float uBirth;
  uniform float uNode;
  uniform float uNodeI;
  uniform vec3 uMouse;
  uniform float uMouseAmt;
  uniform vec2 uHighlight;
  uniform float uRo;
  uniform vec3 uWall;
  const float TAU = 6.28318530718;

  // the gas's profile out from the band and its colours (see profile())
  uniform sampler2D tProfile;
  uniform vec4 uProfile;

  // The point of the plane, in the fields' layout (turned on by the orbit
  // since they were drawn), and how that moves per unit height along the
  // line of sight (to first order, close enough for the gas's thickness).
  vec2 uv0;
  vec2 duv;
  float s0;
  float ds;
  // the point of the plane, and how the line of sight drifts over it per
  // unit height (exactly)
  vec2 at;
  vec2 drift;
  // the line of sight's length from the camera to the plane, and per unit
  // height; the band's distance this far round, where the gas is in focus
  float d0;
  float stretch;
  float focus;
  // how far round from the node, for the birth; the node's light here, and
  // how clear of gas the node keeps the line of sight
  float fromNode;
  vec3 amber;
  float clearing;
  // how high the line of sight is where it meets the band's wall, below
  // which the band hides what lies along it (far below if it never does)
  float behind;
  // the light so far along the line of sight, and what of the light behind passes
  vec3 light;
  float pass;

  /**
   * One layer, at height y: clouds of its own (the fields round by turn),
   * blurred by soft more than being out of focus blurs them, glowing as much
   * as w says of its clouds, its wisps and its broad swells, in the colour
   * of the radius + deep, its dust dimming what lies behind it by dust.
   */
  void layer(float y, float turn, float soft, vec3 w, float deep, float dust) {
    // how far out the layer is here: exactly, as where the band's wall cuts
    // the line of sight (behind) the profile must be none
    vec2 q = at + drift * y;
    float r2 = dot(q, q);
    float s = 0.5 * log(r2);
    float r = sqrt(r2);
    float blur = 0.012 * abs(d0 - y * stretch - focus);
    // in focus at the band, the gas nearer the camera and farther off softer
    vec4 f = textureLod(tFlow, uv0 + duv * y + vec2(turn, 0.0), log2(max(blur / (r * uTexel), 1.0)) + soft);
    // Birth: the gas lights from the node round both sides as the field
    // unfurls, its front brighter, the echo of the flash running through it.
    float b = clamp((uBirth * 1.75 - fromNode - f.r * 0.22 - (r - 1.3) * 0.05) / 0.5, 0.0, 1.0);
    // how brightly it shines here, and how dusty it is; its colour
    vec2 here = texture2D(tProfile, vec2((s - uProfile.x) * uProfile.y, 0.25)).rg * b * clearing * step(behind, y);
    vec3 colour = texture2D(tProfile, vec2((r + deep + 0.6 * (f.a - 0.5) - uProfile.z) * uProfile.w, 0.75)).rgb;
    float glow = dot(w, vec3(f.r * f.r, f.g, f.a));
    light += pass * (glow * colour + amber * (glow + 0.01)) * (here.r * (1.0 + 6.4 * b * (1.0 - b) * (1.0 - uBirth)) * stretch * 0.1);
    pass *= exp(-dust * f.b * here.g * stretch);
  }

  void main() {
    float th = vUv.x * TAU;
    s0 = mix(uRange.x, uRange.y, vUv.y);
    float r = exp(s0);
    vec2 out_ = vec2(sin(th), cos(th));
    vec2 p = out_ * r;
    // the line of sight through p: at height y it passes over p + drift y
    vec3 eye = uCam - vec3(p.x, 0.0, p.y);
    drift = eye.xz / eye.y;
    at = p;
    // Where the line of sight, on its way down, meets the band's straight
    // wall, bulge and all: the gas below that along it the band hides (and
    // all of it, if the line is in the band already where the wall begins,
    // having come in over its edge). It is inside the wall where
    // A h² + 2 B h + C < 0 at height h. (A line that only grazes the band's
    // rounded edges is let be; what lies behind those the band itself hides.)
    float A = dot(drift, drift) + uWall.y / (uWall.z * uWall.z);
    float B = dot(p, drift);
    float C = dot(p, p) - uWall.x - uWall.y;
    float m = B * B - A * C;
    behind = m < 0.0 ? -9.0 : (sqrt(m) - B) / A;
    if (abs(behind) > uWall.z) behind = -9.0;
    if ((A * uWall.z + 2.0 * B) * uWall.z + C < 0.0) behind = uWall.z;
    d0 = length(eye);
    stretch = d0 / eye.y;
    focus = length(uCam - vec3(out_.x, 0.0, out_.y) * uRo);
    vec2 round_ = vec2(out_.y, -out_.x);
    ds = dot(drift, out_) / r;
    duv = vec2(dot(drift, round_) / (r * TAU), ds / (uRange.y - uRange.x));
    uv0 = vec2(vUv.x - 0.34 * exp(-1.5 * s0) * uLag / TAU, vUv.y);
    fromNode = abs(fract(vUv.x + 0.5) - 0.5) * 1.44;

    // The node's light, amber, falling off with distance, nothing behind the
    // band, and round it the gas clear, so the node is seen through no veil;
    // a chapter's band; where the cursor stirs the gas.
    vec2 nn = vec2(sin(uNode), cos(uNode));
    vec2 dn = p - nn * uRo;
    float dist = length(dn);
    amber = vec3(1.0, 0.6, 0.27) * (uNodeI * sqrt(max(0.0, dot(dn, nn) / max(dist, 1e-3))) / (1.0 + dist * dist * 7.0));
    clearing = smoothstep(0.1, 0.25, dist);
    vec2 dm = p - uMouse.xz;
    float lift = (1.0 + uHighlight.y * 0.6 * exp(-pow((r - uHighlight.x) / 0.22, 2.0))) * (1.0 + 0.5 * uMouseAmt * exp(-dot(dm, dm) / 0.16));

    // the gas's scale height here: flaring, H ∝ r^1.2 (disk.ts spreads its stars by it)
    float H = 0.06 * exp(1.2 * s0);
    light = vec3(0.0);
    pass = 1.0;
    // Front to back: a veil, pale, wisps in it, its dust dark against what
    // lies behind; clouds over the midplane; the midplane, brightest, and its
    // dust; clouds under it, softer and deeper in colour; and the deep glow,
    // broad and soft.
    layer(1.8 * H, 0.31, 0.6, vec3(0.3, 0.4, 0.05), -0.3, 0.3);
    layer(0.9 * H, 0.57, 0.3, vec3(0.6, 0.15, 0.1), 0.0, 0.2);
    layer(0.0, 0.0, 0.0, vec3(1.0, 0.25, 0.2), 0.1, 1.2);
    layer(-0.9 * H, 0.83, 0.7, vec3(0.6, 0.1, 0.15), 0.45, 0.3);
    layer(-1.8 * H, 0.13, 2.5, vec3(0.2, 0.0, 0.9), 0.9, 0.0);
    gl_FragColor = vec4(light * lift, pass);
  }`;

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/**
 * where the gas lies on the radius `x`: from a hair clear of the band's wall
 * (so that where the view cuts the line of sight at the wall, it cuts none),
 * fraying out far off
 */
const extent = (r: number) => smooth(WALL + 0.002, WALL + 0.017, r) * (1 - smooth(3.3, 4.6, r));
/** a division at radius c, of half-width w: the gas thins there by depth */
const dip = (r: number, c: number, w: number, depth: number) => 1 - depth * (1 - smooth(w * 0.3, w, Math.abs(r - c)));

/** the colours along the radius, at radii 0–1 of the way across PALETTE (see profile) */
const PALETTE = { from: 0.5, to: 5.5 };
const STOPS: [number, number, [number, number, number]][] = [
  // [from, to]: blended in from the last over this span of the radius
  [-Infinity, -Infinity, [0.62, 0.82, 1.0]],
  [1.3, 1.8, [0.2, 0.5, 1.0]],
  [1.7, 2.4, [0.07, 0.27, 1.0]],
  [2.3, 3.1, [0.04, 0.12, 1.0]],
  [3.1, 4.0, [0.12, 0.06, 1.0]],
];

/**
 * The gas's profile out from the band, and its colours, as a table the view
 * reads: worked out once here rather than in every layer of every texel.
 * Row 0, along ln r over [s0, s1]: R how brightly it shines, the band's light
 * falling off outward, fast close by, and the gas thinning a little at the
 * divisions; G how dusty it is, thinning outward more slowly than the gas
 * dims. Row 1, along the radius over PALETTE: its colour there, icy white by
 * the band, where it shines brightest; Ion blue; deep blue, and violet at
 * the fringes. Linear, so the blues are deeper than they look here: the gas
 * is dim, and a dim colour encoded for the screen pales towards grey.
 */
function profile(s0: number, s1: number) {
  const n = 256;
  const data = new Uint16Array(n * 2 * 4);
  const half = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * (i + 0.5)) / n;
    const r = Math.exp(s);
    const light = Math.exp(-2.6 * (s - Math.log(1.4))) + 0.6 * Math.exp(-(r - WALL) / 0.09);
    const shine = extent(r) * light * dip(r, PHI, 0.06, 0.3) * dip(r, PHI * PHI, 0.1, 0.3);
    const dust = extent(r) * Math.exp(-0.8 * (s - Math.log(1.4)));
    data.set([half(shine), half(dust), 0, half(1)], i * 4);
    const x = PALETTE.from + ((PALETTE.to - PALETTE.from) * (i + 0.5)) / n;
    const c = [...STOPS[0][2]];
    for (const [a, b, stop] of STOPS.slice(1)) {
      const t = smooth(a, b, x);
      for (let k = 0; k < 3; k++) c[k] += (stop[k] - c[k]) * t;
    }
    data.set([half(c[0]), half(c[1]), half(c[2]), half(1)], (n + i) * 4);
  }
  const texture = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, uniform: new THREE.Vector4(s0, 1 / (s1 - s0), PALETTE.from, 1 / (PALETTE.to - PALETTE.from)) };
}

export interface Gas {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /**
   * The gas as the camera sees it this frame, for the particles and the band:
   * RGB the light along the line of sight, as far as the band, A what of the
   * light from behind it passes. Laid out as `range` says.
   */
  texture: THREE.Texture;
  /** ln r at the texture's v = 0 and v = 1 */
  range: THREE.Vector2;
  /**
   * For the band, which draws what of the gas lies in front of its wall above
   * the plane (ring.ts): how much of that shows (VEIL), and the gas's ink by day.
   */
  veil: number;
  ink: THREE.Vector2;
  /** The flow's state, set before update(). */
  flow: {
    uPhase: { value: number };
    uMouse: { value: THREE.Vector3 };
    uMouseAmt: { value: number };
  };
  /** The view's, set before look(), every frame. */
  view: {
    /** the camera, gas-local */
    uCam: { value: THREE.Vector3 };
    /**
     * How much of the field's phase has passed since the fields were drawn:
     * the view turns them on by as far as the gas has orbited since, so they
     * need not be drawn every frame while nothing but the orbit moves.
     */
    uLag: { value: number };
    uBirth: { value: number };
    uNode: { value: number };
    uNodeI: { value: number };
    uMouse: { value: THREE.Vector3 };
    uMouseAmt: { value: number };
    uHighlight: { value: THREE.Vector2 };
  };
  /**
   * Compile the gas's passes in the background (with KHR_parallel_shader_compile
   * the browser does it on threads of its own), then draw the atlas: it is not
   * seen until the flash, two seconds into the intro, so it need not hold up
   * the first frame. Till then the gas is clear. Resolves once the atlas is drawn.
   */
  prepare(renderer: THREE.WebGLRenderer): Promise<void>;
  /** Draw the atlas now, if prepare has not yet: for when the gas is wanted at once. */
  bake(renderer: THREE.WebGLRenderer): void;
  /** whether the atlas is drawn (and the fields and the view once) */
  readonly ready: boolean;
  /** Move the gas on: draw its fields as `flow` says (mipmapped, for the view). */
  update(renderer: THREE.WebGLRenderer): void;
  /** Draw the gas as the camera sees it, as `view` says. */
  look(renderer: THREE.WebGLRenderer): void;
  setDay(day: boolean): void;
}

/** `width` × width/4 texels: round the ring by across it, about square in the log-polar layout. */
export function createGas(width: number): Gas {
  const height = width / 4;
  const range = new THREE.Vector2(Math.log(GAS.r0), Math.log(GAS.r1));
  // bytes: the noise and the fields need no more
  const atlas = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
  });
  const flow = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const seen = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
  });

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.PlaneGeometry(2, 2);
  const pass = (material: THREE.ShaderMaterial) => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(quad, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return scene;
  };
  const shader = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({ uniforms, vertexShader: FULLSCREEN, fragmentShader, depthTest: false, depthWrite: false });

  const atlasScene = pass(shader(ATLAS, { uRange: { value: range } }));
  const flowUniforms: Gas['flow'] = {
    uPhase: { value: 0 },
    uMouse: { value: new THREE.Vector3(99, 0, 99) },
    uMouseAmt: { value: 0 },
  };
  const flowScene = pass(
    shader(FLOW, { ...flowUniforms, tAtlas: { value: atlas.texture }, uRange: { value: range }, uCycle: { value: CYCLE } }),
  );
  const table = profile(range.x, range.y);
  const viewUniforms: Gas['view'] = {
    uCam: { value: new THREE.Vector3(0, 10, 5) },
    uLag: { value: 0 },
    uBirth: { value: 0 },
    uNode: { value: 0 },
    uNodeI: { value: 1 },
    uMouse: { value: new THREE.Vector3(99, 0, 99) },
    uMouseAmt: { value: 0 },
    uHighlight: { value: new THREE.Vector2(1.5, 0) },
  };
  const viewScene = pass(
    shader(VIEW, {
      ...viewUniforms,
      tFlow: { value: flow.texture },
      tProfile: { value: table.texture },
      uProfile: { value: table.uniform },
      uRange: { value: range },
      uTexel: { value: (range.y - range.x) / height },
      uRo: { value: RING.Ro },
      uWall: { value: STRAIGHT },
    }),
  );

  // The annulus, in the field's plane, its vertices carrying where they read
  // the texture: u round the ring (duplicated at the seam, so that no
  // triangle wraps), v along ln r.
  const segments = 256;
  const rings = 48;
  const position = new Float32Array((segments + 1) * (rings + 1) * 3);
  const uv = new Float32Array((segments + 1) * (rings + 1) * 2);
  const v0 = (Math.log(GAS.inner) - range.x) / (range.y - range.x);
  for (let j = 0; j <= rings; j++) {
    const v = v0 + (1 - v0) * (j / rings);
    const r = Math.exp(range.x + v * (range.y - range.x));
    for (let i = 0; i <= segments; i++) {
      const k = j * (segments + 1) + i;
      const th = (i / segments) * Math.PI * 2;
      position.set([Math.sin(th) * r, 0, Math.cos(th) * r], k * 3);
      uv.set([i / segments, v], k * 2);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i;
      const b = a + segments + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GAS.r1);

  const ink = new THREE.Vector2(0.5, 2.3);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tView: { value: seen.texture },
      uInk: { value: ink },
      uCam: viewUniforms.uCam,
      uWall: { value: STRAIGHT },
      uEdge: { value: EDGE },
      uVeil: { value: VEIL },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vPos;
      void main() {
        vUv = uv;
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${INK}
      varying vec2 vUv;
      varying vec3 vPos;
      uniform sampler2D tView;
      uniform vec2 uInk;
      uniform vec3 uCam;
      uniform vec3 uWall;
      uniform vec2 uEdge;
      uniform float uVeil;
      // How high the line of sight on from here (along d) is where it first
      // meets the cylinder of radius R round the axis; far below, if never.
      float meets(vec2 d, float R, float dy) {
        float a = max(dot(d, d), 1e-6);
        float b = dot(vPos.xz, d);
        float m = b * b - a * (dot(vPos.xz, vPos.xz) - R * R);
        float t = (-b - sqrt(max(m, 0.0))) / a;
        return m < 0.0 || t < 0.0 ? -9.0 : t * dy;
      }
      void main() {
        vec4 gas = texture2D(tView, vUv);
        // Where the band lies behind, the gas is a veil: the line of sight on
        // from here, down past the straight wall, comes inside it (bulge and
        // all: at height h it is inside where A h² + 2 B h + C < 0, least at
        // h = -B / A), or meets the round of its lower edge, taken halfway round.
        vec3 d = vPos - uCam;
        vec2 e = d.xz / d.y;
        float A = dot(e, e) + uWall.y / (uWall.z * uWall.z);
        float B = dot(vPos.xz, e);
        float h = clamp(-B / A, -uWall.z, 0.0);
        float wall = (A * h + 2.0 * B) * h + dot(vPos.xz, vPos.xz) - uWall.x - uWall.y;
        float band = max(1.0 - smoothstep(-0.004, 0.004, wall), smoothstep(uEdge.y - 0.006, uEdge.y + 0.006, meets(d.xz, uEdge.x, d.y)));
        float k = mix(1.0, uVeil, band);
        gas = vec4(gas.rgb * k, mix(1.0, gas.a, k));
        #ifdef DAY
        // an ink wash: the clouds' tone, a breath of their colour
        gl_FragColor = vec4(ink(gas.rgb, uInk), 1.0);
        #else
        // its light over what lies behind it, of which the dust lets A through
        gl_FragColor = gas;
        #endif
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  let baked = false;
  const clear = new THREE.Color();
  const draw = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, target: THREE.WebGLRenderTarget) => {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    // The clear colour as it stands for the target handed back: three keeps
    // it converted for the last target that set it, and a pass that clears
    // without setting it (the composer's RenderPass) would clear with ours.
    renderer.setClearColor(renderer.getClearColor(clear), renderer.getClearAlpha());
  };

  return {
    mesh,
    texture: seen.texture,
    range,
    veil: VEIL,
    ink,
    flow: flowUniforms,
    view: viewUniforms,
    prepare(renderer) {
      const prev = renderer.getRenderTarget();
      // Until the view is first drawn, the gas lets everything through.
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      renderer.setRenderTarget(seen);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      renderer.setClearColor(clear, alpha);
      // for a target, as they are drawn (programs differ between targets and the screen)
      renderer.setRenderTarget(atlas);
      const compiled = Promise.all([atlasScene, flowScene, viewScene].map((scene) => renderer.compileAsync(scene, camera)));
      renderer.setRenderTarget(prev);
      renderer.setClearColor(renderer.getClearColor(clear), renderer.getClearAlpha());
      return compiled.then(() => this.bake(renderer));
    },
    bake(renderer) {
      if (baked) return;
      baked = true;
      draw(renderer, atlasScene, atlas);
      this.update(renderer);
      // and the view, so that the particles read a gas, though none is born yet
      this.look(renderer);
    },
    get ready() {
      return baked;
    },
    update(renderer) {
      draw(renderer, flowScene, flow);
    },
    look(renderer) {
      draw(renderer, viewScene, seen);
    },
    setDay(day) {
      setInk(material, day);
      // By night the gas adds its light over what lies behind it and dims
      // that by its dust: premultiplied, A what passes.
      if (!day) {
        material.blending = THREE.CustomBlending;
        material.blendEquation = THREE.AddEquation;
        material.blendSrc = THREE.OneFactor;
        material.blendDst = THREE.SrcAlphaFactor;
        material.blendEquationAlpha = THREE.AddEquation;
        material.blendSrcAlpha = THREE.ZeroFactor;
        material.blendDstAlpha = THREE.OneFactor;
      }
    },
  };
}
