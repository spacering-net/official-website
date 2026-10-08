/**
 * The ring card: a holder's ring, their number engraved inside its band as
 * the homepage engraves it, and set beside it with the date the ring was
 * forged and, if the holder chooses, their name and picture.
 *
 * One drawing for everywhere it appears. The account dialog's preview and
 * the card's page put it inline, with the page's fonts; the Worker renders
 * the same SVG to a JPEG for link previews and downloads (api/rings/render.ts),
 * with font files of its own. So nothing here may depend on measuring text:
 * monospace lines are laid out by their advance (0.6 em in IBM Plex Mono),
 * everything else starts at the left edge or ends at the right one.
 */
import { MARK_BAND, MARK_CRESCENT } from '../components/mark';
import { INK, inkLetters } from './inscription';
import { STILL } from './ring-card-still';

export type CardLang = 'en' | 'zh';

export interface RingCard {
  number: number;
  /** shown only if the holder chose to */
  name: string | null;
  /** the holder's picture, if shown: an /api/avatars/ address on this site */
  image: string | null;
  /** when the ring was forged (the account was made), as an ISO time */
  since: string;
  lang: CardLang;
}

/** The card's size in its own units: the link-preview size, 1.91 : 1. */
export const CARD_W = 1200;
export const CARD_H = 630;

/**
 * The drawing's revision. Rendered cards are cached under addresses that
 * include it: bump it whenever the drawing, its art or its fonts change.
 */
export const CARD_REVISION = 2;

/**
 * The background: the homepage's ring, posed for the card, its band not yet
 * inked (scripts/ring-card-art.mjs). At 2× for pages... The revision in the
 * address keeps a browser from pairing a picture it kept with another
 * capture's engraving (STILL).
 */
export const CARD_ART = `/ring-card/art.jpg?v=${CARD_REVISION}`;
/** ...and at 1×, for the Worker's renders and the dialog's preview. */
export const CARD_ART_SMALL = `/ring-card/art-1200.jpg?v=${CARD_REVISION}`;
/** The same still with the band inked all over, around the ink (STILL.engraved), at 2×. */
export const CARD_ENGRAVED = `/ring-card/engraved.jpg?v=${CARD_REVISION}`;

/** Font stacks for the two faces the card uses. */
export interface CardFaces {
  display: string;
  mono: string;
}

/** On the site's pages: the stacks of site.css, so the inline card matches the page's type. */
export const PAGE_FACES: CardFaces = {
  display:
    "'Jost Variable', 'Jost', 'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, 'PingFang SC', 'Microsoft YaHei', monospace",
};

/**
 * The words drawn on the card. The Worker's fonts carry exactly these
 * characters beyond ASCII (scripts/ring-card-fonts.mjs): run that script
 * again after changing them.
 */
export const CARD_WORDS: Record<CardLang, { forged: string; holder: string }> = {
  en: { forged: 'FORGED', holder: 'HOLDER' },
  zh: { forged: '锻造于', holder: '持有人' },
};

/** What the card says, for screen readers and as a link preview's description of its picture. */
export function cardLabel(c: RingCard): string {
  return c.lang === 'zh'
    ? `SpaceRing 戒指卡片：SRN ${c.number}${c.name ? `，${c.name}` : ''}，锻造于 ${forgedOn(c.since)}`
    : `SpaceRing ring card: SRN ${c.number}${c.name ? `, ${c.name}` : ''}, forged ${forgedOn(c.since)}`;
}

/** The card's page, as the card prints it: spacering.net/ring/10000, or /zh/ring/ for a card in Chinese. */
export const cardAddress = (c: Pick<RingCard, 'number' | 'lang'>) => `spacering.net${c.lang === 'zh' ? '/zh' : ''}/ring/${c.number}`;

// palette (site.css)
const CORONA = '#eceaf4';
const BEAD = '#ffd9a0';
const GRAPHITE = '#8b8a99';
const VOID = '#050507';

/** The card's left and right edges, and its bottom margin. */
const EDGE = 72;
/** The brand row's top, and the mark's size. */
const TOP = 60;
const MARK = 26;
/** Jost Light's widest figure (4), per em; figures are proportional. */
const FIGURE = 0.54;
/** Each figure's left side bearing in Jost Light, per em: the number's first stands on the edge. */
const BEARING = [0.046, 0.086, 0.022, 0.062, 0.022, 0.04, 0.05, 0.032, 0.059, 0.05];
/** The number's column, its size at most, and its baseline. */
const NUMBER_COLUMN = 500;
const NUMBER_SIZE = 128;
const NUMBER_Y = 352;
/** The facts at the foot: where the second column starts and where the name must end. */
const HOLDER_X = EDGE + 228;
const FACTS_END = EDGE + 520;
const NAME_SIZE = 21;
const AVATAR = 32;

