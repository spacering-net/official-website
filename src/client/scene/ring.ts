import * as THREE from 'three';
import { INK, inkLetters } from '../../lib/inscription';
import { lerp } from '../math';
import { SIMPLEX } from './glsl';

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
    /** how far the inscription has burned in, left to right, 0–1; beyond 1.2 it is simply there */
    uInscriptionReveal: { value: number };
  };
  /** Draw the vein pattern into its texture, once, before the first frame. */
  bake(renderer: THREE.WebGLRenderer): void;
  /** Set the text engraved inside the band (e.g. "SRN 10000"); resolves once it can be shown. */
  inscribe(text: string): Promise<void>;
  /**
   * For the ring card's art (scripts/ring-card-art.mjs): ink the band at
   * once with letters, all over (true) or not at all (false). Letters need
   * their font loaded.
   */
  paintInk(content: string | boolean): void;
  /** The point on the inner wall under a point of the ink canvas (its pixels), in the ring's own space. */
  inkPoint(x: number, y: number, out: THREE.Vector3): THREE.Vector3;
}

/** The inscription's lettering, in the HUD's mono face (laid out by src/lib/inscription.ts). */
const INK_FONT = `${INK.weight} ${INK.size}px "IBM Plex Mono", ui-monospace, monospace`;

// The vein pattern never changes, so it is drawn once into a texture laid over
// the unrolled band (u: round, from the back through the node; v: across, along
// the cross-section) rather than worked out for every pixel of every frame.
// R: how far the lines meander, in line spacings; G: whether a line shows here.
const VEIN_BAKE = /* glsl */ `
  ${SIMPLEX}
  varying vec2 vUv;
  uniform float uProfileLen;
  void main() {
    float th = (vUv.x - 0.5) * 6.28318530718;
    vec2 around = vec2(sin(th), cos(th));
    float prof = vUv.y * uProfileLen;
    float meander = snoise(vec3(around * 0.8, prof * 1.3) + vec3(4.1, 1.7, 9.3));
    float warp = 0.9 * snoise(vec3(around * 1.25, prof * 2.2) + 0.6 * meander);
    // each line surfaces and sinks along its length, so they read as veins
    float id = floor(prof * 10.0 + warp + 0.5);
    float seg = smoothstep(-0.25, 0.3, snoise(vec3(around * 1.4, id * 0.41 + 3.0)));
    gl_FragColor = vec4(warp, seg, 0.0, 1.0);
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
  // the middle of the inner wall, along the cross-section: the inscription's line
  let mid = 0;
  points.forEach((p, j) => {
    if (p.x < (RING.Ri + RING.Ro) / 2 && Math.abs(p.y) < Math.abs(points[mid].y)) mid = j;
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
        // back of the band, where it faces the camera through the ring. x runs
        // left to right as seen from the front, y from the top of the band down.
        float letters = 0.0;
        float letterLight = 0.0;
        float underLetters = 0.0;
        if (uInscriptionI > 0.0) {
          float back = atan(-vObjPos.x, -vObjPos.z);
          vec2 iuv = vec2(0.5 - back / (2.0 * uInscriptionRect.x), 0.5 - (vProfile - uInscriptionRect.y) / (2.0 * uInscriptionRect.z));
          float inRect = step(0.0, iuv.x) * step(iuv.x, 1.0) * step(0.0, iuv.y) * step(iuv.y, 1.0);
          vec3 radialDir = normalize(vec3(vObjPos.x, 0.0, vObjPos.z) + 1e-6);
          float innerWall = 1.0 - smoothstep(-0.85, -0.55, dot(normalize(vObjNormal), radialDir));
          float ink = texture2D(uInscription, iuv).r * inRect * innerWall;
          letters = ink * (1.0 - smoothstep(uInscriptionReveal - 0.04, uInscriptionReveal, iuv.x)) * uInscriptionI;
          letterLight = ink * exp(-pow((iuv.x - uInscriptionReveal) / 0.05, 2.0)) * uInscriptionI;
          underLetters = inRect * innerWall * uInscriptionI;
        }

        float vein = 0.0;
        float veinHalo = 0.0;
        float veinPulse = 0.0;
        float veinWave = 0.0;
        float veinLit = 0.0;
        float veinInlay = 0.0;
        vec3 veinCol = uVeinWarm;
        #ifdef RING_VEINS
        {
          // Flow lines that wind round the band, as if engraved: contours of a
          // gently warped field over the unrolled band (see VEIN_BAKE).
          float ang = atan(vObjPos.x, vObjPos.z);
          vec2 field = textureLod(uVeinField, vec2(ang * 0.15915494 + 0.5, vProfile / uProfileLen), 0.0).rg;
          float f = vProfile * 10.0 + field.r;
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
          float clear = 1.0 - (1.0 - smoothstep(uDotR + 0.012, uDotR + 0.045, nodeD)) * wallMask;
          // a few lines carry most of the light, the rest stay faint
          float strength = 0.35 + 0.65 * veinHash(id * 3.1 + 0.7);
          // the lettering keeps the veins out from under it
          float plain = 1.0 - 0.85 * underLetters;
          vein = cover * seg * clear * strength * plain;
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
          float x = fract((a - uTime * 0.7) / 4.7 + h);
          veinPulse = pow(x, 9.0) * (1.0 - smoothstep(0.99, 1.0, x)) * exp(-a * 0.25)
                    * smoothstep(0.0, 0.2, a) * (1.0 - smoothstep(PI - 0.6, PI, a)) * uVeinFlow;
          // the first light after the flash, as one wave from the node
          float front = uVeinFront * PI;
          veinLit = 1.0 - smoothstep(front - 0.35, front + 0.05, a);
          veinWave = exp(-pow((a - front) / 0.3, 2.0)) * (1.0 - smoothstep(0.9, 1.15, uVeinFront));
          veinCol = mix(uVeinWarm, uVeinCool, smoothstep(0.3, 2.6, a));
        }
        diffuseColor.rgb *= 1.0 - 0.15 * vein;
        #ifdef DAY
        // by day the lines are enamel inlaid in the silver, in deeper shades
        // of their colours: lit by the room rather than mirroring it, they
        // show on the bright metal and on its dark mirrors alike
        diffuseColor.rgb = mix(diffuseColor.rgb, pow(veinCol, vec3(3.0)) * 0.35, veinInlay);
        #endif
        #endif
        // engraved: the groove is darker and matte
        diffuseColor.rgb *= 1.0 - 0.55 * letters;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, nodeMask);\nroughnessFactor = mix(roughnessFactor, 0.3, vein);\n#ifdef DAY\nroughnessFactor = mix(roughnessFactor, 0.22, veinInlay);\n#endif\nroughnessFactor = mix(roughnessFactor, 0.5, letters);',
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
        totalEmissiveRadiance += veinCol * uVeins * (veinLit * (vein * (0.18 + 1.1 * veinPulse) + veinHalo * (0.03 + 0.45 * veinPulse))
                                                   + veinWave * (vein * 1.4 + veinHalo * 0.4));
        // a little light stays in the letters; more where the burn-in is passing
        totalEmissiveRadiance += uVeinWarm * (letters * 0.1 + letterLight * 2.4);`,
      )
      .replace(
        '#include <opaque_fragment>',
        // By day the frame is paper and ink, finished as it is drawn (post.ts):
        // the ring brings its own tone mapping.
        '#include <opaque_fragment>\n#ifdef DAY\ngl_FragColor.rgb = dayTone(gl_FragColor.rgb);\n#endif',
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
        uniforms: { uProfileLen: { value: profileLen } },
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
    async inscribe(text) {
      await document.fonts?.load(INK_FONT).catch(() => {});
      paintInk(text);
    },
  };
}
