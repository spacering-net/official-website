// Renders the ring card's background from the homepage's scene, posed for the
// card, and the engraving that goes with it. Two stills of one frame, alike
// but for the band's ink: none (the background) and everywhere (what an
// engraved letter looks like, wherever one can be). The card masks the
// second with the holder's number, lettered as the band letters it, so it
// carries the homepage's engraving (src/lib/ring-card.ts).
//
// Writes public/ring-card/art.jpg (2400 × 1260, for pages), art-1200.jpg (for
// the Worker and the dialog's preview), engraved.jpg (the inked band, at 2×),
// and src/lib/ring-card-still.ts (where the band's ink lands on the card).
// Bump CARD_REVISION in src/lib/ring-card.ts after running it.
// Run against `pnpm dev` or `pnpm preview`: node scripts/ring-card-art.mjs [baseUrl]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import encode, { init as initJpeg } from '@jsquash/jpeg/encode.js';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4321';
const [W, H] = [1200, 630];
/** The ring on the card: centre and outer radius in card units, rolled as on the homepage. */
const POSE = { x: 850, y: 315, r: 205, roll: -30, band: 0 };
/** The scene's clock for the stills: where its slow sway is nearly at rest. */
const TIME = 40.5;
/** Where the ink canvas's points land, sampled every this many of its pixels. */
const [STEP_X, STEP_Y] = [32, 16];
const [INK_W, INK_H] = [1024, 128];
/** Around the band's ink, the engraved still is kept this much wider, in card units. */
const MARGIN = 6;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, locale: 'en-US' });
// The page's clock is the script's: the scene draws a frame per step of it,
// never falling behind (which would lower its resolution), and the intro is
// the short one.
await page.clock.install({ time: new Date('2026-10-08T00:00:00Z') });
await page.addInitScript(() => sessionStorage.setItem('sr-intro', '1'));
await page.goto(`${base}/?capture&quality=high`, { waitUntil: 'load' });
// No scrollbar: the page keeps a gutter for one, which the scene's canvas leaves out.
await page.addStyleTag({ content: 'html { scrollbar-width: none !important; }' });
await page.evaluate(() => document.fonts.load('500 84px "IBM Plex Mono"'));
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
for (let i = 0; i < 60 && !(await page.evaluate(() => window.__srCapture?.ready())); i++) await page.clock.runFor(500);
await page.evaluate((pose) => {
  window.__srCapture.alone();
  window.__srCapture.pose(pose);
}, POSE);
// the glow of the last projection fades
await page.clock.runFor(4000);

const shots = await page.evaluate(
  ({ pose, time, stepX, stepY, inkW, inkH }) => {
    const c = window.__srCapture;
    c.pose(pose);
    c.ink(false);
    const plain = c.shot(time);
    c.ink(true);
    const inked = c.shot(time);
    const points = [];
    for (let y = 0; y <= inkH; y += stepY) for (let x = 0; x <= inkW; x += stepX) points.push(...c.inkToScreen(x, y));
    const canvas = document.getElementById('scene');
    return { plain, inked, points, size: [canvas.width, canvas.height] };
  },
  { pose: POSE, time: TIME, stepX: STEP_X, stepY: STEP_Y, inkW: INK_W, inkH: INK_H },
);
await browser.close();
if (shots.size[0] !== W * 2 || shots.size[1] !== H * 2) throw new Error(`the scene drew at ${shots.size.join(' × ')}, not ${W * 2} × ${H * 2}`);
const png = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

// the pictures, through resvg (which reads PNG) to MozJPEG, as the Worker saves cards
const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
await initJpeg(new WebAssembly.Module(readFileSync(new URL('../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', import.meta.url))));
async function save(file, still, { x = 0, y = 0, width = W, height = H, scale, quality }) {
  const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
  const resvg = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${width} ${height}"><image href="https://art.invalid/still" width="${W}" height="${H}"/></svg>`,
  );
  resvg.resolveImage('https://art.invalid/still', still);
  const { pixels } = resvg.render();
  const jpeg = await encode({ data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width: w, height: h }, { quality });
  writeFileSync(new URL(`../public/ring-card/${file}`, import.meta.url), new Uint8Array(jpeg));
  console.log(`wrote public/ring-card/${file} (${w} × ${h}, ${Math.round(jpeg.byteLength / 1024)} KB)`);
}

const xs = shots.points.filter((_, i) => i % 2 === 0);
const ys = shots.points.filter((_, i) => i % 2 === 1);
const engraved = {
  x: Math.floor(Math.min(...xs) - MARGIN),
  y: Math.floor(Math.min(...ys) - MARGIN),
  width: 0,
  height: 0,
};
engraved.width = Math.ceil(Math.max(...xs) + MARGIN) - engraved.x;
engraved.height = Math.ceil(Math.max(...ys) + MARGIN) - engraved.y;

await save('art.jpg', png(shots.plain), { scale: 2, quality: 82 });
await save('art-1200.jpg', png(shots.plain), { scale: 1, quality: 82 });
await save('engraved.jpg', png(shots.inked), { ...engraved, scale: 2, quality: 90 });

const round = (n) => Math.round(n * 100) / 100;
writeFileSync(
  new URL('../src/lib/ring-card-still.ts', import.meta.url),
  `// Written by scripts/ring-card-art.mjs: where the band's ink lands on the ring card.
export const STILL = {
  /** the ring's pose on the card (card units) and the scene's clock */
  pose: ${JSON.stringify(POSE)},
  time: ${TIME},
  /** the part of the card /ring-card/engraved.jpg covers */
  engraved: ${JSON.stringify(engraved)},
  /**
   * Where points of the ink canvas (src/lib/inscription.ts) are on the card:
   * every ${STEP_X} of its pixels across and ${STEP_Y} down, row by row, as x, y pairs.
   */
  grid: { stepX: ${STEP_X}, stepY: ${STEP_Y}, columns: ${INK_W / STEP_X + 1}, rows: ${INK_H / STEP_Y + 1} },
  points: [${shots.points.map(round).join(', ')}],
} as const;
`,
);
console.log('wrote src/lib/ring-card-still.ts');
