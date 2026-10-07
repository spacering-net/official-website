import { stringify } from 'yaml';
import type { PromptMeta, Showcase } from './model';
import { parseYaml, splitFrontmatter } from './skill';
import { clip, NAME_RE } from './text';

/**
 * Prompts (docs: harness-prompts.md). The standard format is PROMPT.md: a
 * Markdown file whose body is the prompt, with frontmatter like Claude Code's
 * commands (name, description, model, argument-hint), so a client can make a
 * command of it as it is, plus who shared it and where. Importers write it
 * from a collection's entries; it is the package a version keeps.
 */

/** What PROMPT.md's frontmatter says. */
export interface PromptFields {
  name: string;
  description?: string | null;
  model?: string | null;
  argumentHint?: string | null;
  /** who shared it, when that is not its publisher ("@someone") */
  sharedBy?: string | null;
  /** where it was shared */
  source?: string | null;
  partial?: boolean;
}

/** A prompt's text as kept: NFC, Unix line ends, no blanks at line ends or around it. */
export const cleanPrompt = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');

/**
 * What two prompts are compared by: their text, apart from case, spacing,
 * the kind of quotation marks, quotes around the whole and a closing full
 * stop (copies of one prompt differ in no more than these).
 */
export const promptKey = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\s.!?。！？…]+$/u, '');

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A title for a prompt that has none: its first sentence (or line), plain,
 * at most 72 characters, or 36 in Chinese, Japanese or Korean, cut at a word.
 */
export function promptTitle(text: string): string {
  const plain = text
    // markup some prompts are written in: <inputs>, **bold**, # headings, `code`
    .replace(/<\/?[A-Za-z][\w-]*>/g, ' ')
    .replace(/[`*_#>]+/g, ' ');
  const line = plain
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l));
  if (!line) return '';
  // a full stop ends a sentence before a space (not in "Three.js"); a Chinese one, anywhere
  const sentence = /^(.+?(?:[.!?](?=\s|$)|[。！？]))/u.exec(line)?.[1] ?? line;
  const title = clip(sentence, WIDE.test(sentence) ? 36 : 72);
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The language a prompt is written in, by its letters: zh, ja, ko or en; null for any other. */
export function promptLang(text: string): string | null {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  let other = 0;
  for (const ch of text.slice(0, 4000)) {
    if (/\p{Script=Han}/u.test(ch)) han++;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++;
    else if (/\p{Script=Hangul}/u.test(ch)) hangul++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  const letters = han + kana + hangul + latin + other;
  if (!letters) return null;
  if (hangul * 4 >= letters) return 'ko';
  if (kana && (han + kana) * 4 >= letters) return 'ja';
  if (han * 4 >= letters) return 'zh';
  return latin * 2 >= letters ? 'en' : null;
}

/** PROMPT.md for a prompt: its frontmatter, then its text. */
export function promptFile(fields: PromptFields, text: string): string {
  const fm: Record<string, string | boolean> = { name: fields.name };
  if (fields.description) fm.description = fields.description;
  if (fields.model) fm.model = fields.model;
  if (fields.argumentHint) fm['argument-hint'] = fields.argumentHint;
  if (fields.sharedBy) fm['shared-by'] = fields.sharedBy;
  if (fields.source) fm.source = fields.source;
  if (fields.partial) fm.partial = true;
  return `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n${text}\n`;
}

/** PROMPT.md as a version keeps it, from what it keeps: the first result's sharer and post are the prompt's. */
export const promptFileOf = (meta: PromptMeta, showcases: Showcase[]): string =>
  promptFile(
    {
      name: meta.name,
      model: meta.model,
      argumentHint: meta.argumentHint,
      sharedBy: showcases[0]?.by ? `@${showcases[0].by.name}` : null,
      source: showcases[0]?.link ?? null,
      partial: meta.partial,
    },
    meta.text,
  );

export interface PromptParse {
  fields?: PromptFields;
  text: string;
  errors: string[];
}

/** Read PROMPT.md: its frontmatter must be YAML with a valid name; the text, everything after it. */
export function parsePrompt(content: string): PromptParse {
  const fm = splitFrontmatter(content);
  if (!fm) return { text: cleanPrompt(content), errors: ['frontmatter_missing'] };
  let data: unknown;
  try {
    data = parseYaml(fm.yaml);
  } catch {
    return { text: cleanPrompt(fm.body), errors: ['frontmatter_invalid'] };
  }
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const errors: string[] = [];
  const name = str(d.name);
  if (!name || !NAME_RE.test(name)) errors.push('name_invalid');
  const text = cleanPrompt(fm.body);
  if (!text) errors.push('text_missing');
  return {
    fields: name
      ? {
          name,
          description: str(d.description),
          model: str(d.model),
          argumentHint: str(d['argument-hint']),
          sharedBy: str(d['shared-by']),
          source: str(d.source),
          partial: d.partial === true,
        }
      : undefined,
    text,
    errors,
  };
}

/** When a post on X was made, read from its id (a snowflake); null for any other address. */
export function postTime(url: string | null | undefined): string | null {
  const m = url ? /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{10,20})(?:[/?#]|$)/.exec(url) : null;
  if (!m) return null;
  const ms = Number(BigInt(m[1]) >> 22n) + 1288834974657;
  // ids before X began counting time in them (November 2010), or absurdly far ahead, are no times
  return ms > Date.UTC(2010, 10, 4) && ms < Date.UTC(2100, 0, 1) ? new Date(ms).toISOString() : null;
}

/** Names of the models prompts are written for; others show their id. */
const MODEL_NAMES: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

/** A model's name; `short` leaves out the maker where it is obvious ("Opus 5.5"). */
export function modelName(id: string | null | undefined, short = false): string | null {
  if (!id) return null;
  const name = MODEL_NAMES[id] ?? id;
  return short ? name.replace(/^Claude /, '') : name;
}

/** A card's excerpt: the start of the text, on one line. */
export const promptExcerpt = (text: string, max = 320): string => clip(text, max);