/** The date a ring was forged, as the card writes it: 2026.10.07 (UTC). */
export function forgedOn(since: string): string {
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())}`;
}

/** Text for XML: as content or inside a double-quoted attribute. */
export function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (text: string) => (segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text));

/** Roughly how wide a character is in Jost, in ems: wide scripts and emoji take a full em. */
function charWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (g.length > 2 || cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f000)) return 1;
  if (g === ' ') return 0.3;
  if (/[A-Z0-9MW@%&]/.test(g)) return 0.62;
  return 0.5;
}

/** A name without the controls that would turn text around it (a name could otherwise appear reversed). */
export const plainName = (name: string) => name.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, '');

/**
 * The name as it fits on the card: trimmed, its runs of spaces and control
 * characters collapsed, and cut with an ellipsis where it would run into
 * the ring.
 */
export function fitName(name: string, ems: number): string {
  const clean = plainName(name).replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  let width = 0;
  const out: string[] = [];
  const parts = graphemes(clean);
  for (let i = 0; i < parts.length; i++) {
    const w = charWidth(parts[i]);
    if (width + w > ems) {
      while (out.length && out[out.length - 1] === ' ') out.pop();
      return `${out.join('')}…`;
    }
    width += w;
    out.push(parts[i]);
  }
  return out.join('');
}

/** The number's size: as large as it may be, smaller once it has more figures than the column holds. */
export function numberSize(number: number): number {
  const figures = String(number).length;
  return Math.min(NUMBER_SIZE, Math.floor(NUMBER_COLUMN / (figures * FIGURE)));
}

/** A number for an attribute: short, and never in exponent form. */
const num = (n: number) => String(Math.round(n * 1e4) / 1e4);

/** Where a point of the band's ink canvas is on the card: between the still's samples, bilinearly. */
export function inkOnCard(x: number, y: number): [number, number] {
  const { stepX, stepY, columns, rows } = STILL.grid;
  const i = Math.min(columns - 2, Math.max(0, Math.floor(x / stepX)));
  const j = Math.min(rows - 2, Math.max(0, Math.floor(y / stepY)));
  const u = x / stepX - i;
  const v = y / stepY - j;
  const at = (di: number, dj: number, k: number) => STILL.points[((j + dj) * columns + i + di) * 2 + k];
  const mix = (k: number) => (1 - v) * ((1 - u) * at(0, 0, k) + u * at(1, 0, k)) + v * ((1 - u) * at(0, 1, k) + u * at(1, 1, k));
  return [mix(0), mix(1)];
}

/**
 * The flat map that follows the band around a point of its ink canvas, as
 * an SVG matrix: a letter is small enough beside the band's curve to be
 * drawn through one.
 */
export function inkMatrix(x: number, y: number): number[] {
  const h = 6;
  const [px, py] = inkOnCard(x, y);
  const [rx, ry] = inkOnCard(x + h, y);
  const [lx, ly] = inkOnCard(x - h, y);
  const [dx, dy] = inkOnCard(x, y + h);
  const [ux, uy] = inkOnCard(x, y - h);
  const a = (rx - lx) / (2 * h);
  const b = (ry - ly) / (2 * h);
  const c = (dx - ux) / (2 * h);
  const d = (dy - uy) / (2 * h);
  return [a, b, c, d, px - a * x - c * y, py - b * x - d * y];
}

/** The holder's number engraved inside the band: letters cut from the inked still, each set along the band. */
function engraving(number: number, faces: CardFaces, href: string, id: string) {
  const letters = inkLetters(`SRN ${number}`)
    .filter((l) => l.char !== ' ')
    .map(({ char, x }) => {
      // through the map at the letter's middle
      const m = inkMatrix(x + (INK.size * INK.advance) / 2, INK.baseline - INK.size * 0.35);
      return `<text x="${num(x)}" y="${INK.baseline}" transform="matrix(${m.map(num).join(' ')})">${xml(char)}</text>`;
    });
  const { x, y, width, height } = STILL.engraved;
  const box = `x="${x}" y="${y}" width="${width}" height="${height}"`;
  return {
    defs: `<mask id="${id}-ink" maskUnits="userSpaceOnUse" ${box}><g font-family="${xml(faces.mono)}" font-weight="${INK.weight}" font-size="${INK.size}" fill="#fff">${letters.join('')}</g></mask>`,
    image: `<image href="${xml(href)}" ${box} preserveAspectRatio="none" mask="url(#${id}-ink)"/>`,
  };
}

export interface CardDrawing {
  faces: CardFaces;
  /** where the art is: CARD_ART on a page; an address the renderer resolves itself */
  art: string;
  /** where the inked still is: CARD_ENGRAVED unless the renderer resolves it itself */
  engraved?: string;
  /** where the picture is, when the card shows one (card.image on a page) */
  avatar?: string | null;
  /** prefix for the drawing's ids, unique on its page */
  id?: string;
}

/** The card as an SVG document, to put inline or to render. */
export function ringCardSvg(card: RingCard, drawing: CardDrawing): string {
  const { faces, art } = drawing;
  const id = drawing.id ?? 'rc';
  const words = CARD_WORDS[card.lang];
  const label = xml(cardLabel(card));
  const avatar = card.image ? drawing.avatar ?? card.image : null;
  const name = card.name ? fitName(card.name, (FACTS_END - HOLDER_X - (avatar ? AVATAR + 10 : 0)) / NAME_SIZE) : '';
  const engraved = engraving(card.number, faces, drawing.engraved ?? CARD_ENGRAVED, id);
  const display = xml(faces.display);
  const mono = xml(faces.mono);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}" role="img" aria-label="${label}">`,
    `<title>${label}</title>`,
    '<defs>',
    // the left side darkened a little, for the words; the art is already dark there
    `<linearGradient id="${id}-veil" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${VOID}" stop-opacity="0.45"/>`,
    `<stop offset="0.5" stop-color="${VOID}" stop-opacity="0"/>`,
    '</linearGradient>',
    `<linearGradient id="${id}-rule" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${CORONA}" stop-opacity="0.22"/>`,
    `<stop offset="1" stop-color="${CORONA}" stop-opacity="0"/>`,
    '</linearGradient>',
    `<clipPath id="${id}-avatar"><circle cx="${AVATAR / 2}" cy="${AVATAR / 2}" r="${AVATAR / 2}"/></clipPath>`,
    engraved.defs,
    '</defs>',
    `<rect width="${CARD_W}" height="${CARD_H}" fill="${VOID}"/>`,
    `<image href="${xml(art)}" x="0" y="0" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="xMidYMid slice"/>`,
    engraved.image,
    `<rect width="${CARD_W}" height="${CARD_H}" fill="url(#${id}-veil)"/>`,
  );

  // the brand, as the site's header has it; where the card lives, opposite
  const middle = TOP + MARK / 2;
  parts.push(
    `<g transform="translate(${EDGE} ${TOP}) scale(${num(MARK / 512)})" fill="${CORONA}"><path fill-rule="evenodd" d="${MARK_BAND}"/><path d="${MARK_CRESCENT}"/></g>`,
    `<text x="${EDGE + MARK + 14}" y="${middle + 4.9}" font-family="${display}" font-weight="500" font-size="13.5" letter-spacing="${num(13.5 * 0.42)}" fill="${CORONA}">SPACERING</text>`,
    `<text x="${CARD_W - EDGE}" y="${middle + 4.6}" text-anchor="end" font-family="${mono}" font-size="13" letter-spacing="${num(13 * 0.06)}" fill="${CORONA}" fill-opacity="0.56">${xml(cardAddress(card))}</text>`,
  );

  // the number, level with the ring, under its label
  const size = numberSize(card.number);
  const first = Number(String(card.number)[0]);
  parts.push(
    `<text x="${EDGE}" y="${num(NUMBER_Y - size * 0.7 - 30)}" font-family="${mono}" font-size="14" letter-spacing="${num(14 * 0.32)}" fill="${BEAD}">SRN</text>`,
    `<text x="${num(EDGE - size * BEARING[first])}" y="${NUMBER_Y}" font-family="${display}" font-weight="300" font-size="${size}" fill="${CORONA}">${card.number}</text>`,
  );

  // at the foot, under a hairline: when it was forged, and who holds it
  const valueY = CARD_H - EDGE;
  const labelY = valueY - 38;
  const fact = (x: number, text: string) =>
    `<text x="${x}" y="${labelY}" font-family="${mono}" font-size="11.5" letter-spacing="${num(11.5 * 0.24)}" fill="${GRAPHITE}">${xml(text)}</text>`;
  parts.push(`<rect x="${EDGE}" y="${labelY - 34}" width="${FACTS_END - EDGE - 64}" height="1" fill="url(#${id}-rule)"/>`);
  const forged = forgedOn(card.since);
  if (forged) {
    parts.push(
      fact(EDGE, words.forged),
      `<text x="${EDGE}" y="${valueY}" font-family="${mono}" font-size="19" letter-spacing="${num(19 * 0.04)}" fill="${CORONA}">${forged}</text>`,
    );
  }
  if (avatar || name) {
    parts.push(fact(HOLDER_X, words.holder));
    if (avatar) {
      parts.push(
        `<g transform="translate(${HOLDER_X} ${valueY - 23})">`,
        `<circle cx="${AVATAR / 2}" cy="${AVATAR / 2}" r="${AVATAR / 2}" fill="#16161d"/>`,
        `<image href="${xml(avatar)}" width="${AVATAR}" height="${AVATAR}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}-avatar)"/>`,
        `<circle cx="${AVATAR / 2}" cy="${AVATAR / 2}" r="${AVATAR / 2 + 0.5}" fill="none" stroke="${CORONA}" stroke-opacity="0.2"/>`,
        '</g>',
      );
    }
    if (name) {
      parts.push(`<text x="${HOLDER_X + (avatar ? AVATAR + 10 : 0)}" y="${valueY}" font-family="${display}" font-size="${NAME_SIZE}" fill="${CORONA}">${xml(name)}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('');
}
