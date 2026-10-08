/**
 * Fonts for rendering ring cards. The card's own type (Jost, IBM Plex Mono,
 * and the few Chinese characters of its labels) ships with the site under
 * /ring-card/fonts/ (scripts/ring-card-fonts.mjs). A holder's name can be in
 * any script: what those files lack is asked of Google Fonts, which cuts a
 * font down to the characters it is asked for (the `text` parameter).
 */

/** The files under /ring-card/fonts/, and the family each one is. */
export const CARD_FONTS = ['Jost-Light.ttf', 'Jost-Regular.ttf', 'Jost-Medium.ttf', 'IBMPlexMono-Regular.ttf', 'IBMPlexMono-Medium.ttf', 'NotoSansSC-Card.ttf'] as const;

/** The faces the renderer draws with: its own families first, then whatever a name needed. */
export const RENDER_FACES = {
  display: 'Jost, Noto Sans, Noto Sans SC, Noto Sans KR, Noto Sans JP, Noto Sans Arabic, Noto Sans Hebrew, Noto Sans Thai, Noto Sans Devanagari, Noto Sans Bengali, Noto Sans Tamil, Noto Emoji',
  mono: 'IBM Plex Mono, Noto Sans SC',
};

/** Which Google Fonts family to ask for a character the card's fonts lack; the first that matches. */
const FALLBACKS: [RegExp, string][] = [
  [/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}]/u, 'Noto Emoji'],
  [/\p{Script=Hangul}/u, 'Noto Sans KR'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'Noto Sans JP'],
  [/[\p{Script=Han}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]/u, 'Noto Sans SC'],
  [/\p{Script=Arabic}/u, 'Noto Sans Arabic'],
  [/\p{Script=Hebrew}/u, 'Noto Sans Hebrew'],
  [/\p{Script=Thai}/u, 'Noto Sans Thai'],
  [/\p{Script=Devanagari}/u, 'Noto Sans Devanagari'],
  [/\p{Script=Bengali}/u, 'Noto Sans Bengali'],
  [/\p{Script=Tamil}/u, 'Noto Sans Tamil'],
  // Latin, Greek, Cyrillic and the rest of what Jost lacks
  [/./su, 'Noto Sans'],
];

/** Characters fonts do not draw (joiners, variation selectors, tags): never a reason to look further. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cc}]/u;

export interface Font {
  bytes: Uint8Array;
  covers: (cp: number) => boolean;
}

/**
 * What a TrueType or OpenType font draws: the code points its character map
 * (cmap) gives a glyph, from its Unicode subtables (formats 4 and 12).
 */
export function readFont(bytes: Uint8Array): Font {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ranges: [number, number][] = [];
  const tables = view.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    if (String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]) === 'cmap') cmap = view.getUint32(at + 8);
  }
  if (cmap >= 0) {
    // the fullest Unicode subtable: format 12 over format 4
    let best = -1;
    let bestFormat = 0;
    const subtables = view.getUint16(cmap + 2);
    for (let i = 0; i < subtables; i++) {
      const at = cmap + 4 + i * 8;
      const platform = view.getUint16(at);
      const encoding = view.getUint16(at + 2);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) continue;
      const offset = cmap + view.getUint32(at + 4);
      const format = view.getUint16(offset);
      if ((format === 12 || format === 4) && format > bestFormat) {
        best = offset;
        bestFormat = format;
      }
    }
    if (bestFormat === 12) {
      const groups = view.getUint32(best + 12);
      for (let g = 0; g < groups; g++) {
        const at = best + 16 + g * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const glyph = view.getUint32(at + 8);
        // a group mapped from glyph 0 (the missing glyph) starts one later
        ranges.push([glyph === 0 ? start + 1 : start, end]);
      }
    } else if (bestFormat === 4) {
      const segments = view.getUint16(best + 6) / 2;
      const ends = best + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const rangeOffsets = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const start = view.getUint16(starts + s * 2);
        const end = view.getUint16(ends + s * 2);
        const delta = view.getUint16(deltas + s * 2);
        const rangeOffset = view.getUint16(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
          else {
            const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
            glyph = at + 1 < bytes.byteLength ? view.getUint16(at) : 0;
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph === 0) continue;
          const last = ranges[ranges.length - 1];
          if (last && last[1] === c - 1) last[1] = c;
          else ranges.push([c, c]);
        }
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const covers = (cp: number) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < ranges[mid][0]) hi = mid - 1;
      else if (cp > ranges[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
  return { bytes, covers };
}

/** The visible characters of `text` that none of `fonts` draws. */
export function missing(text: string, fonts: Font[]): string[] {
  const out = new Set<string>();
  for (const ch of text) {
    if (INVISIBLE.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    if (!fonts.some((f) => f.covers(cp))) out.add(ch);
  }
  return [...out];
}

/** The families to ask for, each with the characters it is asked for. */
export function fallbackFamilies(chars: string[]): Map<string, string> {
  const families = new Map<string, string>();
  for (const ch of chars) {
    const family = FALLBACKS.find(([re]) => re.test(ch))![1];
    families.set(family, (families.get(family) ?? '') + ch);
  }
  return families;
}

/**
 * Fonts from Google Fonts for these characters: one cut-down file per
 * family that has any of them. Throws if Google cannot be reached, so a card
 * rendered without them is not kept.
 */
export async function fetchFallbacks(chars: string[], timeoutMs = 4000): Promise<Font[]> {
  const families = fallbackFamilies(chars);
  if (!families.size) return [];
  const signal = AbortSignal.timeout(timeoutMs);
  const fonts = await Promise.all(
    [...families].map(async ([family, text]) => {
      // one family per request: the `text` cut applies to every family asked for at once
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&text=${encodeURIComponent(text)}`;
      // an unknown client gets TrueType files, which the renderer reads (not WOFF2)
      const css = await fetch(url, { signal, headers: { 'User-Agent': 'SpaceRing card renderer' } });
      if (css.status === 400) return []; // a family with none of these characters
      if (!css.ok) throw new Error(`Google Fonts answered ${css.status} for ${family}`);
      const files = [...(await css.text()).matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g)].map((m) => m[1]);
      return Promise.all(
        files.map(async (file) => {
          const res = await fetch(file, { signal });
          if (!res.ok) throw new Error(`Google Fonts answered ${res.status} for a ${family} file`);
          return readFont(new Uint8Array(await res.arrayBuffer()));
        }),
      );
    }),
  );
  return fonts.flat();
}

/**
 * `text` with the characters no font here draws left out, and the spaces
 * that leaves behind tidied. Better a name a little short than with boxes.
 */
export function drawable(text: string, fonts: Font[]): string {
  const gaps = new Set(missing(text, fonts));
  if (!gaps.size) return text;
  return [...text]
    .filter((ch) => !gaps.has(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
