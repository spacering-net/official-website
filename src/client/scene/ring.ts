import * as THREE from 'three';
import { INK, inkLetters } from '../../lib/inscription';
import { lerp } from '../math';
import { SIMPLEX } from './glsl';
import { INK as INK_WASH } from './ink';

/**
 * Ring dimensions in ring-local units, derived from the logo's construction
 * (u = 20 on the 512 canvas): inner radius 8.64u → 1, band height 2√5u,
 * node dot diameter 2u on the outer surface. The radial thickness is a little
 * heavier than the physical reading of the logo so the band reads at a glance.
 */
export const RING = {
  Ri: 1.0,
  Ro: 1.16,
  H: 0.258, // half-height: √5u / 8.6445u
  corner: 0.045,
  dotR: 0.112, // u / 8.6445u ≈ 0.116, trimmed for the bezel
} as const;

function profile(): THREE.Vector2[] {
  const { Ri, Ro, H, corner: c } = RING;
  const hw = H - c;
  const bulgeOut = 0.012;
  const bulgeIn = 0.007;
  const rMid = (Ri + Ro) / 2;
  const pts: THREE.Vector2[] = [new THREE.Vector2(rMid, -H)];
  const last = () => pts[pts.length - 1];

  const lineTo = (r: number, y: number, n: number) => {
    const p0 = last().clone();
    for (let i = 1; i <= n; i++) pts.push(new THREE.Vector2(lerp(p0.x, r, i / n), lerp(p0.y, y, i / n)));
  };
  const arcTo = (cx: number, cy: number, a0: number, a1: number, n: number) => {
    for (let i = 1; i <= n; i++) {
      const a = lerp(a0, a1, i / n);
      pts.push(new THREE.Vector2(cx + c * Math.cos(a), cy + c * Math.sin(a)));
    }
  };
  const wallTo = (rBase: number, bulge: number, y1: number, n: number) => {
    const y0 = last().y;
    for (let i = 1; i <= n; i++) {
      const y = lerp(y0, y1, i / n);
      const k = y / hw;
      pts.push(new THREE.Vector2(rBase + bulge * (1 - k * k), y));
    }
  };

  // Counter-clockwise in (r, y) so LatheGeometry's normals face outward.
  lineTo(Ro - c, -H, 6);
  arcTo(Ro - c, -hw, -Math.PI / 2, 0, 12);
  wallTo(Ro, bulgeOut, hw, 36);
  arcTo(Ro - c, hw, 0, Math.PI / 2, 12);
  lineTo(Ri + c, H, 8);
  arcTo(Ri + c, hw, Math.PI / 2, Math.PI, 12);
  wallTo(Ri, -bulgeIn, -hw, 36);
  arcTo(Ri + c, -hw, Math.PI, Math.PI * 1.5, 12);
  lineTo(rMid, -H, 6);
  return pts;
}

export interface Ring {
  mesh: THREE.Mesh<THREE.LatheGeometry, THREE.MeshPhysicalMaterial>;
  uniforms: {
    uDotColor: { value: THREE.Color };
    uDotIntensity: { value: number };
    uTime: { value: number };
    /** light in the veins: 0 through totality, 1 once the band is lit */
    uVeins: { value: number };
    /** how far round the band the light has run from the node, in half-turns */
    uVeinFront: { value: number };
    /** 1 lets light pulses run along the veins; 0 holds them still */
    uVeinFlow: { value: number };
    /** how much of the inscription shows: 0–1 */
    uInscriptionI: { value: number };
    /**
     * How far round the band from the node the light that burns the
     * inscription in has come, in half-turns: it lights the letters from
     * both ends in, meeting in the middle at 1. Beyond 1 they are simply lit.
     */
    uInscriptionReveal: { value: number };
    /** the flash as the two ends of the burn meet in the middle, 0–1 */
    uInscriptionFlash: { value: number };
    /** the ring of light the flash sends over the inner wall: its radius (band units) and strength */
    uInscriptionRipple: { value: THREE.Vector2 };
    /** a surge of light along the veins, from the node round both sides: its front in half-turns, and strength */
    uSurge: { value: THREE.Vector2 };
    /**
     * The orbit field's gas as the camera sees it (gas.ts), laid out as
     * uGasRange says. The band draws what of it lies in front of the outer
     * wall above the field's plane, as much as uGasVeil says (below the
     * plane the gas's own annulus lies in front of the wall), in its ink by
     * day (uGasInk), and by night mirrors it.
     */
    uGas: { value: THREE.Texture | null };
    uGasRange: { value: THREE.Vector2 };
    uGasVeil: { value: number };
    uGasInk: { value: THREE.Vector2 };
    /** from the camera's space to the gas's, each frame */
    uGasFromView: { value: THREE.Matrix4 };
  };
  /** Draw the vein pattern into its texture, once, before the first frame. */
  bake(renderer: THREE.WebGLRenderer): void;
  /** Resolves once the inscription's font is loaded, so that letters can be inked. */
  inkReady(): Promise<void>;
  /** Half the width of `text` as the band is lettered with it: how far round the band it reaches either side of the back, in radians. */
  letterSpan(text: string): number;
  /**
   * Ink the band with the text engraved inside it (e.g. "SRN 10000"), its
   * font loaded; or, for the ring card's art (scripts/ring-card-art.mjs),
   * all over (true) or not at all (false).
   */
  paintInk(content: string | boolean): void;
  /** The point on the inner wall under a point of the ink canvas (its pixels), in the ring's own space. */
  inkPoint(x: number, y: number, out: THREE.Vector3): THREE.Vector3;
}

