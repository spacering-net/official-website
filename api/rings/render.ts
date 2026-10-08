/**
 * Ring cards as pictures: the card's SVG (src/lib/ring-card.ts) drawn by
 * resvg and saved as JPEG by MozJPEG, both WebAssembly. Link previews want a
 * JPEG or PNG, and the art is a photograph: as PNG a card weighs megabytes.
 *
 * Always at the card's own 1200 × 630, from the art at that size: WebAssembly
 * memory only grows, and resvg needs about 15 MB for this, against 45 MB from
 * the 2× art and over 100 MB for a 2× picture, in an isolate allowed 128 MB
 * that serves the rest of the site too. For the same reason one card is
 * rendered at a time per isolate.
 *
 * Loaded only when a card is rendered (a dynamic import), so the rest of the
 * Worker starts without the two modules.
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgModule from '@resvg/resvg-wasm/index_bg.wasm';
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode.js';
import mozjpegModule from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import { CARD_ART_SMALL, CARD_ENGRAVED, CARD_H, CARD_W, ringCardSvg, type RingCard } from '../../src/lib/ring-card';
import { CARD_FONTS, drawable, missing, readFont, RENDER_FACES, type Font } from './fonts';

/** Where the card's own files are, and how to fetch what a holder's card adds. */
export interface CardSources {
  /** a file of the site's (under /ring-card/) */
  asset(path: string): Promise<Uint8Array>;
  /** the holder's picture, by its /api/avatars/ address; null if it is gone */
  avatar(href: string): Promise<Uint8Array | null>;
  /** fonts for characters the card's own do not draw (fonts.ts: fetchFallbacks) */
  fallbacks(chars: string[]): Promise<Font[]>;
}

export interface RenderedCard {
  jpeg: Uint8Array<ArrayBuffer>;
  /**
   * False when something the card should show could not be had (the
   * picture, or fonts for the name) and was left out: worth rendering again
   * later, so not to be kept.
   */
  complete: boolean;
}

// the drawing refers to these; the renderer hands it the bytes
const ART_HREF = 'https://card.invalid/art';
const ENGRAVED_HREF = 'https://card.invalid/engraved';
const AVATAR_HREF = 'https://card.invalid/avatar';

let modules: Promise<void> | undefined;
const ready = () =>
  (modules ??= (async () => {
    await initWasm(resvgModule);
    await initJpeg(mozjpegModule);
  })().catch((err) => {
    modules = undefined;
    throw err;
  }));

/** The card's own fonts and pictures: the same for every card, so read once per isolate. */
interface OwnFiles {
  fonts: Font[];
  art: Uint8Array;
  engraved: Uint8Array;
}
let own: Promise<OwnFiles> | undefined;
const ownFiles = (sources: CardSources) =>
  (own ??= (async () => {
    const [art, engraved, ...fonts] = await Promise.all([
      sources.asset(CARD_ART_SMALL),
      sources.asset(CARD_ENGRAVED),
      ...CARD_FONTS.map((f) => sources.asset(`/ring-card/fonts/${f}`)),
    ]);
    return { art, engraved, fonts: fonts.map(readFont) };
  })().catch((err) => {
    own = undefined;
    throw err;
  }));

/** Renders waiting their turn: each starts once the one before has finished, or failed. */
let queue: Promise<unknown> = Promise.resolve();

/** The card as a 1200 × 630 JPEG. */
export async function renderCard(card: RingCard, sources: CardSources): Promise<RenderedCard> {
  const [, files] = await Promise.all([ready(), ownFiles(sources)]);
  let complete = true;

  // the name in fonts that draw it: the card's, then Google's for the rest
  let fonts = files.fonts;
  let name = card.name;
  if (name) {
    const lacking = missing(name, fonts);
    if (lacking.length) {
      try {
        fonts = [...fonts, ...(await sources.fallbacks(lacking))];
      } catch (err) {
        console.warn('[rings] fonts for a name could not be fetched', err);
        complete = false;
      }
      name = drawable(name, fonts) || null;
    }
  }

  let avatar: Uint8Array | null = null;
  if (card.image) {
    avatar = await sources.avatar(card.image).catch(() => null);
    if (!avatar) complete = false;
  }

  const svg = ringCardSvg({ ...card, name, image: avatar ? card.image : null }, { faces: RENDER_FACES, art: ART_HREF, engraved: ENGRAVED_HREF, avatar: AVATAR_HREF });
  const turn = queue.then(() => draw(svg, fonts, files, avatar));
  queue = turn.catch(() => {});
  return { jpeg: await turn, complete };
}

/** The drawing as a JPEG: the part that takes the memory. */
async function draw(svg: string, fonts: Font[], files: OwnFiles, avatar: Uint8Array | null): Promise<Uint8Array<ArrayBuffer>> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: CARD_W },
    font: { fontBuffers: fonts.map((f) => f.bytes), loadSystemFonts: false, defaultFontFamily: 'Jost' },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
  });
  let pixels: Uint8Array;
  try {
    for (const href of resvg.imagesToResolve() as string[]) {
      if (href === ART_HREF) resvg.resolveImage(href, files.art);
      else if (href === ENGRAVED_HREF) resvg.resolveImage(href, files.engraved);
      else if (href === AVATAR_HREF && avatar) resvg.resolveImage(href, avatar);
    }
    const image = resvg.render();
    try {
      if (image.width !== CARD_W || image.height !== CARD_H) throw new Error(`rendered ${image.width} × ${image.height}`);
      pixels = image.pixels;
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
  const jpeg = await encodeJpeg(
    // what it reads of an ImageData, which Workers do not have
    { data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width: CARD_W, height: CARD_H } as unknown as Parameters<typeof encodeJpeg>[0],
    // full-resolution colour keeps the small gold and grey words crisp
    { quality: 86, chroma_subsample: 1 },
  );
  return new Uint8Array(jpeg);
}
