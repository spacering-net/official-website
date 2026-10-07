import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * One full-screen pass instead of two: ACES tone mapping + sRGB output
 * (what OutputPass does) plus radial chromatic aberration, vignette and grain.
 */
const FinalShader = {
  name: 'SpaceRingFinal',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    toneMappingExposure: { value: 1 },
    uTime: { value: 0 },
    uCA: { value: 0.006 },
    uGrain: { value: 0.03 },
    uVignette: { value: 0.32 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uCA;
    uniform float uGrain;
    uniform float uVignette;
    uniform vec2 uRes;
    varying vec2 vUv;
    // sRGBTransferOETF comes from the ShaderMaterial prefix; tone mapping is
    // ours, so the material sets toneMapped = false to avoid a second copy.
    #include <tonemapping_pars_fragment>
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 c = vUv - 0.5;
      vec2 off = c * dot(c, c) * uCA * 4.0;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv - off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv + off).b
      );
      col = ACESFilmicToneMapping(col);
      vec4 outColor = sRGBTransferOETF(vec4(col, 1.0));
      vec2 q = c * vec2(uRes.x / uRes.y, 1.0);
      float vig = 1.0 - smoothstep(0.35, 1.05, length(q));
      outColor.rgb *= mix(1.0, vig, uVignette);
      outColor.rgb += (hash(vUv * uRes + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
      gl_FragColor = vec4(outColor.rgb, 1.0);
    }`,
};

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  samples: number,
) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.62, 0.42, 0.9);
  // Bloom is a blur; at high pixel ratios it can run at half resolution.
  const bloomSetSize = bloom.setSize.bind(bloom);
  let bloomScale = 1;
  bloom.setSize = (w: number, h: number) => bloomSetSize(Math.round(w * bloomScale), Math.round(h * bloomScale));
  composer.addPass(bloom);

  const final = new ShaderPass(FinalShader);
  final.material.toneMapped = false;
  composer.addPass(final);

  return {
    composer,
    bloom,
    final,
    setBloomScale(scale: number) {
      bloomScale = scale;
    },
    /** MSAA only pays off at low pixel ratios. */
    setSamples(n: number) {
      for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
        if (rt.samples !== n) {
          rt.samples = n;
          rt.dispose();
        }
      }
    },
  };
}
