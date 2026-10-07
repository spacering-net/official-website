import * as THREE from 'three';
import { seeded } from '../math';

export interface Stars {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  uniforms: { uTime: { value: number }; uPx: { value: number }; uOpacity: { value: number } };
}

export function createStars(count: number): Stars {
  const random = seeded(0x57a25);
  const position = new Float32Array(count * 3);
  const aSize = new Float32Array(count);
  const aPhase = new Float32Array(count);
  const aColor = new Float32Array(count * 3);
  const palette = [new THREE.Color('#dfe7ff'), new THREE.Color('#ffffff'), new THREE.Color('#ffe4c4'), new THREE.Color('#a9c4ff')];
  const weights = [0.45, 0.3, 0.15, 0.1];
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // Mostly in front of the camera: a wide cone around -Z.
    do {
      v.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
    } while (v.lengthSq() > 1 || v.lengthSq() < 0.01 || v.z > 0.25);
    v.normalize().multiplyScalar(60 + random() * 70);
    position.set([v.x, v.y, v.z], i * 3);
    aSize[i] = 0.7 + Math.pow(random(), 7) * 3.2;
    aPhase[i] = random();
    let pick = random();
    let k = 0;
    while (k < weights.length - 1 && pick > weights[k]) pick -= weights[k++];
    const b = 0.35 + Math.pow(random(), 2) * 0.65;
    aColor[i * 3] = palette[k].r * b;
    aColor[i * 3 + 1] = palette[k].g * b;
    aColor[i * 3 + 2] = palette[k].b * b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));

  const uniforms = { uTime: { value: 0 }, uPx: { value: 1 }, uOpacity: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      attribute vec3 aColor;
      uniform float uTime;
      uniform float uPx;
      uniform float uOpacity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        float tw = 0.6 + 0.4 * sin(uTime * (0.5 + aPhase * 2.2) + aPhase * 47.0);
        float size = aSize * uPx;
        vAlpha = uOpacity * tw * clamp(size, 0.0, 1.0);
        vColor = aColor;
        gl_PointSize = max(size, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, vAlpha * a * a);
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -20;
  points.frustumCulled = false;
  return { points, uniforms };
}
