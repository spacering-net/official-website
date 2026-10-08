/**
 * The ring number engraved inside the band, as it is lettered: on the ink
 * canvas the band's shader samples (src/client/scene/ring.ts), and on the
 * ring card, which letters it the same way over a still of the band
 * (src/lib/ring-card.ts). One layout for both, so the card's engraving is
 * the homepage's.
 */
export const INK = {
  /** the canvas, 8:1 like the band */
  width: 1024,
  height: 128,
  /** IBM Plex Mono Medium, the HUD's face */
  size: 84,
  weight: 500,
  /** letter-spacing, per em */
  tracking: 0.32,
  /** every IBM Plex Mono glyph's advance, per em */
  advance: 0.6,
  /** the letters' alphabetic baseline: puts their middle a little below the canvas's */
  baseline: 92.2,
} as const;

/** Where each letter of `text` starts on the ink canvas: centred, letter-spaced, one advance each. */
export function inkLetters(text: string): { char: string; x: number }[] {
  const chars = [...text];
  const step = INK.size * (INK.advance + INK.tracking);
  const width = chars.length * INK.size * INK.advance + (chars.length - 1) * INK.size * INK.tracking;
  const start = (INK.width - width) / 2;
  return chars.map((char, i) => ({ char, x: start + i * step }));
}
