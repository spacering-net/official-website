import { clip, ftsQuery, segment, type Localized } from './text';

const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');

/** An item's row in the search index: its text as the index holds it (Chinese per character). */
export interface SearchDoc {
  name: string;
  keywords: string;
  title: string;
  summary: string;
  body: string;
}

/**
 * Build an item's search row. Summaries are capped, so a long, stuffed one
 * adds no more weight than a short one. Tag names go in both languages.
 */
export function searchDoc(x: {
  name: string;
  handle: string;
  kind: string;
  runtime: string;
  title: Localized;
  summary: Localized;
  excerpt?: string | null;
  tags: { id: string; name_en: string; name_zh: string }[];
}): SearchDoc {
  return {
    name: `${x.name.replace(/-/g, ' ')} ${x.name} ${x.handle}`,
    keywords: segment([...x.tags.flatMap((t) => [t.id.replace(/-/g, ' '), t.name_en, t.name_zh]), x.kind, x.runtime].join(' ')),
    title: segment([x.title.en, x.title.zh].filter(Boolean).join(' ')),
    summary: segment([x.summary.en, x.summary.zh].filter((s): s is string => !!s).map((s) => clip(s, 300)).join(' ')),
    body: segment(x.excerpt ?? ''),
  };
}

/**
 * Statements that bring an item's search row in line with the item as it
 * stands once the statements before them in the same batch have run: if its
 * latest version is still `version`, the row is removed and, when the item
 * is then public, written again from `doc`. Whether the row is there follows
 * the item's actual state, not what the caller meant to set: a change that
 * did not happen leaves a matching row. An item overtaken by a newer version
 * keeps the row that version's own batch gave it.
 */
export function searchStatements(db: D1Database, itemId: string, version: string, doc: SearchDoc | null): D1PreparedStatement[] {
  const out = [db.prepare('DELETE FROM item_search WHERE rowid = (SELECT seq FROM items WHERE id = ?1 AND latest_version_id = ?2)').bind(itemId, version)];
  if (doc) {
    out.push(
      db
        .prepare(
          `INSERT INTO item_search (rowid, name, keywords, title, summary, body)
           SELECT seq, ?3, ?4, ?5, ?6, ?7 FROM items WHERE id = ?1 AND latest_version_id = ?2 AND status = 'public' AND visibility = 'public'`,
        )
        .bind(itemId, version, doc.name, doc.keywords, doc.title, doc.summary, doc.body),
    );
  }
  return out;
}

interface IndexRow {
  id: string;
  name: string;
  kind: string;
  runtime: string;
  title_en: string | null;
  title_zh: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  latest_version_id: string;
  handle: string;
  excerpt: string | null;
}

/** The search rows of these items as they are stored now, with their latest versions. */
export async function docsFor(db: D1Database, itemIds: string[]): Promise<Map<string, { version: string; doc: SearchDoc }>> {
  const out = new Map<string, { version: string; doc: SearchDoc }>();
  for (let i = 0; i < itemIds.length; i += 90) {
    const ids = itemIds.slice(i, i + 90);
    const { results: rows } = await db
      .prepare(
        `SELECT i.id, i.name, i.kind, i.runtime, i.title_en, i.title_zh, i.summary_en, i.summary_zh, i.latest_version_id, p.handle, v.excerpt
           FROM items i JOIN publishers p ON p.id = i.publisher_id LEFT JOIN item_versions v ON v.id = i.latest_version_id
          WHERE i.id IN (${marks(ids.length)})`,
      )
      .bind(...ids)
      .all<IndexRow>();
    const { results: tagRows } = await db
      .prepare(`SELECT t.item_id, g.id, g.name_en, g.name_zh FROM item_tags t JOIN tags g ON g.id = t.tag_id WHERE t.item_id IN (${marks(ids.length)})`)
      .bind(...ids)
      .all<{ item_id: string; id: string; name_en: string; name_zh: string }>();
    const tags = new Map<string, { id: string; name_en: string; name_zh: string }[]>();
    for (const t of tagRows) tags.set(t.item_id, [...(tags.get(t.item_id) ?? []), t]);
    for (const r of rows) {
      out.set(r.id, {
        version: r.latest_version_id,
        doc: searchDoc({
          name: r.name,
          handle: r.handle,
          kind: r.kind,
          runtime: r.runtime,
          title: { ...(r.title_en ? { en: r.title_en } : {}), ...(r.title_zh ? { zh: r.title_zh } : {}) },
          summary: { ...(r.summary_en ? { en: r.summary_en } : {}), ...(r.summary_zh ? { zh: r.summary_zh } : {}) },
          excerpt: r.excerpt,
          tags: tags.get(r.id) ?? [],
        }),
      });
    }
  }
  return out;
}

