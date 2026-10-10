import * as THREE from 'three';

/**
 * A procedural studio for the ring's reflections: long strip lights give the
 * band its sharp highlights, a warm kick near the bead side, an ion-blue rim.
 * By day (`day`) the studio is a white room, the ring a silver one on paper:
 * the same strips, under a bright sky, with dark cards set round it so the
 * band keeps its edges against the page.
 */
export function createEnvironment(renderer: THREE.WebGLRenderer, day = false): THREE.Texture {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];

  const skyGeo = new THREE.SphereGeometry(30, 48, 24);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    defines: day ? { DAY: '' } : {},
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = vDir.y * 0.5 + 0.5;
        #ifdef DAY
        // a white studio, as chrome reflects one: a bright ceiling, a grey
        // floor, and between them a dark line at the horizon
        vec3 floor = mix(vec3(0.07, 0.07, 0.072), vec3(0.62, 0.615, 0.6), smoothstep(0.05, 0.46, h));
        vec3 c = mix(floor, vec3(0.95, 0.945, 0.935), smoothstep(0.485, 0.6, h));
        c *= 1.0 - 0.94 * exp(-pow((h - 0.478) / 0.016, 2.0));
        #else
        vec3 c = mix(vec3(0.0035, 0.0035, 0.005), vec3(0.028, 0.03, 0.04), smoothstep(0.25, 1.0, h));
        // faint horizon band, like a distant atmosphere
        c += vec3(0.02, 0.022, 0.03) * exp(-pow((h - 0.5) * 9.0, 2.0));
        #endif
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
  disposables.push(skyGeo, skyMat);

  const panel = (w: number, h: number, hex: string, intensity: number, pos: [number, number, number]) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex).multiplyScalar(intensity),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...pos);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
    disposables.push(geo, mat);
    return mesh;
  };

  // Two long strips overhead instead of one softbox: the flat rim face then
  // carries crisp lines of light rather than a uniform glare.
  panel(14, 0.9, '#ffffff', 2.6, [0.5, 8, 1]); // overhead strip
  panel(14, 0.5, '#f4f0ff', 1.8, [-1, 7, 4.5]); // second strip, further forward
  if (!day) panel(16, 8, '#ffffff', 0.12, [0, 9, -1]); // very dim dome
  panel(0.7, 14, '#e2eaff', 6.0, [-8, 1.5, 3]); // long cool strip, left
  panel(0.45, 14, '#ffffff', 3.2, [8, -0.5, -1]); // thin strip, right
  if (!day) panel(9, 2.4, '#9adfff', 0.9, [0, 1.5, -9]); // ion rim from behind
  // A concave inner wall mirrors whatever sits below-left, so keep that side
  // broad and dim: a hot panel there reads as a second node. (By day the
  // room itself is the fill.)
  if (!day) panel(12, 5, '#d9dcff', 0.35, [-4, -7, -2]); // broad dim fill, below-left
  panel(5, 1.2, '#ffffff', 1.3, [2.5, -5, 6]); // soft fill from below-front
  if (day) {
    // Dark cards, as round a ring photographed on white: without them a
    // silver band all but vanishes into the page.
    panel(16, 2.2, '#16151a', 1, [0, -2.5, 9]); // low, in front: the near band's lower face
    panel(18, 5, '#0c0c0e', 1, [0, -7, -6]); // below, behind: a dark sweep down the walls
    panel(2.4, 12, '#16151a', 1, [9, 0.5, 2]); // tall, to the right
    panel(10, 1.4, '#16151a', 1, [-1, 3.5, -9]); // behind, above the horizon: the far wall's inner face
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  disposables.forEach((d) => d.dispose());
  return target.texture;
}
