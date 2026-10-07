import { chromium } from 'playwright';
const variants = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
for (const v of variants) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US' });
  const [q, off] = v.split('|');
  await page.goto(`http://localhost:4321/?quality=${q}${off ? `&off=${off}` : ''}`, { waitUntil: 'load' });
  await page.waitForTimeout(5200);
  // force GPU sync each frame by reading a pixel, so rAF timing reflects GPU cost
  const ms = await page.evaluate(() => new Promise((r) => {
    const c = document.getElementById('scene');
    const gl = c.getContext('webgl2');
    const px = new Uint8Array(4);
    let n = 0; const s = performance.now();
    const f = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (++n < 90) requestAnimationFrame(f); else r((performance.now() - s) / 90); };
    requestAnimationFrame(f);
  }));
  console.log(v.padEnd(34), ms.toFixed(2), 'ms');
  await page.close();
}
await browser.close();