/**
 * Rewrite the search rows of these items from what is stored (public items
 * get a row, others none). For repairs; writers keep the index in step in
 * the same batch as their change (searchStatements).
 */
export async function reindex(db: D1Database, itemIds: string[]): Promise<void> {
  const docs = await docsFor(db, itemIds);
  const statements: D1PreparedStatement[] = [];
  for (const [id, { version, doc }] of docs) statements.push(...searchStatements(db, id, version, doc));
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
}

/**
 * Make the search index match the items: rows for public items that lack one,
 * none for anything else. Daily; returns how many rows it fixed.
 */
export async function repairIndex(db: D1Database): Promise<number> {
  const pub = "status = 'public' AND visibility = 'public'";
  const extra = await db.prepare(`DELETE FROM item_search WHERE rowid NOT IN (SELECT seq FROM items WHERE ${pub})`).run();
  const { results } = await db
    .prepare(`SELECT id FROM items WHERE ${pub} AND seq NOT IN (SELECT rowid FROM item_search) LIMIT 2000`)
    .all<{ id: string }>();
  await reindex(db, results.map((r) => r.id));
  return (extra.meta.changes ?? 0) + results.length;
}

/**
 * Full-text search: the best 200 public items by relevance (bm25, with the
 * columns weighted name 10, keywords 5, title 4, summary 2, body 1), each
 * with its relevance score. Ranked further by the caller. Empty when the
 * query has nothing searchable. Items are checked to be public here too, so
 * a stale row can never show a hidden item.
 */
export async function searchIds(
  db: D1Database,
  q: string,
  filter: { kind?: string; runtime?: string; tag?: string; publisherId?: string },
): Promise<{ id: string; relevance: number }[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  const where = ['item_search MATCH ?1', "i.status = 'public'", "i.visibility = 'public'"];
  const binds: unknown[] = [match];
  if (filter.kind) where.push(`i.kind = ?${binds.push(filter.kind)}`);
  if (filter.runtime) where.push(`i.runtime = ?${binds.push(filter.runtime)}`);
  if (filter.publisherId) where.push(`i.publisher_id = ?${binds.push(filter.publisherId)}`);
  if (filter.tag) where.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag_id = ?${binds.push(filter.tag)})`);
  const { results } = await db
    .prepare(
      `SELECT i.id, -bm25(item_search, 10.0, 5.0, 4.0, 2.0, 1.0) AS relevance
         FROM item_search JOIN items i ON i.seq = item_search.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY relevance DESC LIMIT 200`,
    )
    .bind(...binds)
    .all<{ id: string; relevance: number }>();
  return results;
}

/**
 * Recount the facets (public items per kind, runtime and tag, and in all;
 * runtimes and tags also within each kind, as 'runtime:node@skill' and
 * 'tag:video@prompt') in one transaction, dropping keys that no longer have
 * any.
 */
export async function recountFacets(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const pub = "status = 'public' AND visibility = 'public'";
  const ipub = "i.status = 'public' AND i.visibility = 'public'";
  const upsert = 'ON CONFLICT (key) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at';
  await db.batch([
    db.prepare(`INSERT INTO facets (key, count, updated_at) SELECT 'all', COUNT(*), ?1 FROM items WHERE ${pub} ${upsert}`).bind(now),
    db.prepare(`INSERT INTO facets (key, count, updated_at) SELECT 'kind:' || kind, COUNT(*), ?1 FROM items WHERE ${pub} GROUP BY kind ${upsert}`).bind(now),
    db
      .prepare(`INSERT INTO facets (key, count, updated_at) SELECT 'runtime:' || runtime, COUNT(*), ?1 FROM items WHERE ${pub} GROUP BY runtime ${upsert}`)
      .bind(now),
    db
      .prepare(
        `INSERT INTO facets (key, count, updated_at) SELECT 'runtime:' || runtime || '@' || kind, COUNT(*), ?1 FROM items WHERE ${pub} GROUP BY runtime, kind ${upsert}`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO facets (key, count, updated_at)
         SELECT 'tag:' || t.tag_id, COUNT(*), ?1 FROM item_tags t JOIN items i ON i.id = t.item_id WHERE ${ipub} GROUP BY t.tag_id ${upsert}`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO facets (key, count, updated_at)
         SELECT 'tag:' || t.tag_id || '@' || i.kind, COUNT(*), ?1 FROM item_tags t JOIN items i ON i.id = t.item_id WHERE ${ipub} GROUP BY t.tag_id, i.kind ${upsert}`,
      )
      .bind(now),
    db.prepare('DELETE FROM facets WHERE updated_at < ?1').bind(now),
  ]);
}

/** The facet key for a runtime or tag, within a kind when one is chosen. */
export const facetKey = (dim: 'runtime' | 'tag', value: string, kind?: string) => `${dim}:${value}${kind ? `@${kind}` : ''}`;
