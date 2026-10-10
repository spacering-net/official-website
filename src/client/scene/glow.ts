import * as THREE from 'three';
import { setVariant } from './ink';

/**
 * The "diamond" — the node's light as a camera sees it: six diffraction
 * spikes along the logo's 30° axes, the pair along the band the longer, and
 * when the node glares (the flash, a scan's flare) a white-hot core and a soft
 * halo over it; otherwise the node shows as what it is, a light in a glass
 * stone (ring.ts). The spikes are hair-thin, never wider than a pixel or two,
 * bright by the light and then falling as a power of the distance, never
 * stopping short; at night a fine grain runs outward along them, as if the
 * light ran through dust. By day they are only a glint on the stone, short
 * and white: light, which shows on the band's dark mirrors and not on the page.
 */
export function createGlow() {
  const uniforms = {
    uCenter: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
    uSize: { value: 0.6 },
    uI: { value: 0 },
    /** the core and halo: none at rest, where the node shows as its stone (ring.ts); 1 in the flash */
    uGlare: { value: 0 },
    uSpike: { value: 0.2 },
    /** the spikes' three axes, the one along the band first (set by aim) */
    uDirs: { value: [new THREE.Vector2(1, 0), new THREE.Vector2(), new THREE.Vector2()] },
    /** how far out the light reaches, in the glow's units: the quad is drawn no larger */
    uExtent: { value: 1 },
    uCore: { value: 0.03 },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color('#ffd9a0') },
    /** the glow's units per device pixel, so the spikes stay a pixel or two wide */
    uPixel: { value: 0.001 },
    /** 1 lets the grain run along the spikes; 0 holds it still */
    uFlow: { value: 1 },
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
      uniform float uExtent;
      varying vec2 vP;
      void main() {
        vP = position.xy * uExtent;
        gl_Position = vec4(uCenter + vec2(vP.x * uSize / uAspect, vP.y * uSize), 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      uniform float uI;
      uniform float uGlare;
      uniform float uSpike;
      uniform vec2 uDirs[3];
      uniform float uExtent;
      uniform float uCore;
      uniform float uTime;
      uniform float uPixel;
      uniform float uFlow;
      uniform vec3 uColor;
      float grainHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
      float grain(float x) {
        float i = floor(x);
        float f = fract(x);
        return mix(grainHash(i), grainHash(i + 1.0), f * f * (3.0 - 2.0 * f));
      }
      // bright by the light, then a long tail that falls as a power of the
      // distance, never stopping short
      float fall(float x, float len) {
        float y = x / (len * 0.2);
        return exp(-x / len) / (1.0 + y * sqrt(y));
      }
      void main() {
        float r = length(vP);
        vec3 spikes = vec3(0.0);
        for (int k = 0; k < 3; k++) {
          vec2 dir = uDirs[k];
          float s = dot(vP, dir);
          float along = abs(s);
          float perp = abs(dot(vP, vec2(-dir.y, dir.x)));
          #ifdef DAY
          float len = uSpike * (k == 0 ? 0.4 : 0.26);
          #else
          float len = uSpike * (k == 0 ? 1.0 : 0.6);
          #endif
          // hair-thin, a little wider far out; finer than a pixel, it is
          // drawn a pixel wide and dimmer, so it neither breaks up nor swells
          float w = 0.0005 + 0.003 * along;
          float wPx = max(w, 0.7 * uPixel);
          float line = exp(-(perp * perp) / (wPx * wPx)) * (w / wPx) * fall(along, len) * (k == 0 ? 1.0 : 0.7);
          #ifdef DAY
          spikes += vec3(line);
          #else
          // at the light itself the point is enough: three spikes crossing
          // there would only swell its bloom over the stone
          line *= 0.25 + 0.75 * smoothstep(0.0, 0.02, along);
          // a grain running outward, each half of each spike on its own
          line *= 0.6 + 0.4 * grain(along * 150.0 - uTime * uFlow * 1.6 + float(k) * 17.0 + step(0.0, s) * 41.0);
          // white by the light, its colour further out
          spikes += mix(vec3(1.0, 0.97, 0.93), uColor, smoothstep(0.0, 0.6, along / len)) * line;
          #endif
        }
        float fade = smoothstep(uExtent, uExtent * 0.75, max(abs(vP.x), abs(vP.y)));
        #ifdef DAY
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * spikes * uI * 7.0 * fade, 1.0);
        #else
        float core = exp(-(r * r) / (uCore * uCore));
        float halo = 0.16 / (1.0 + (r * r) / (uCore * uCore * 16.0));
        float flicker = 0.95 + 0.05 * sin(uTime * 21.0) * sin(uTime * 6.7);
        vec3 col = uColor * (core * 3.0 + halo) * uGlare + vec3(1.0) * core * core * 2.5 * uGlare + spikes * 13.0;
        gl_FragColor = vec4(col * uI * flicker * fade, 1.0);
        #endif
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;

  return {
    mesh,
    uniforms,
    /** Turn the spikes: `angle` is the band's direction at the node, on screen. */
    aim(angle: number) {
      uniforms.uDirs.value.forEach((d, k) => d.set(Math.cos(angle + (k * Math.PI) / 3), Math.sin(angle + (k * Math.PI) / 3)));
    },
    setDay(day: boolean) {
      setVariant(material, day);
    },
  };
}
