/**
 * What a holder's name and picture may be. The console checks as they type
 * and makes the picture (client/console.ts); the API checks again before it
 * keeps either (api/console/routes.ts). One set of rules, so the two never
 * disagree.
 */

/** The longest name, in characters as people count them: a letter with its accents, an emoji, one each. */
export const NAME_MAX = 32;

/** The same limit in UTF-16 units, generous, so that no one character can carry a pile of marks. */
const NAME_MAX_UNITS = 128;

/**
 * A name as it is kept: composed (NFC), without the invisible characters
 * that reorder or hide text (joiners that emoji and some scripts need stay),
 * each run of spaces and line breaks one space, trimmed.
 */
export function cleanName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/(?![\u200c\u200d\u{e0020}-\u{e007f}])\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim();
}

/** How many characters a name has, as people count them. */
export function nameLength(name: string): number {
  if (typeof Intl.Segmenter !== 'function') return Array.from(name).length;
  return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(name)).length;
}

/** What keeps a cleaned name from being kept, or null when it can be. */
export function nameProblem(name: string): 'empty' | 'long' | null {
  if (!name) return 'empty';
  return name.length > NAME_MAX_UNITS || nameLength(name) > NAME_MAX ? 'long' : null;
}

/** The side of the square picture the console makes: sharp on the largest face, three times over. */
export const AVATAR_SIDE = 384;

/** The largest picture the API keeps: its side, and its size in bytes. */
export const AVATAR_MAX_SIDE = 1024;
export const AVATAR_MAX_BYTES = 1_000_000;