/** The inscription's lettering, in the HUD's mono face (laid out by src/lib/inscription.ts). */
const INK_FONT = `${INK.weight} ${INK.size}px "IBM Plex Mono", ui-monospace, monospace`;

/** Vein lines per unit along the band's cross-section. */
const VEIN_LINES = 8;
/** How far the veins keep from the node's middle, and from the inscription's (half-sizes round and across), in band units. */
const VEIN_NODE = 0.14;
const VEIN_SEAL = [0.5, 0.075] as const;

// The vein pattern never changes, so it is drawn once into a texture laid over
// the unrolled band (u: round, from the back through the node; v: across, along
// the cross-section) rather than worked out for every pixel of every frame.
// The lines are contours of a gently warped field. They part round the node
// as a stream parts round a stone, and round the inscription when there is
// one. R: how far the lines are moved from their places, in line spacings;
// B: the same with the inscription; G: whether a line shows here.
const VEIN_BAKE = /* glsl */ `
  ${SIMPLEX}
  varying vec2 vUv;
  uniform float uProfileLen;
  /** along the cross-section: where the node's middle is (round the band, at 0), and where the inscription's is (at the back) */
  uniform vec2 uAt;
  const float LINES = ${VEIN_LINES.toFixed(1)};
  float warpAt(vec2 around, float prof) {
    float meander = snoise(vec3(around * 0.55, prof * 0.9) + vec3(4.1, 1.7, 9.3));
    return 1.1 * snoise(vec3(around * 0.8, prof * 1.4) + 0.5 * meander);
  }
  // across the band, the short way round its cross-section
  float across(float d) {
    return d - uProfileLen * floor(d / uProfileLen + 0.5);
  }
  // How far p is from an obstacle's middle, in its half-sizes: 1 on its edge,
  // a superellipse of power n.
  float reach(vec2 p, float n) {
    return pow(pow(abs(p.x), n) + pow(abs(p.y), n), 1.0 / n);
  }
  // The field f with its contours parted round an obstacle r away, as
  // streamlines part round a cylinder in a steady flow (ψ = y (1 − 1/r²)).
  // fc, the field in the middle, is a half-integer, so no line runs through
  // it. Further out than three of its sizes, the lines let go of it.
  float part(float f, float fc, float r) {
    return f - (f - fc) / max(r * r, 1.0) * (1.0 - smoothstep(2.5, 4.0, r));
  }
  void main() {
    float th = (vUv.x - 0.5) * 6.28318530718;
    vec2 around = vec2(sin(th), cos(th));
    float prof = vUv.y * uProfileLen;
    float f = prof * LINES + warpAt(around, prof);
    // the node: round the band at 0, on the outer wall
    float rn = reach(vec2(th * ${RING.Ro.toFixed(3)}, across(prof - uAt.x)) / ${VEIN_NODE.toFixed(3)}, 2.0);
    float fNode = part(f, floor(uAt.x * LINES + warpAt(vec2(0.0, 1.0), uAt.x)) + 0.5, rn);
    // the inscription: at the back, on the inner wall
    float back = atan(-around.x, -around.y);
    float rs = reach(vec2(back * ${RING.Ri.toFixed(3)}, across(prof - uAt.y)) / vec2(${VEIN_SEAL[0].toFixed(3)}, ${VEIN_SEAL[1].toFixed(3)}), 4.0);
    float fSeal = part(fNode, floor(uAt.y * LINES + warpAt(vec2(0.0, -1.0), uAt.y)) + 0.5, rs);
    // each line surfaces and sinks along its length, so they read as veins,
    // but runs on unbroken round the node and the inscription
    float id = floor(fNode + 0.5);
    float seg = smoothstep(-0.55, 0.1, snoise(vec3(around * 1.1, id * 0.41 + 3.0)));
    seg = max(seg, 1.0 - smoothstep(1.5, 2.5, min(rn, rs)));
    gl_FragColor = vec4(fNode - prof * LINES, seg, fSeal - prof * LINES, 1.0);
  }`;

