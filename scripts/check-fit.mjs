// Layout fit: every projected panel must sit below the HUD and inside the viewport.
// Usage: node scripts/check-fit.mjs [baseUrl]
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:4321';
const sizes = [[1920, 1080], [1536, 864], [1440, 900], [1366, 768], [1280, 800], [1100, 760], [1024, 768], [900, 800], [768, 1024], [768, 900], [761, 821], [844, 390], [667, 375], [568, 320], [390, 844], [360, 800], [320, 568], [320, 320]];
// Counts hologram cells cut down to a sliver of their text, and rows wider than their box.
const CRAMPED = `window.cramped = (holo) => {
  let n = 0;
  for (const cell of holo.querySelectorAll('li > span, .holo__bar > span')) {
    if (cell.offsetParent !== null && cell.scrollWidth > cell.clientWidth + 1 && cell.clientWidth < 40) n++;
  }
  for (const row of holo.querySelectorAll('li, .holo__bar, .holo__foot')) if (row.scrollWidth > row.clientWidth + 1) n++;
  return n;
};`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=metal'] });
let failures = 0;
for (const lang of ['/', '/zh/']) {
  for (const [w, h] of sizes) {
    const mobile = w < 700;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, locale: lang === '/' ? 'en-US' : 'zh-CN' });
    const page = await ctx.newPage();
    await page.addInitScript(CRAMPED);
    await page.goto(`${base}${lang}#space`, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const ids = await page.evaluate(() => [...document.querySelectorAll('.chapter[data-chapter]')].map((c) => c.id));
    const row = [];
    for (const id of ids) {
      const r = await page.evaluate((id) => {
        const el = document.getElementById(id).querySelector('[data-projection]');
        const b = el.getBoundingClientRect();
        // the HUD bar is taller than what it draws; panels may pass under its empty margin
        const hud = Math.max(...[...document.querySelectorAll('.hud .brand, .hud .menu-btn')].map((e) => e.getBoundingClientRect().bottom)) + 6;
        const holo = el.querySelector('.holo');
        const shown = holo ? getComputedStyle(holo).display !== 'none' : null;
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), hud, vh: innerHeight, holo: shown, cramped: shown ? cramped(holo) : 0 };
      }, id);
      const ok = r.top >= r.hud && r.bottom <= r.vh - 4 && !r.cramped;
      if (!ok) failures++;
      row.push(`${ok ? '' : '✗'}${id.slice(0, 6)}:${r.top}-${r.bottom}${r.holo === null ? '' : r.holo ? '+h' : ''}${r.cramped ? `!${r.cramped}` : ''}`);
    }
    console.log(`${lang.padEnd(4)} ${String(w).padStart(4)}x${String(h).padEnd(4)} ${row.join(' ')}`);
    await ctx.close();
  }
}
// Without JS every chapter is a plain block, holograms included.
for (const lang of ['/', '/zh/']) {
  for (const [w, h] of [[320, 568], [768, 1024]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.addInitScript(CRAMPED);
    await page.goto(`${base}${lang}`, { waitUntil: 'load' });
    const bad = await page.evaluate(new Function(`${CRAMPED}; return [...document.querySelectorAll('.holo')].map((h) => cramped(h));`));
    const n = bad.reduce((a, b) => a + b, 0);
    if (n) failures++;
    console.log(`${lang.padEnd(4)} ${w}x${h} no-js holograms: ${n ? `✗ ${bad.join(',')}` : 'ok'}`);
    await ctx.close();
  }
}
await browser.close();
console.log(failures ? `${failures} problem(s)` : 'all panels fit');
process.exit(failures ? 1 : 0);
