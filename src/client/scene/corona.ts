import * as THREE from 'three';
import { RING } from './ring';
import { INK, setInk } from './ink';

/**
 * The eclipse corona: a glow in the ring's plane, just outside the band,
 * with slow radial streamers. Drawn before the ring so the band occludes it.
 */
export function createCorona() {
  const extent = RING.Ro * 3.2;
  const uniforms = {
    uTime: { value: 0 },
    uI: { value: 0 },
    uRo: { value: RING.Ro },
    uInk: { value: new THREE.Vector2(1.2, 0.35) },
  };
  const geometry = new THREE.PlaneGeometry(extent * 2, extent * 2);
  geometry.rotateX(-Math.PI / 2);
  // Opaque list + additive blending: drawn after the nebula/stars and before
  // the ring, so the band always occludes it.
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vXZ = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${INK}
      varying vec2 vXZ;
      uniform float uTime;
      uniform float uI;
      uniform float uRo;
      uniform vec2 uInk;
      void main() {
        float r = length(vXZ);
        float a = atan(vXZ.x, vXZ.y);
        float x = (r - uRo) / uRo;
        float inside = smoothstep(-0.06, 0.015, x);
        float limb = exp(-max(x, 0.0) * 7.0) * inside;
        float t = uTime;
        float s1 = 0.5 + 0.25 * sin(a * 3.0 + sin(a * 2.0 + t * 0.07) * 1.7 + t * 0.03)
                       + 0.25 * sin(a * 5.0 - t * 0.05 + 1.3);
        float s2 = 0.5 + 0.5 * sin(a * 11.0 + sin(a * 4.0 - t * 0.09) * 2.2);
        float streams = (pow(s1, 2.2) * exp(-max(x, 0.0) * 2.4) + 0.6 * pow(s2, 3.0) * exp(-max(x, 0.0) * 4.0)) * inside;
        float edge = 1.0 - smoothstep(1.4, 2.15, x);
        float I = (limb * 1.25 + streams * 0.75) * edge * uI;
        vec3 col = mix(vec3(1.0, 0.93, 0.84), vec3(0.72, 0.84, 1.0), clamp(x * 1.6, 0.0, 1.0));
        #ifdef DAY
        // a wash of the corona's own colours round the ring, as in the old eclipse plates
        gl_FragColor = vec4(ink(col * I, uInk), 1.0);
        #else
        gl_FragColor = vec4(col * I, 1.0);
        #endif
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return {
    mesh,
    uniforms,
    setDay(day: boolean) {
      setInk(material, day);
    },
  };
}
