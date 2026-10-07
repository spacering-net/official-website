import * as THREE from 'three';
import { PHI, seeded } from '../math';
import { RING } from './ring';

/**
 * The orbit field: a Saturn-like disk of particles in the ring's plane.
 * Divisions sit at r = φ and r = φ² (ring-local units, inner radius = 1),
 * echoing the golden-ratio construction of the logo. Inner particles orbit
 * faster (Keplerian ω ∝ r^-1.5). Everything is computed in the vertex shader.
 */

const vertexShader = /* glsl */ `
  #include <common>
  attribute float aRadius;
  attribute float aAngle;
  attribute float aHeight;
  attribute float aSeed;
  attribute float aSize;
  attribute vec3 aColor;

  uniform float uPhase;
  uniform float uTime;
  uniform float uBirth;
  uniform float uPx;
  uniform float uSizeScale;
  uniform float uOpacity;
  uniform float uCamDist;
  uniform vec3 uMouse;
  uniform float uMouseAmt;
  uniform vec2 uHighlight;
  uniform float uRo;

  varying vec3 vColor;
  varying float vAlpha;

  float wrapPi(float a) { return mod(a + PI, 2.0 * PI) - PI; }

  void main() {
    float r = aRadius;
    float omega = 0.34 * pow(r, -1.5);
    float th = aAngle + omega * uPhase;

    float wobble = sin(th * 3.0 + aSeed * 31.0 + uTime * 0.17) * 0.010 * r;
    float rr = r + wobble;
    float y = aHeight * (1.0 + 0.3 * sin(uTime * 0.4 + aSeed * 19.0));

    // Birth: the field unfurls from the node (angle 0) around both sides.
    float fromNode = abs(wrapPi(aAngle)) / PI;
    float b = clamp((uBirth * 1.75 - fromNode * 0.72 - aSeed * 0.22 - (r - 1.3) * 0.05) / 0.5, 0.0, 1.0);
    float eb = 1.0 - pow(1.0 - b, 3.0);
    rr = mix(uRo * 1.01, rr, eb);
    y *= eb;

    vec3 p = vec3(sin(th) * rr, y, cos(th) * rr);

    // The cursor parts the field like a finger through Saturn's rings.
    vec2 dm = p.xz - uMouse.xz;
    float f = uMouseAmt * exp(-dot(dm, dm) / 0.16);
    p.xz += normalize(dm + 1e-5) * f * 0.3;
    p.y += f * 0.18 * (aSeed - 0.5);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float hl = 1.0 + uHighlight.y * exp(-pow((r - uHighlight.x) / 0.22, 2.0));
    float twinkle = 0.72 + 0.28 * sin(uTime * (0.8 + aSeed * 2.6) + aSeed * 61.0);
    float size = aSize * uPx * uSizeScale * (uCamDist / max(-mv.z, 0.1));
    vAlpha = uOpacity * twinkle * hl * smoothstep(0.0, 0.3, b) * (1.0 + f * 1.4) * clamp(size, 0.0, 1.0);
    vColor = aColor;
    gl_PointSize = max(size, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor, vAlpha * a * a);
  }
`;

export interface Disk {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  uniforms: {
    uPhase: { value: number };
    uTime: { value: number };
    uBirth: { value: number };
    uPx: { value: number };
    uSizeScale: { value: number };
    uOpacity: { value: number };
    uCamDist: { value: number };
    uMouse: { value: THREE.Vector3 };
    uMouseAmt: { value: number };
    uHighlight: { value: THREE.Vector2 };
    uRo: { value: number };
  };
}

function gauss(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Rejection-sample a radius in [a, b] from a density function. */
function sampleRadius(random: () => number, a: number, b: number, density: (r: number) => number): number {
  for (let i = 0; i < 24; i++) {
    const r = a + random() * (b - a);
    if (random() < density(r)) return r;
  }
  return a + random() * (b - a);
}

export function createDisk(count: number, camDist: number): Disk {
  const random = seeded(0x51a7e);
  const aRadius = new Float32Array(count);
  const aAngle = new Float32Array(count);
  const aHeight = new Float32Array(count);
  const aSeed = new Float32Array(count);
  const aSize = new Float32Array(count);
  const aColor = new Float32Array(count * 3);
  const position = new Float32Array(count * 3); // unused, but three.js wants it for bounds

  const warm = new THREE.Color('#ffe2b8');
  const white = new THREE.Color('#eceaf4');
  const ion = new THREE.Color('#9adfff');
  const deep = new THREE.Color('#6d7fc4');
  const c = new THREE.Color();

  const gap1 = PHI; // 1.618
  const gap2 = PHI * PHI; // 2.618
  const ringlets = (r: number) => 0.3 + 0.7 * Math.pow(Math.sin(r * 38.0) * 0.5 + 0.5, 3.0);

  for (let i = 0; i < count; i++) {
    const u = random();
    let r: number;
    let h: number;
    let bright: number;
    if (u < 0.34) {
      // inner band, bright and thin
      r = sampleRadius(random, 1.32, gap1 - 0.03, (x) => 0.35 + 0.65 * Math.pow(Math.sin(((x - 1.32) / (gap1 - 1.35)) * Math.PI), 0.6));
      h = gauss(random) * 0.008;
      c.copy(warm).lerp(white, random() * 0.7);
      bright = 0.45 + random() * 0.4;
    } else if (u < 0.76) {
      // main band with ringlets, between the φ and φ² divisions
      r = sampleRadius(random, gap1 + 0.045, gap2 - 0.07, ringlets);
      h = gauss(random) * 0.014;
      c.copy(white).lerp(ion, random() * 0.55);
      bright = 0.32 + random() * 0.4;
    } else if (u < 0.95) {
      // outer band, sparse and cool
      r = gap2 + 0.07 + Math.pow(random(), 1.6) * 2.0;
      h = gauss(random) * 0.03;
      c.copy(ion).lerp(deep, random() * 0.7);
      bright = 0.2 + random() * 0.32;
    } else {
      // a faint halo for depth
      r = 1.3 + Math.pow(random(), 0.9) * 4.2;
      h = gauss(random) * 0.22;
      c.copy(deep).lerp(white, random() * 0.3);
      bright = 0.12 + random() * 0.2;
    }

    let size = 1.1 + Math.pow(random(), 2.2) * 1.5;
    if (random() < 0.025) {
      size += 1.6 + random() * 1.8;
      bright = 1.0;
      c.lerp(new THREE.Color('#ffffff'), 0.6);
    }

    aRadius[i] = r;
    aAngle[i] = random() * Math.PI * 2;
    aHeight[i] = h;
    aSeed[i] = random();
    aSize[i] = size;
    aColor[i * 3] = c.r * bright;
    aColor[i * 3 + 1] = c.g * bright;
    aColor[i * 3 + 2] = c.b * bright;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(aRadius, 1));
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(aAngle, 1));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(aHeight, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6.5);

  const uniforms: Disk['uniforms'] = {
    uPhase: { value: 0 },
    uTime: { value: 0 },
    uBirth: { value: 0 },
    uPx: { value: 1 },
    uSizeScale: { value: 1 },
    uOpacity: { value: 0.9 },
    uCamDist: { value: camDist },
    uMouse: { value: new THREE.Vector3(99, 0, 99) },
    uMouseAmt: { value: 0 },
    uHighlight: { value: new THREE.Vector2(1.5, 0) },
    uRo: { value: RING.Ro },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, uniforms };
}
