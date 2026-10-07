/**
 * Text helpers for Harness: Chinese word segmentation for the search index,
 * which language a text is in, names and handles, and how much a description
 * reads like a list of keywords.
 */

export type Lang = 'en' | 'zh';
/** Display text in each language; either may be missing, readers fall back to the other. */
export type Localized = Partial<Record<Lang, string>>;

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;

/**
 * Chinese characters as separate words, for the search index. The index's
 * tokenizer splits only on spaces and punctuation, so a Chinese phrase would
 * otherwise be one token, and 「翻译」 would not find 「中文翻译工具」. Queries
 * look for the characters in a row (ftsQuery), which finds any Chinese word
 * inside a text. A word segmenter (Intl.Segmenter) is not used: it cuts the
 * same word differently by context (「数据库」 alone, but 「数据|库」 before
 * 「查询」), so index and query would disagree.
 */
export function segment(text: string): string {
  return HAN.test(text) ? text.replace(HAN_RUN, (run) => ` ${[...run].join(' ')} `) : text;
}

/** Chinese when Chinese characters make up at least a quarter of the letters; English otherwise. */
export function languageOf(text: string): Lang {
  let han = 0;
  let other = 0;
  for (const ch of text) {
    if (HAN.test(ch)) han++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  return han > 0 && han * 4 >= han + other ? 'zh' : 'en';
}

/** Put a text in the slot for its language. */
export const localize = (text: string | null | undefined): Localized => {
  const t = text?.trim();
  return t ? { [languageOf(t)]: t } : {};
};

/** Collapse whitespace and cut to `max` characters, at a word boundary where there is one. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * The FTS5 query for what someone typed: every word required, each quoted
 * (so nothing typed is query syntax). Chinese is matched as its characters in
 * a row (a phrase, see segment); the last other word also matches longer
 * words that start with it. Null when nothing searchable is left.
 */
export function ftsQuery(input: string): string | null {
  const parts = input.slice(0, 200).match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu)?.slice(0, 8) ?? [];
  if (!parts.length) return null;
  return parts
    .map((t, i) => (HAN.test(t) ? `"${[...t].slice(0, 12).join(' ')}"` : `"${t}"${i === parts.length - 1 && t.length >= 2 ? '*' : ''}`))
    .join(' ');
}

/**
 * Item names follow the Agent Skills rule for `name`: 1 to 64 lowercase
 * letters, digits and hyphens, not starting or ending with a hyphen, with no
 * two hyphens in a row.
 */
export const NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

/** A name that follows NAME_RE, made from any string ('My_Server.v2' → 'my-server-v2'). */
export function toName(raw: string, fallback = 'item'): string {
  const name = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return name || fallback;
}

/**
 * The publisher for a registry namespace: io.github.<login> is that GitHub
 * account; any other namespace is a domain written backwards (com.example →
 * example.com, the handle). Null for a namespace that is neither.
 */
export function namespacePublisher(namespace: string): { kind: 'github'; login: string; handle: string } | { kind: 'domain'; domain: string; handle: string } | null {
  const parts = namespace.split('.');
  if (parts.length === 3 && parts[0] === 'io' && parts[1] === 'github' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[2])) {
    return { kind: 'github', login: parts[2], handle: parts[2].toLowerCase() };
  }
  if (parts.length < 2 || !parts.every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p))) return null;
  const domain = parts.reverse().join('.').toLowerCase();
  return { kind: 'domain', domain, handle: domain };
}

const STOP = new Set(
  'a an and are as at be by for from in into is it its of on or that the this to with your you mcp server servers tool tools api'.split(' '),
);

/**
 * How much a description reads like prose (1) rather than a keyword list or
 * an essay (down to 0.4). A description decides when an agent reaches for a
 * skill, so stuffing it is a defect in itself, and it should not buy a better
 * place in search or rankings.
 */
export function descriptionQuality(text: string): number {
  const t = text.trim();
  let q = 1;
  if (t.length > 1000) q = Math.min(q, 0.6);
  else if (t.length > 500) q = Math.min(q, 0.85);
  // a run of short comma- or pipe-separated fragments is a keyword list
  const pieces = t.split(/[,，|;；]/).map((p) => p.trim()).filter(Boolean);
  const short = pieces.filter((p) => p.split(/\s+/).length <= 3).length;
  if (pieces.length >= 10 && short / pieces.length > 0.7) q = Math.min(q, 0.5);
  if ((t.match(/#[\p{L}\p{N}_-]+/gu)?.length ?? 0) >= 5) q = Math.min(q, 0.6);
  // one word over and over
  const words = (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));
  if (words.length >= 20) {
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    if (Math.max(...counts.values()) / words.length > 0.15) q = Math.min(q, 0.6);
  }
  return Math.max(q, 0.4);
}
