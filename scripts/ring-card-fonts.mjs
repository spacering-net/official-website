// Fetches the fonts the Worker renders ring cards with into public/ring-card/fonts/:
// TrueType files from Google Fonts (the renderer cannot read WOFF2), cut down
// to what the card draws, and each family's licence. Names in other scripts
// get their fonts at render time (api/rings/fonts.ts).
// Run after changing the card's words (CARD_WORDS in src/lib/ring-card.ts),
// then bump CARD_REVISION there:
// node --import ./tests/harness/register.mjs scripts/ring-card-fonts.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { CARD_WORDS } from '../src/lib/ring-card.ts';

const dir = new URL('../public/ring-card/fonts/', import.meta.url);
mkdirSync(dir, { recursive: true });

// the card's own words beyond ASCII (the Chinese labels)
const cjk = [...new Set(Object.values(CARD_WORDS).flatMap((w) => [...Object.values(w).join('')]).filter((c) => c > '\u007f'))].join('');

/**
 * [file, family and weight, text to keep (all of it when empty)]. Whole
 * files, as Google Fonts serves them, except the Chinese one, which would be
 * megabytes: a font cut down is a modified version, which may not carry a
 * reserved name (IBM Plex has one), and Noto Sans SC's ("Source") is not in
 * its name.
 */
const FILES = [
  ['Jost-Light.ttf', 'Jost:wght@300', ''],
  ['Jost-Regular.ttf', 'Jost:wght@400', ''],
  ['Jost-Medium.ttf', 'Jost:wght@500', ''],
  ['IBMPlexMono-Regular.ttf', 'IBM Plex Mono:wght@400', ''],
  ['IBMPlexMono-Medium.ttf', 'IBM Plex Mono:wght@500', ''],
  ['NotoSansSC-Card.ttf', 'Noto Sans SC:wght@400', cjk],
];

const LICENCES = [
  ['OFL-Jost.txt', 'jost'],
  ['OFL-IBMPlexMono.txt', 'ibmplexmono'],
  ['OFL-NotoSansSC.txt', 'notosanssc'],
];

for (const [file, family, text] of FILES) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
  // an unknown client is sent TrueType
  const css = await (await fetch(url, { headers: { 'User-Agent': 'SpaceRing card fonts' } })).text();
  const src = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)\s*format\('truetype'\)/.exec(css)?.[1];
  if (!src) throw new Error(`no TrueType file for ${family}:\n${css}`);
  const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
  writeFileSync(new URL(file, dir), bytes);
  console.log(`wrote public/ring-card/fonts/${file} (${(bytes.length / 1024).toFixed(1)} KB)`);
}

for (const [file, slug] of LICENCES) {
  const res = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${slug}/OFL.txt`);
  if (!res.ok) throw new Error(`no licence for ${slug}: ${res.status}`);
  writeFileSync(new URL(file, dir), await res.text());
  console.log(`wrote public/ring-card/fonts/${file}`);
}