export function createRing(envMap: THREE.Texture, segments = 320, veins = true): Ring {
  const points = profile();
  const geometry = new THREE.LatheGeometry(points, segments);
  // Arc length along the cross-section, from the middle of the bottom face, so
  // the veins wrap over the band's edges without stretching at the fillets.
  const arc = [0];
  for (let j = 1; j < points.length; j++) arc.push(arc[j - 1] + points[j].distanceTo(points[j - 1]));
  const aProfile = new Float32Array((segments + 1) * points.length);
  for (let i = 0; i <= segments; i++) aProfile.set(arc, i * points.length);
  geometry.setAttribute('aProfile', new THREE.BufferAttribute(aProfile, 1));
  const profileLen = arc[arc.length - 1];
  // the middle of the inner wall, along the cross-section: the inscription's
  // line; and of the outer wall, the node's
  let mid = 0;
  let outerMid = -1;
  points.forEach((p, j) => {
    if (p.x < (RING.Ri + RING.Ro) / 2 && Math.abs(p.y) < Math.abs(points[mid].y)) mid = j;
    if (p.x > (RING.Ri + RING.Ro) / 2 && (outerMid < 0 || Math.abs(p.y) < Math.abs(points[outerMid].y))) outerMid = j;
  });
  // 8:1, like the band: the letters stand about a fifth of the wall high
  const ink = document.createElement('canvas');
  ink.width = INK.width;
  ink.height = INK.height;
  const inkTexture = new THREE.CanvasTexture(ink);
  inkTexture.anisotropy = 8;
  const inkHalfHeight = 0.085;
  const inkRect = new THREE.Vector4((ink.width / ink.height) * inkHalfHeight / RING.Ri, arc[mid], inkHalfHeight, 0);
  const field = veins
    ? new THREE.WebGLRenderTarget(1024, 256, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping })
    : null;

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#e7e9ef'),
    metalness: 1,
    roughness: 0.17,
    envMap,
    envMapIntensity: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.08,
    iridescence: 0.32,
    iridescenceIOR: 1.42,
    iridescenceThicknessRange: [160, 460],
  });
  if (veins) material.defines = { ...material.defines, RING_VEINS: '' };

  const uniforms = {
    uDotColor: { value: new THREE.Color('#ffd9a0') },
    uDotIntensity: { value: 0 },
    uTime: { value: 0 },
    uVeins: { value: 0 },
    uVeinFront: { value: 0 },
    uVeinFlow: { value: 1 },
    uInscriptionI: { value: 0 },
    uInscriptionReveal: { value: 2 },
    uInscriptionFlash: { value: 0 },
    uInscriptionRipple: { value: new THREE.Vector2() },
    uSurge: { value: new THREE.Vector2() },
    uGas: { value: null as THREE.Texture | null },
    uGasRange: { value: new THREE.Vector2(0, 1) },
    uGasVeil: { value: 1 },
    uGasInk: { value: new THREE.Vector2(1, 1) },
    uGasFromView: { value: new THREE.Matrix4() },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uRo: { value: RING.Ro },
      uDotR: { value: RING.dotR },
      uVeinField: { value: field?.texture ?? null },
      uProfileLen: { value: profileLen },
      uInscription: { value: inkTexture },
      uInscriptionRect: { value: inkRect },
      uVeinWarm: { value: new THREE.Color('#ffd9a0') },
      uVeinCool: { value: new THREE.Color('#9adfff') },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aProfile;\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;\nvarying float vProfile;\nvarying vec3 vRound;\nvarying vec3 vAcross;',
      )
      .replace(
        '#include <begin_vertex>',
        // the band's directions here, round it and across it, as the camera
        // sees them: the node's dome leans its normal along them
        '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;\nvProfile = aProfile;\nvRound = normalize((modelViewMatrix * vec4(position.z, 0.0, -position.x, 0.0)).xyz);\nvAcross = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vObjPos;
        varying vec3 vObjNormal;
        varying float vProfile;
        varying vec3 vRound;
        varying vec3 vAcross;
        uniform vec3 uDotColor;
        uniform float uDotIntensity;
        uniform float uRo;
        uniform float uDotR;
        uniform float uTime;
        uniform float uVeins;
        uniform float uVeinFront;
        uniform float uVeinFlow;
        uniform vec3 uVeinWarm;
        uniform vec3 uVeinCool;
        uniform sampler2D uInscription;
        uniform vec4 uInscriptionRect;
        uniform float uInscriptionI;
        uniform float uInscriptionReveal;
        uniform float uInscriptionFlash;
        uniform vec2 uInscriptionRipple;
        uniform vec2 uSurge;
        uniform sampler2D uGas;
        uniform vec2 uGasRange;
        uniform float uGasVeil;
        uniform vec2 uGasInk;
        uniform mat4 uGasFromView;
        // Where a point of the field's plane (gas-local) lies in the gas's
        // texture, and the gas there: the light along the line of sight
        // through it, up to the band, and in A what of the light behind
        // passes. None off the texture's edges.
        vec2 gasUv(vec3 p) {
          return vec2(atan(p.x, p.z) * 0.15915494, (log(length(p.xz)) - uGasRange.x) / (uGasRange.y - uGasRange.x));
        }
        vec4 gasAt(vec2 uv) {
          vec4 gas = textureLod(uGas, uv, 0.0);
          float k = smoothstep(0.0, 0.03, uv.y) * (1.0 - smoothstep(0.97, 1.0, uv.y));
          return vec4(gas.rgb * k, mix(1.0, gas.a, k));
        }
        // What of the gas lies in front of this point, if it is on the outer
        // wall (wall: how much), above the plane but not on the round of the
        // band's edge (no gas comes so high), facing the camera: the line of
        // sight crosses the plane inside the band, and there the gas's texture
        // holds only what lies outside the band, in front of the wall.
        vec4 gasInFront(float wall) {
          vec3 w = (uGasFromView * vec4(-vViewPosition, 1.0)).xyz;
          vec3 c = uGasFromView[3].xyz;
          if (w.y <= 0.0 || w.y > ${(RING.H - RING.corner).toFixed(4)} || wall <= 0.0 || dot(w.xz - c.xz, w.xz) >= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
          vec4 gas = gasAt(gasUv(c + (w - c) * (c.y / (c.y - w.y))));
          wall *= uGasVeil;
          return vec4(gas.rgb * wall, mix(1.0, gas.a, wall));
        }
        // The gas in the band's mirror (on the outer wall, as much as wall
        // says): as much of the gas's depth as the reflected ray passes
        // through on its way down (about ±0.13 by the band), all of it from
        // high on the wall and none from low down, read where the ray has
        // just passed the plane or its own start. Blurred over a disc 0.05
        // round that point (to first order in the texture's layout), as the
        // band is polished, not a perfect mirror.
        vec3 gasMirror(vec3 n, vec3 v, float wall) {
          if (wall <= 0.0) return vec3(0.0);
          vec3 w = (uGasFromView * vec4(-vViewPosition, 1.0)).xyz;
          vec3 d = mat3(uGasFromView) * reflect(-v, n);
          float through = smoothstep(-0.13, 0.13, w.y) * wall;
          if (d.y >= 0.0 || through <= 0.0) return vec3(0.0);
          vec3 p = w + d * ((min(w.y, 0.0) - 0.04 - w.y) / d.y);
          vec2 uv = gasUv(p);
          float r = length(p.xz);
          vec2 disc = vec2(0.15915494 / r, 1.0 / (r * (uGasRange.y - uGasRange.x))) * 0.05;
          vec3 sum = vec3(0.0);
          for (int i = 0; i < 6; i++) {
            float a = float(i) * 2.39996 + 0.4;
            sum += gasAt(uv + vec2(cos(a), sin(a)) * disc * sqrt((float(i) + 0.5) / 6.0)).rgb;
          }
          return sum * (through / 6.0);
        }
        ${INK_WASH}
        #ifdef DAY
        // three.js's ACES fit (the chunk that has it is left out of shaders
        // that draw into a render target)
        vec3 dayRRT(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 dayTone(vec3 color) {
          const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
          const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
          color = ACESOutputMat * dayRRT(ACESInputMat * (color / 0.6));
          return clamp(color, 0.0, 1.0);
        }
        #endif
        // The node: a circle of radius uDotR measured along the outer surface,
        // centred on the band's mid-line at angle 0 (+Z). Where a point lies
        // from its centre, round the band and across it:
        vec2 nodeOffset() {
          return vec2(atan(vObjPos.x, vObjPos.z) * uRo, vObjPos.y);
        }
        float outerWall() {
          vec3 radial = normalize(vec3(vObjPos.x, 0.0, vObjPos.z) + 1e-6);
          return smoothstep(0.55, 0.85, dot(normalize(vObjNormal), radial));
        }
        #ifdef RING_VEINS
        uniform sampler2D uVeinField;
        uniform float uProfileLen;
        float veinHash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
        #endif`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec2 nodeOff = nodeOffset();
        float nodeD = length(nodeOff);
        float nodeAA = fwidth(nodeD) * 1.25 + 1e-4;
        float wallMask = outerWall();
        float nodeMask = (1.0 - smoothstep(uDotR - nodeAA, uDotR + nodeAA, nodeD)) * wallMask;
        float bezel = smoothstep(uDotR - nodeAA, uDotR + nodeAA, nodeD)
                    * (1.0 - smoothstep(uDotR + 0.014 - nodeAA, uDotR + 0.014 + nodeAA, nodeD)) * wallMask;
        // the node is a stone of clear glass: what shows through it is its
        // polished setting
        diffuseColor.rgb *= 1.0 - 0.35 * nodeMask;
        diffuseColor.rgb *= 1.0 - 0.6 * bezel;

        // The inscription: the ring number engraved on the inner wall, at the
        // back of the band, where it faces the camera through the ring. The
        // light the veins carry round from the node gathers there and lights
        // it from within. x runs left to right as seen from the front, y from
        // the top of the band down.
        float letters = 0.0;
        float sealKeep = 0.0;
        float sealNear = 0.0;
        vec3 sealLight = vec3(0.0);
        float sealRipple = 0.0;
        vec3 sealHot = vec3(1.0, 0.93, 0.82);
        if (uInscriptionI > 0.0) {
          float back = atan(-vObjPos.x, -vObjPos.z);
          vec2 iuv = vec2(0.5 - back / (2.0 * uInscriptionRect.x), 0.5 - (vProfile - uInscriptionRect.y) / (2.0 * uInscriptionRect.z));
          float inRect = step(0.0, iuv.x) * step(iuv.x, 1.0) * step(0.0, iuv.y) * step(iuv.y, 1.0);
          vec3 radialDir = normalize(vec3(vObjPos.x, 0.0, vObjPos.z) + 1e-6);
          float innerWall = 1.0 - smoothstep(-0.85, -0.55, dot(normalize(vObjNormal), radialDir));
          // The letters, and their glow and aura: the same ink read from its
          // mipmaps, two and four levels coarser than the letters are drawn,
          // so blurs that grow and shrink with them. (Gradients taken here,
          // where every pixel still runs: the reads below are only where the
          // ink is.)
          vec2 iuvDx = dFdx(iuv);
          vec2 iuvDy = dFdy(iuv);
          float inside = inRect * innerWall * uInscriptionI;
          vec3 ink = vec3(0.0);
          if (inside > 0.0) {
            ink = vec3(textureGrad(uInscription, iuv, iuvDx, iuvDy).r,
                       textureGrad(uInscription, iuv, iuvDx * 4.0, iuvDy * 4.0).r,
                       textureGrad(uInscription, iuv, iuvDx * 16.0, iuvDy * 16.0).r);
            ink = clamp(ink * vec3(1.0, 1.3, 2.5), 0.0, 1.0) * inside;
          }
          // Round the band from the node: the burn's light comes in at both
          // ends of the lettering and meets in its middle, at the back (π).
          float a = PI - abs(back);
          float front = uInscriptionReveal * PI;
          float lit = smoothstep(a - 0.015, a + 0.015, front);
          float e = (a - front) / 0.03;
          float edge = exp(-e * e);
          letters = ink.r * lit;
          // the veins keep clear of the letters' light, and the light they
          // bring turns gold again as it nears them (by the reach VEIN_BAKE
          // parts them by)
          sealKeep = smoothstep(0.03, 0.45, ink.b);
          vec2 q = vec2(back / ${VEIN_SEAL[0].toFixed(3)}, (vProfile - uInscriptionRect.y) / ${VEIN_SEAL[1].toFixed(3)});
          q *= q;
          sealNear = (1.0 - smoothstep(1.2, 3.0, sqrt(sqrt(dot(q, q))))) * uInscriptionI;
          // At rest the light keeps coming in from both ends and gathering
          // in the middle, and the whole of it breathes.
          float x = fract(abs(back) * 2.4 + uTime * 0.16);
          float flow = pow(1.0 - x, 4.0) * uVeinFlow;
          float breath = 0.9 + 0.1 * sin(uTime * 1.25) * uVeinFlow;
          // Molten gold, deeper at the strokes' edges, white-hot only where
          // the light passes; round them the metal catches it, and further
          // out the veins' blue.
          vec3 amber = vec3(1.0, 0.42, 0.08);
          vec3 gold = vec3(1.0, 0.68, 0.3);
          float depth = smoothstep(0.35, 0.85, ink.g);
          vec3 core = mix(mix(amber, gold, depth), sealHot, 0.6 * flow);
          sealLight = lit * (core * ink.r * (0.6 + 0.4 * depth) * (0.75 * breath + 1.3 * flow)
                             + amber * ink.g * (0.1 * breath + 0.18 * flow)
                             + uVeinCool * max(ink.b - ink.g, 0.0) * 0.06 * breath)
                      + sealHot * (ink.r * 4.0 + ink.g * 0.6) * edge
                      + mix(gold, sealHot, 0.5) * uInscriptionFlash * (ink.r * 1.8 + ink.g * 0.45 + ink.b * 0.1);
          // the ring of light the flash sends out over the wall
          float rr = (length(vec2(back, vProfile - uInscriptionRect.y)) - uInscriptionRipple.x) / 0.018;
          sealRipple = exp(-rr * rr) * uInscriptionRipple.y * innerWall;
        }

        float vein = 0.0;
        float veinGroove = 0.0;
        float veinHalo = 0.0;
        float veinPulse = 0.0;
        float veinStream = 0.0;
        float veinWave = 0.0;
        float veinLit = 0.0;
        float veinInlay = 0.0;
        vec3 veinCol = uVeinWarm;
        #ifdef RING_VEINS
        {
          // Flow lines that wind round the band, as if engraved: contours of a
          // gently warped field over the unrolled band (see VEIN_BAKE), parted
          // round the node, and round the inscription while it is there.
          float ang = atan(vObjPos.x, vObjPos.z);
          vec3 field = textureLod(uVeinField, vec2(ang * 0.15915494 + 0.5, vProfile / uProfileLen), 0.0).rgb;
          float f = vProfile * ${VEIN_LINES.toFixed(1)} + mix(field.r, field.b, uInscriptionI);
          float id = floor(f + 0.5);
          float d = abs(f - id);
          float fw = fwidth(f);
          // where a line shows, it tapers in and out like a brush stroke
          float seg = field.g;
          #ifdef DAY
          // by day an inlay, a little wider
          float hw = 0.042 * (0.35 + 0.65 * seg);
          #else
          float hw = 0.03 * (0.35 + 0.65 * seg);
          #endif
          // Box-filtered coverage. A line is never drawn thinner than ~1.5 px,
          // only dimmer, or a bright one beads where it crosses pixel rows; where
          // lines crowd under a pixel they settle to their average tone.
          float hwPx = max(hw, 0.75 * fw);
          float cover = clamp((min(hwPx, d + 0.5 * fw) - max(-hwPx, d - 0.5 * fw)) / max(fw, 1e-5), 0.0, 1.0) * (hw / hwPx);
          float far = smoothstep(0.25, 0.6, fw);
          cover = mix(cover, 2.0 * hw, far);
          // the channel the light runs in, cut a little wider than it
          float gw = 2.6 * hw;
          float gwPx = max(gw, 0.75 * fw);
          float groove = clamp((min(gwPx, d + 0.5 * fw) - max(-gwPx, d - 0.5 * fw)) / max(fw, 1e-5), 0.0, 1.0) * (gw / gwPx);
          groove = mix(groove, 2.0 * gw, far);
          float clear = 1.0 - (1.0 - smoothstep(uDotR + 0.016, uDotR + 0.026, nodeD)) * wallMask;
          // a few lines carry most of the light, the rest stay faint
          float strength = 0.25 + 0.75 * pow(veinHash(id * 3.1 + 0.7), 1.5);
          // the lettering keeps the veins out from under it
          float plain = 1.0 - sealKeep;
          vein = cover * seg * clear * strength * plain;
          veinGroove = groove * seg * clear * plain * (0.5 + 0.5 * strength);
          #ifdef DAY
          veinInlay = clamp(cover * seg * clear * plain * (0.75 + 0.5 * strength), 0.0, 1.0);
          #endif
          // gone by halfway to the next line, which has its own pulses
          veinHalo = exp(-d * 6.0) * (1.0 - smoothstep(0.3, 0.5, d)) * seg * clear * strength * (1.0 - far) * plain;

          // Light leaves the node and runs round both sides of the band, each
          // side of each line on its own beat; it fades in past the node and
          // out before the back, where the two sides meet.
          float a = abs(ang);
          float h = veinHash(id * 1.7 + step(0.0, ang) * 0.53);
          float x = fract((a - uTime * 0.7) / 3.6 + h);
          veinPulse = pow(x, 7.0) * (1.0 - smoothstep(0.985, 1.0, x)) * exp(-a * 0.2)
                    * smoothstep(0.0, 0.2, a) * (1.0 - smoothstep(PI - 0.6, PI, a)) * uVeinFlow;
          // and between them the light streams on, slowly, in the same way
          float t = uTime * uVeinFlow;
          veinStream = 0.5 + 0.25 * (sin(a * 4.0 - t * 0.9 + h * 6.2832) + sin(a * 2.3 - t * 0.55 + h * 11.0));
          veinStream *= veinStream * veinStream;
          // the first light after the flash, as one wave from the node
          float front = uVeinFront * PI;
          veinLit = 1.0 - smoothstep(front - 0.35, front + 0.05, a);
          veinWave = exp(-pow((a - front) / 0.3, 2.0)) * (1.0 - smoothstep(0.9, 1.15, uVeinFront));
          // and the surge that burns the inscription in
          float surge = (a - uSurge.x * PI) / 0.3;
          veinWave = max(veinWave, exp(-surge * surge) * uSurge.y * 1.6);
          veinCol = mix(mix(uVeinWarm, uVeinCool, smoothstep(0.3, 2.6, a)), uVeinWarm, sealNear);
        }
        #ifdef DAY
        // by day the lines are enamel inlaid in the silver, in deeper shades
        // of their colours: lit by the room rather than mirroring it, they
        // show on the bright metal and on its dark mirrors alike
        diffuseColor.rgb *= 1.0 - 0.15 * vein;
        diffuseColor.rgb = mix(diffuseColor.rgb, pow(veinCol, vec3(3.0)) * 0.35, veinInlay);
        #else
        // by night each is a dark, matte channel with a thread of light down
        // its middle: it reads on the bright mirrors as well as the dark
        diffuseColor.rgb *= 1.0 - 0.5 * veinGroove;
        #endif
        #endif
        // engraved: the groove is darker and matte
        diffuseColor.rgb *= 1.0 - 0.55 * letters;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, nodeMask);\n#ifdef DAY\nroughnessFactor = mix(roughnessFactor, 0.3, vein);\nroughnessFactor = mix(roughnessFactor, 0.22, veinInlay);\n#else\nroughnessFactor = mix(roughnessFactor, 0.32, veinGroove);\n#endif\nroughnessFactor = mix(roughnessFactor, 0.5, letters);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n#ifdef DAY\nmetalnessFactor = mix(metalnessFactor, 0.0, veinInlay);\n#endif',
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        // The stone's dome, a cap whose normal leans out toward its rim; the
        // setting seen through it leans the other way, as a lens turns what
        // lies under it.
        vec2 nodeUV = nodeOff / uDotR;
        vec3 nodeTilt = (nodeUV.x * vRound + nodeUV.y * vAcross) * inversesqrt(max(2.2 - dot(nodeUV, nodeUV), 0.05)) * nodeMask;
        normal = normalize(normal - 0.5 * nodeTilt);`,
      )
      .replace(
        '#include <clearcoat_normal_fragment_maps>',
        '#include <clearcoat_normal_fragment_maps>\nclearcoatNormal = normalize(clearcoatNormal + nodeTilt);',
      )
      .replace(
        '#include <lights_physical_fragment>',
        // the dome is glass: a polished coat over the whole of it
        '#include <lights_physical_fragment>\nmaterial.clearcoat = mix(material.clearcoat, 1.0, nodeMask);\nmaterial.clearcoatRoughness = mix(material.clearcoatRoughness, 0.06, nodeMask);',
      )
      .replace(
        '#include <lights_fragment_maps>',
        // the gas round the band in its mirror, a little under its full light
        // (not in the node's glass)
        '#include <lights_fragment_maps>\n#ifndef DAY\nradiance += 0.8 * gasMirror(geometryNormal, geometryViewDir, wallMask) * (1.0 - nodeMask);\n#endif',
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        // The light in the stone: a point at its heart, a little of its glow
        // in the glass, and the glass's edge catching it. The rest is clear.
        float nodeR2 = dot(nodeUV, nodeUV);
        float nodePoint = exp(-nodeR2 / 0.025);
        float nodeFill = exp(-nodeR2 / 0.35);
        float nodeEdge = smoothstep(0.55, 0.95, nodeR2);
        #ifdef DAY
        // by day in amber; it lights the silver round it a little
        totalEmissiveRadiance += uDotIntensity * nodeMask * (uDotColor * (0.9 * nodeFill + 0.12 * nodeEdge) + mix(uDotColor, vec3(1.0), 0.4) * 2.0 * nodePoint);
        totalEmissiveRadiance += uDotColor * uDotIntensity * (1.0 - nodeMask) * wallMask * 0.06 * exp(-max(nodeD - uDotR, 0.0) / 0.05);
        #else
        totalEmissiveRadiance += uDotIntensity * nodeMask * (uDotColor * uDotColor * (0.16 * nodeFill + 0.05 * nodeEdge) + mix(uDotColor, vec3(1.0), 0.5) * 1.3 * nodePoint);
        #endif
        // the veins' light, white-hot at the heads of the pulses
        vec3 veinHot = mix(veinCol, vec3(1.0), 0.6 * veinPulse * veinPulse);
        totalEmissiveRadiance += veinHot * uVeins * (veinLit * (vein * (0.12 + 0.5 * veinStream + 1.6 * veinPulse) + veinHalo * (0.03 + 0.08 * veinStream + 0.6 * veinPulse))
                                                    + veinWave * (vein * 1.4 + veinHalo * 0.4));
        // the inscription's light, and the ring of light its burn-in ends
        // with, which the veins it crosses catch
        totalEmissiveRadiance += sealLight + mix(uVeinWarm, sealHot, 0.5) * sealRipple * (0.9 + 4.0 * vein);`,
      )
      .replace(
        '#include <opaque_fragment>',
        // By day the frame is paper and ink, finished as it is drawn (post.ts):
        // the ring brings its own tone mapping. Over it, the gas in front.
        /* glsl */ `#include <opaque_fragment>
        vec4 gasFront = gasInFront(wallMask);
        #ifdef DAY
        gl_FragColor.rgb = dayTone(gl_FragColor.rgb) * ink(gasFront.rgb, uGasInk);
        #else
        gl_FragColor.rgb = gl_FragColor.rgb * gasFront.a + gasFront.rgb;
        #endif`,
      );
  };
  material.customProgramCacheKey = () => (veins ? 'spacering-ring-v3-veins' : 'spacering-ring-v3');

  const paintInk = (content: string | boolean) => {
    const g = ink.getContext('2d');
    if (!g) return;
    g.fillStyle = content === true ? '#fff' : '#000';
    g.fillRect(0, 0, ink.width, ink.height);
    if (typeof content === 'string') {
      g.fillStyle = '#fff';
      g.font = INK_FONT;
      g.textBaseline = 'alphabetic';
      // letter by letter: canvas letterSpacing is not everywhere yet
      for (const { char, x } of inkLetters(content)) g.fillText(char, x, INK.baseline);
    }
    inkTexture.needsUpdate = true;
  };

  const mesh = new THREE.Mesh(geometry, material);
  return {
    mesh,
    uniforms,
    paintInk,
    inkPoint(x, y, out) {
      // the shader's mapping (uInscriptionRect), run backwards: round the band from the back, then along the profile
      const back = (0.5 - x / ink.width) * 2 * inkRect.x;
      const along = inkRect.y + (y / ink.height - 0.5) * 2 * inkRect.z;
      let j = 1;
      while (j < arc.length - 1 && arc[j] < along) j++;
      const t = (along - arc[j - 1]) / (arc[j] - arc[j - 1]);
      const r = lerp(points[j - 1].x, points[j].x, t);
      return out.set(-r * Math.sin(back), lerp(points[j - 1].y, points[j].y, t), -r * Math.cos(back));
    },
    bake(renderer) {
      if (!field) return;
      const bakeMaterial = new THREE.ShaderMaterial({
        uniforms: { uProfileLen: { value: profileLen }, uAt: { value: new THREE.Vector2(arc[outerMid], arc[mid]) } },
        depthTest: false,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = position.xy * 0.5 + 0.5;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }`,
        fragmentShader: VEIN_BAKE,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
      quad.frustumCulled = false;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(field);
      renderer.render(quad, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      renderer.setRenderTarget(prev);
      bakeMaterial.dispose();
      quad.geometry.dispose();
    },
    async inkReady() {
      await document.fonts?.load(INK_FONT).catch(() => {});
    },
    letterSpan(text) {
      const letters = inkLetters(text);
      if (!letters.length) return 0;
      const width = letters[letters.length - 1].x + INK.size * INK.advance - letters[0].x;
      return (width / ink.width) * inkRect.x;
    },
  };
}
