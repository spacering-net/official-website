/** Tags and the automatic tagging of items from their name, title and summary. */

export interface Tag {
  id: string;
  name_en: string;
  name_zh: string;
  sort: number;
}

interface CompiledTag extends Tag {
  words: { re: RegExp; han: boolean }[];
}

const TTL = 10 * 60 * 1000;
let cached: { at: number; tags: CompiledTag[] } | undefined;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const HAN = /\p{Script=Han}/u;

/** All tags, with their match words compiled; read once per isolate every few minutes. */
export async function loadTags(db: D1Database): Promise<CompiledTag[]> {
  if (cached && Date.now() - cached.at < TTL) return cached.tags;
  const { results } = await db.prepare('SELECT id, name_en, name_zh, match, sort FROM tags ORDER BY sort, id').all<Tag & { match: string }>();
  const tags = results.map(({ match, ...t }) => ({
    ...t,
    words: (JSON.parse(match) as string[]).map((w) =>
      HAN.test(w)
        ? { re: new RegExp(escape(w), 'u'), han: true }
        : // whole words: not inside a longer word, so "map" does not match "mapping"
          { re: new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, 'iu'), han: false },
    ),
  }));
  cached = { at: Date.now(), tags };
  return tags;
}

/**
 * The tags an item gets: those whose words appear in its name, title or
 * summary, best first (a match in the name counts most), at most three.
 */
export function autoTags(tags: CompiledTag[], text: { name: string; title?: string; summary?: string }): string[] {
  const name = text.name.replace(/-/g, ' ');
  const rest = `${text.title ?? ''}\n${text.summary ?? ''}`;
  const scored: { id: string; score: number; sort: number }[] = [];
  for (const t of tags) {
    let score = 0;
    for (const w of t.words) {
      if (w.re.test(name)) score += 3;
      if (w.re.test(rest)) score += 1;
    }
    if (score) scored.push({ id: t.id, score, sort: t.sort });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.sort - b.sort)
    .slice(0, 3)
    .map((t) => t.id);
}
