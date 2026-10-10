import * as THREE from 'three';
import { VALUE_NOISE } from './glsl';
import { seeded } from '../math';
import { INK, setInk } from './ink';

/**
 * The projection beam, drawn in screen space (NDC) so it always lands exactly
 * on the DOM panel. One triangle: apex at the node, base on the scan line.
 * Fan coordinates use the (along, across·along) trick so `across` stays
 * correct under linear interpolation.
 */
export function createBeam() {
  const position = new Float32Array(9);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aCoord', new THREE.BufferAttribute(new Float32Array([0, 0, 1, -1, 1, 1]), 2));
  const uniforms = {
    uTime: { value: 0 },
    uI: { value: 0 },
    uFront: { value: 0 },
    uColorA: { value: new THREE.Color('#fff4e2') },
    uColorB: { value: new THREE.Color('#ffd9a0') },
    uInk: { value: new THREE.Vector2(3.5, 0.35) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // the fan's winding flips with the projection side
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec2 aCoord;
      varying vec2 vCoord;
      void main() {
        vCoord = aCoord;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${VALUE_NOISE}
      ${INK}
      uniform vec2 uInk;
      varying vec2 vCoord;
      uniform float uTime;
      uniform float uI;
      uniform float uFront;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      void main() {
        float along = clamp(vCoord.x, 0.0, 1.0);
        float across = vCoord.y / max(vCoord.x, 1e-4);
        float ax = abs(across);
        float side = smoothstep(1.0, 0.7, ax);
        float rim = smoothstep(0.62, 0.96, ax) * smoothstep(1.0, 0.95, ax);
        float fall = mix(1.0, 0.2, pow(along, 0.65));
        float n = vnoise(vec2(along * 7.0 - uTime * 1.5, across * 2.4)) * 0.6
                + vnoise(vec2(along * 21.0 - uTime * 2.6, across * 8.0)) * 0.4;
        float rays = 0.7 + 0.3 * sin(across * 21.0 + n * 2.2 + uTime * 0.35);
        float body = side * fall * (0.5 + 0.5 * n) * rays;
        float lens = exp(-along * 30.0) * 2.6;
        float front = uFront * smoothstep(0.975, 1.0, along) * side * 1.6
                    + uFront * smoothstep(0.85, 1.0, along) * side * 0.25;
        float I = uI * (body * 0.42 + rim * 0.2 * fall + lens) + front;
        vec3 col = mix(uColorA, uColorB, clamp(ax * 0.8 + along * 0.25, 0.0, 1.0));
        #ifdef DAY
        gl_FragColor = vec4(ink(col * I, uInk), 1.0);
        #else
        gl_FragColor = vec4(col * I, 1.0);
        #endif
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;

  // Light dust drifting from the node to the panel.
  const dustCount = 280;
  const rand = new Float32Array(dustCount * 3);
  const random = seeded(0xd057);
  for (let i = 0; i < dustCount; i++) rand.set([random(), random() * 2 - 1, random()], i * 3);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dustCount * 3), 3));
  dustGeo.setAttribute('aRand', new THREE.BufferAttribute(rand, 3));
  const dustUniforms = {
    uTime: { value: 0 },
    uI: { value: 0 },
    uPx: { value: 1 },
    uApex: { value: new THREE.Vector2() },
    uB0: { value: new THREE.Vector2() },
    uB1: { value: new THREE.Vector2() },
    uInk: { value: new THREE.Vector2(1.5, 0.5) },
  };
  const dustMat = new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aRand;
      uniform float uTime;
      uniform float uI;
      uniform float uPx;
      uniform vec2 uApex;
      uniform vec2 uB0;
      uniform vec2 uB1;
      varying float vA;
      void main() {
        float t = fract(aRand.x + uTime * (0.07 + aRand.z * 0.16));
        vec2 base = mix(uB0, uB1, aRand.y * 0.48 + 0.5);
        vec2 p = mix(uApex, base, t);
        vec2 dir = normalize(base - uApex + 1e-5);
        p += vec2(-dir.y, dir.x) * sin(uTime * 1.7 + aRand.x * 40.0) * 0.004 * t;
        gl_Position = vec4(p, 0.0, 1.0);
        gl_PointSize = (1.0 + t * 2.2) * uPx;
        vA = sin(t * 3.14159) * uI * (0.35 + 0.65 * fract(aRand.x * 13.7));
      }`,
    fragmentShader: /* glsl */ `
      ${INK}
      uniform vec2 uInk;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        #ifdef DAY
        gl_FragColor = vec4(ink(vec3(1.0, 0.9, 0.75) * vA * a, uInk), 1.0);
        #else
        gl_FragColor = vec4(vec3(1.0, 0.9, 0.75), vA * a);
        #endif
      }`,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dust.renderOrder = 21;

  return {
    mesh,
    dust,
    uniforms,
    dustUniforms,
    /** By day the beam is a warm wash on the page, its dust warm specks. */
    setDay(day: boolean) {
      setInk(material, day);
      setInk(dustMat, day);
    },
    /** Apex and base endpoints in NDC. */
    set(ax: number, ay: number, b0x: number, b0y: number, b1x: number, b1y: number) {
      position[0] = ax;
      position[1] = ay;
      position[3] = b0x;
      position[4] = b0y;
      position[6] = b1x;
      position[7] = b1y;
      geometry.attributes.position.needsUpdate = true;
      dustUniforms.uApex.value.set(ax, ay);
      dustUniforms.uB0.value.set(b0x, b0y);
      dustUniforms.uB1.value.set(b1x, b1y);
    },
  };
}
