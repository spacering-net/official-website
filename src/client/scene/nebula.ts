import * as THREE from 'three';
import { SIMPLEX } from './glsl';
import { seeded } from '../math';

/**
 * Full-screen backdrop: a faint nebula. The fbm is expensive and nearly
 * static, so it is baked into a low-resolution texture on resize and drawn
 * as a plain textured quad every frame.
 */
export function createNebula() {
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
  const bakeUniforms = { uAspect: { value: 1 }, uSeed: { value: seeded(0x9eb1a)() * 100 } };
  const bakeScene = new THREE.Scene();
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bakeMaterial = new THREE.ShaderMaterial({
    uniforms: bakeUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${SIMPLEX}
      varying vec2 vUv;
      uniform float uAspect;
      uniform float uSeed;
      float fbm(vec3 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) { s += a * snoise(p); p *= 2.03; a *= 0.5; }
        return s;
      }
      void main() {
        vec2 p = vUv;
        p.x *= uAspect;
        float n = fbm(vec3(p * 1.25, uSeed));
        float m = fbm(vec3(p * 2.6 + 11.0, uSeed * 0.7));
        vec3 indigo = vec3(0.016, 0.012, 0.034);
        vec3 teal = vec3(0.004, 0.02, 0.026);
        vec3 col = mix(indigo, teal, smoothstep(-0.35, 0.55, m)) * smoothstep(-0.25, 0.75, n);
        col += vec3(0.010, 0.008, 0.016) * smoothstep(0.2, 0.9, n * m + 0.3);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
  quad.frustumCulled = false;
  bakeScene.add(quad);

  const uniforms = {
    uIntensity: { value: 0 },
    tNebula: { value: target.texture },
    uShift: { value: new THREE.Vector2() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tNebula;
      uniform float uIntensity;
      uniform vec2 uShift;
      varying vec2 vUv;
      void main() {
        vec2 uv = (vUv - 0.5) * 0.96 + 0.5 + uShift;
        gl_FragColor = vec4(texture2D(tNebula, uv).rgb * uIntensity, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -30;

  return {
    mesh,
    uniforms,
    /** Re-bake at a quarter of the CSS size; the nebula has no fine detail. */
    bake(renderer: THREE.WebGLRenderer, cssWidth: number, cssHeight: number) {
      const w = Math.max(64, Math.round(cssWidth / 4));
      const h = Math.max(64, Math.round(cssHeight / 4));
      target.setSize(w, h);
      bakeUniforms.uAspect.value = cssWidth / Math.max(1, cssHeight);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(bakeScene, bakeCamera);
      renderer.setRenderTarget(prev);
    },
  };
}
