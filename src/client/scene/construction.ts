import * as THREE from 'three';
import { PHI } from '../math';
import { RING } from './ring';
import { INK, setInk } from './ink';

/**
 * The logo's construction drawing, in 3D: axes and circle projections drawn
 * with the same dash-dot line style as the construction SVG. Shown during
 * the intro while the ring "calibrates".
 */
export function createConstruction() {
  const pos: number[] = [];
  const dist: number[] = [];
  const prog: number[] = [];

  const polyline = (pts: THREE.Vector3[], delay: number) => {
    let total = 0;
    const acc = [0];
    for (let i = 1; i < pts.length; i++) {
      total += pts[i].distanceTo(pts[i - 1]);
      acc.push(total);
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      dist.push(acc[i - 1], acc[i]);
      prog.push(delay + (acc[i - 1] / total) * (1 - delay), delay + (acc[i] / total) * (1 - delay));
    }
  };
  const circle = (r: number, y: number, delay: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r));
    }
    polyline(pts, delay);
  };

  const L = 2.15;
  polyline([new THREE.Vector3(-L, 0, 0), new THREE.Vector3(L, 0, 0)], 0);
  polyline([new THREE.Vector3(0, 0, -L), new THREE.Vector3(0, 0, L)], 0.08);
  circle(RING.Ri, RING.H, 0.18);
  circle(RING.Ri, -RING.H, 0.26);
  circle(RING.Ro, 0, 0.32);
  circle(RING.Ro * PHI, 0, 0.4);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  geometry.setAttribute('aProg', new THREE.Float32BufferAttribute(prog, 1));

  const uniforms = { uDraw: { value: 0 }, uAlpha: { value: 0 }, uInk: { value: new THREE.Vector2(1, 1.6) } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aDist;
      attribute float aProg;
      varying float vDist;
      varying float vProg;
      void main() {
        vDist = aDist;
        vProg = aProg;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${INK}
      varying float vDist;
      varying float vProg;
      uniform float uDraw;
      uniform float uAlpha;
      uniform vec2 uInk;
      void main() {
        if (vProg > uDraw) discard;
        // dash-dot 14 3 2 3, in units of 0.01
        float m = mod(vDist * 100.0, 22.0);
        if (!(m < 14.0 || (m >= 17.0 && m < 19.0))) discard;
        float head = smoothstep(uDraw - 0.04, uDraw, vProg);
        vec3 col = vec3(0.93, 0.92, 0.96) * (0.55 + head * 1.6);
        #ifdef DAY
        // in graphite, as the logo's construction sheet is drawn
        gl_FragColor = vec4(ink(col * uAlpha, uInk), 1.0);
        #else
        gl_FragColor = vec4(col, uAlpha);
        #endif
      }`,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 15;
  return {
    lines,
    uniforms,
    setDay(day: boolean) {
      setInk(material, day);
    },
  };
}
