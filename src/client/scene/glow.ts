import * as THREE from 'three';

/**
 * The "diamond" — the node's light as seen by a camera: a white-hot core,
 * a soft halo and six diffraction spikes aligned with the logo's 30° axes.
 */
export function createGlow() {
  const uniforms = {
    uCenter: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
    uSize: { value: 0.6 },
    uI: { value: 0 },
    uSpike: { value: 0.2 },
    uAngle: { value: 0 },
    uCore: { value: 0.03 },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color('#ffd9a0') },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform vec2 uCenter;
      uniform float uAspect;
      uniform float uSize;
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = vec4(uCenter + vec2(position.x * uSize / uAspect, position.y * uSize), 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      uniform float uI;
      uniform float uSpike;
      uniform float uAngle;
      uniform float uCore;
      uniform float uTime;
      uniform vec3 uColor;
      void main() {
        float r = length(vP);
        float core = exp(-(r * r) / (uCore * uCore));
        float halo = 0.16 / (1.0 + pow(r / (uCore * 4.0), 2.0));
        float spikes = 0.0;
        for (int k = 0; k < 3; k++) {
          float a = uAngle + float(k) * 1.0471976;
          vec2 dir = vec2(cos(a), sin(a));
          float along = abs(dot(vP, dir));
          float perp = abs(dot(vP, vec2(-dir.y, dir.x)));
          float w = 0.0035 + along * 0.01;
          spikes += exp(-(perp * perp) / (w * w)) * exp(-along / max(uSpike, 1e-3)) * (k == 0 ? 1.0 : 0.7);
        }
        float flicker = 0.95 + 0.05 * sin(uTime * 21.0) * sin(uTime * 6.7);
        float fade = smoothstep(1.0, 0.75, max(abs(vP.x), abs(vP.y)));
        vec3 col = uColor * (core * 3.0 + halo + spikes * 1.5) + vec3(1.0) * core * core * 2.5;
        gl_FragColor = vec4(col * uI * flicker * fade, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;
  return { mesh, uniforms };
}
