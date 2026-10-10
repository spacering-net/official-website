import * as THREE from 'three';

/**
 * Day: the light theme, where the scene is drawn on paper. The ring is metal
 * in a white room (environment.ts, ring.ts); everything that adds light to
 * the night (stars, the orbit field, the corona, the beam, the construction
 * lines) leaves ink instead, multiplied into what lies under it. The colours
 * keep their roles, as the page's do in ink on paper. Only the node's glint
 * stays light (glow.ts): it shows on the band's dark mirrors, as a glint does.
 */

/** The page in the light theme: site.css's `--void` there. */
export const PAPER = new THREE.Color('#f6f5f1');
export const NIGHT = new THREE.Color('#050507');

/**
 * The ink a light leaves: what passes, 0–1 per channel, for light `L` (what
 * the layer adds to the night, alpha included). Ink takes away the colours the
 * light lacks, so a warm light leaves a warm tint and a cool light a cool one
 * (`k.x`), and some of every colour, so white light leaves graphite (`k.y`).
 * Overlapping layers multiply, as their light added up: denser, not brighter.
 */
export const INK = /* glsl */ `
vec3 ink(vec3 L, vec2 k) {
  float m = max(L.r, max(L.g, L.b));
  return exp(-(k.x * (m - L) + k.y * m));
}
`;

/**
 * A shader's day variant: its code under `#ifdef DAY`. A variant rather than a
 * branch on a uniform, which the GPU would pay for at night as well (about a
 * quarter more for the glow); the other theme's are compiled ahead of a
 * switch (Stage.prepareSwitch), and both stay.
 */
export function setVariant(material: THREE.Material, day: boolean) {
  const defines = (material.defines ??= {});
  if (day === 'DAY' in defines) return;
  if (day) defines.DAY = '';
  else delete defines.DAY;
  material.needsUpdate = true;
}

/** Layers that add light at night multiply their ink into the frame by day. */
export function setInk(material: THREE.Material, day: boolean) {
  setVariant(material, day);
  if (day) {
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.ZeroFactor;
    material.blendDst = THREE.SrcColorFactor;
    material.blendEquationAlpha = THREE.AddEquation;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  } else {
    material.blending = THREE.AdditiveBlending;
  }
}
