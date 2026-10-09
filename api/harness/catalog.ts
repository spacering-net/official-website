import { accessOf } from './assistant';
import { mediaPath } from './importers/media';
import type { AssistantMeta, Checks, ItemKind, ItemStatus, PinnedPackage, PromptMeta, Risk, Showcase, StoredAssistantCard, StoredPromptCard } from './model';
import type { PermissionProfile } from './scan/permissions';
import type {
  AssistantCard,
  AssistantInfo,
  InstallInfo,
  ItemDetail,
  ItemList,
  ItemSummary,
  PromptCard,
  PublisherInfo,
  PublisherSummary,
  TagInfo,
  VersionSummary,
} from './schemas';
import { facetKey, searchIds } from './search';
import type { SkillMeta } from './skill';
import { NAME_RE, type Localized } from './text';

export type { AssistantCard, AssistantInfo, InstallInfo, ItemDetail, ItemList, ItemSummary, PromptCard, PublisherInfo, TagInfo, VersionSummary };

/**
 * Reading the catalog: browsing, search, an item and its versions. The API
 * (routes.ts) and the website's pages both call these, so both show the same
 * thing. Only public items are browsed and searched; a listed item is found
 * by its address or its exact name.
 */

export const KINDS: ItemKind[] = ['skill', 'mcp', 'prompt', 'assistant', 'connector'];
export const SORTS = ['popular', 'new', 'updated'] as const;
export type Sort = (typeof SORTS)[number];
export const PAGE_SIZE = 24;

// ---------------------------------------------------------------------------

const API = '/api/harness/v1';
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');

interface Row {
  id: string;
  seq: number;
  name: string;
  kind: ItemKind;
  status: ItemStatus;
  title_en: string | null;
  title_zh: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  runtime: string;
  risk: Risk;
  reviewed: number;
  featured: number;
  source: ItemSummary['source'];
  repo_stars: number | null;
  stars: number;
  installs: number;
  quality: number;
  popularity: number;
  latest_revision: number;
  latest_version_id: string | null;
  published_at: string | null;
  version_at: string;
  handle: string;
  p_name: string;
  p_kind: PublisherSummary['kind'];
  p_verified: number;
  p_user_id: string | null;
  p_avatar: string | null;
  version: string | null;
  listed_reasons: string;
  license: string | null;
  repository_url: string | null;
  website_url: string | null;
  card: string | null;
}

const COLUMNS = `i.id, i.seq, i.name, i.kind, i.status, i.title_en, i.title_zh, i.summary_en, i.summary_zh, i.runtime, i.risk, i.reviewed,
  i.featured, i.source, i.repo_stars, i.stars, i.installs, i.quality, i.popularity, i.latest_revision, i.latest_version_id,
  i.published_at, i.version_at, i.listed_reasons, i.license, i.repository_url, i.website_url, i.card,
  p.handle, p.name AS p_name, p.kind AS p_kind, p.verified AS p_verified, p.user_id AS p_user_id, p.avatar AS p_avatar,
  (SELECT v.version FROM item_versions v WHERE v.id = i.latest_version_id) AS version`;
const FROM = 'items i JOIN publishers p ON p.id = i.publisher_id';

const loc = (en: string | null, zh: string | null): Localized => ({ ...(en ? { en } : {}), ...(zh ? { zh } : {}) });

/** A picture kept here (the media table), by the address its source names it at. */
interface Picture {
  sha256: string;
  type: string;
}

/** The pictures among these addresses that are kept here. */
async function picturesOf(db: D1Database, urls: (string | null | undefined)[]): Promise<Map<string, Picture>> {
  const out = new Map<string, Picture>();
  const wanted = [...new Set(urls.filter((u): u is string => !!u))];
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT url, sha256, type FROM media WHERE status = 'ok' AND url IN (${marks(chunk.length)})`)
      .bind(...chunk)
      .all<{ url: string; sha256: string; type: string }>();
    for (const r of results) out.set(r.url, { sha256: r.sha256, type: r.type });
  }
  return out;
}

const pictureAt = (pictures: Map<string, Picture>, url: string | null) => {
  const p = url ? pictures.get(url) : undefined;
  return p ? mediaPath(p.sha256, p.type) : null;
};

const storedCard = (r: Row): StoredPromptCard | null => (r.kind === 'prompt' && r.card ? (JSON.parse(r.card) as StoredPromptCard) : null);
const assistantCard = (r: Row): StoredAssistantCard | null => (r.kind === 'assistant' && r.card ? (JSON.parse(r.card) as StoredAssistantCard) : null);

/** A prompt's card: the first of its pictures that moves (and is kept here), else the first still one. */
function promptCard(card: StoredPromptCard, pictures: Map<string, Picture>): PromptCard {
  const faces = card.faces ?? [];
  const moving = faces.find((f) => pictureAt(pictures, f.cover) && pictureAt(pictures, f.motion));
  const still = moving ?? faces.find((f) => pictureAt(pictures, f.cover));
  return {
    excerpt: card.excerpt,
    cover: still ? pictureAt(pictures, still.cover) : null,
    motion: moving ? pictureAt(pictures, moving.motion) : null,
    model: card.model,
    by: card.by,
    results: card.results,
    partial: card.partial,
  };
}

function summarize(r: Row, tags: string[], pictures: Map<string, Picture>): ItemSummary {
  const card = storedCard(r);
  const assistant = assistantCard(r);
  return {
    id: r.id,
    ref: `${r.handle}/${r.name}`,
    name: r.name,
    kind: r.kind,
    status: r.status === 'public' ? 'public' : 'listed',
    title: loc(r.title_en, r.title_zh),
    summary: loc(r.summary_en, r.summary_zh),
    publisher: { handle: r.handle, name: r.p_name, kind: r.p_kind, verified: !!r.p_verified, unclaimed: r.p_kind !== 'user' && !r.p_user_id, avatar: r.p_avatar },
    tags,
    runtime: r.runtime,
    risk: r.risk,
    reviewed: !!r.reviewed,
    featured: !!r.featured,
    source: r.source,
    repoStars: r.repo_stars !== null && r.repo_stars >= 0 ? r.repo_stars : null,
    stars: r.stars,
    installs: r.installs,
    latest: { revision: r.latest_revision, version: r.version, publishedAt: r.version_at },
    ...(card ? { prompt: promptCard(card, pictures) } : {}),
    ...(assistant ? { assistant } : {}),
  };
}

async function tagsOf(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT t.item_id, t.tag_id FROM item_tags t JOIN tags g ON g.id = t.tag_id WHERE t.item_id IN (${marks(chunk.length)}) ORDER BY g.sort`)
      .bind(...chunk)
      .all<{ item_id: string; tag_id: string }>();
    for (const r of results) out.set(r.item_id, [...(out.get(r.item_id) ?? []), r.tag_id]);
  }
  return out;
}

async function summaries(db: D1Database, rows: Row[]): Promise<ItemSummary[]> {
  const urls = rows.flatMap((r) => storedCard(r)?.faces?.flatMap((f) => [f.cover, f.motion]) ?? []);
  const [tags, pictures] = await Promise.all([tagsOf(db, rows.map((r) => r.id)), picturesOf(db, urls)]);
  return rows.map((r) => summarize(r, tags.get(r.id) ?? [], pictures));
}

// cursors: base64url JSON, opaque to clients
const encodeCursor = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor<T>(c: string | undefined | null): T | null {
  if (!c) return null;
  try {
    return JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))) as T;
  } catch {
    return null;
  }
}

export interface ListQuery {
  q?: string;
  kind?: ItemKind;
  runtime?: string;
  tag?: string;
  publisher?: string;
  sort?: Sort;
  cursor?: string;
  limit?: number;
}

const ORDER: Record<Sort, { column: string; key: 'popularity' | 'published_at' | 'version_at' }> = {
  popular: { column: 'i.popularity', key: 'popularity' },
  new: { column: 'i.published_at', key: 'published_at' },
  updated: { column: 'i.version_at', key: 'version_at' },
};

/** Browse (no query) or search, with the same filters and the same item shape. */
export async function listItems(db: D1Database, query: ListQuery): Promise<ItemList> {
  const limit = Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), 100);
  let publisherId: string | undefined;
  if (query.publisher) {
    const p = await db.prepare('SELECT id FROM publishers WHERE handle = ?1').bind(query.publisher.toLowerCase()).first<{ id: string }>();
    if (!p) return { items: [], next: null, approxTotal: 0 };
    publisherId = p.id;
  }
  const q = query.q?.trim();
  return q ? search(db, q, query, publisherId, limit) : browse(db, query, publisherId, limit);
}

async function browse(db: D1Database, query: ListQuery, publisherId: string | undefined, limit: number): Promise<ItemList> {
  const sort = ORDER[query.sort ?? 'popular'];
  const where = ["i.status = 'public'", "i.visibility = 'public'"];
  const binds: unknown[] = [];
  if (query.kind) where.push(`i.kind = ?${binds.push(query.kind)}`);
  if (query.runtime) where.push(`i.runtime = ?${binds.push(query.runtime)}`);
  if (publisherId) where.push(`i.publisher_id = ?${binds.push(publisherId)}`);
  if (query.tag) where.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag_id = ?${binds.push(query.tag)})`);
  const after = decodeCursor<{ v: number | string; i: string }>(query.cursor);
  if (after && (typeof after.v === 'number' || typeof after.v === 'string') && typeof after.i === 'string') {
    // the next page starts after the last row of this one, in index order: no OFFSET
    where.push(`(${sort.column}, i.id) < (?${binds.push(after.v)}, ?${binds.push(after.i)})`);
  }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${sort.column} DESC, i.id DESC LIMIT ?${binds.push(limit + 1)}`)
    .bind(...binds)
    .all<Row>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const next = results.length > limit && last ? encodeCursor({ v: last[sort.key], i: last.id }) : null;
  return { items: await summaries(db, page), next, approxTotal: await facetCount(db, query, publisherId) };
}

/** The count of public items under the filters, from the facets, when one facet covers them (a runtime or a tag within a kind is one). */
async function facetCount(db: D1Database, query: ListQuery, publisherId: string | undefined): Promise<number | null> {
  const dims = [query.runtime && facetKey('runtime', query.runtime, query.kind), query.tag && facetKey('tag', query.tag, query.kind)].filter(Boolean) as string[];
  if (publisherId || dims.length > 1) return null;
  const key = dims[0] ?? (query.kind ? `kind:${query.kind}` : 'all');
  const row = await db.prepare('SELECT count FROM facets WHERE key = ?1').bind(key).first<{ count: number }>();
  return row?.count ?? 0;
}

async function search(db: D1Database, q: string, query: ListQuery, publisherId: string | undefined, limit: number): Promise<ItemList> {
  const hits = await searchIds(db, q, { kind: query.kind, runtime: query.runtime, tag: query.tag, publisherId });
  const exact = await exactMatches(db, q, query, publisherId);
  const ids = [...new Set([...exact, ...hits.map((h) => h.id)])];
  const rows = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT ${COLUMNS} FROM ${FROM} WHERE i.id IN (${marks(chunk.length)})`).bind(...chunk).all<Row>();
    for (const r of results) rows.set(r.id, r);
  }
  // relevance first, then trust and popularity: stars, a careful description, a pick or a verified publisher
  const top = Math.max(1, ...hits.map((h) => h.relevance));
  const score = new Map(
    hits.map((h) => {
      const r = rows.get(h.id);
      if (!r) return [h.id, 0];
      const pop = 1 + Math.log10(1 + Math.max(0, r.repo_stars ?? 0)) / 4;
      return [h.id, (h.relevance / top) * r.quality * pop * (r.featured ? 1.3 : 1) * (r.p_verified ? 1.1 : 1)];
    }),
  );
  const byScore = hits
    .map((h) => h.id)
    .filter((id) => !exact.includes(id) && rows.has(id))
    .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
  // a publisher's later hits of a kind count less (the nth by 1/√n), so a collection of many alike (forty
  // reviewers) does not fill the first pages; among its own hits the order stays
  const nth = new Map<string, number>();
  const spread = new Map(
    byScore.map((id) => {
      const r = rows.get(id)!;
      const n = (nth.get(`${r.handle}:${r.kind}`) ?? 0) + 1;
      nth.set(`${r.handle}:${r.kind}`, n);
      return [id, (score.get(id) ?? 0) / Math.sqrt(n)];
    }),
  );
  const ranked = [...exact.filter((id) => rows.has(id)), ...byScore.sort((a, b) => spread.get(b)! - spread.get(a)!)];
  const offset = Math.max(0, decodeCursor<{ o: number }>(query.cursor)?.o ?? 0);
  const page = ranked.slice(offset, offset + limit).map((id) => rows.get(id)!);
  const next = offset + limit < ranked.length ? encodeCursor({ o: offset + limit }) : null;
  return { items: await summaries(db, page), next, approxTotal: ranked.length };
}

/**
 * Items whose address or name is exactly the query: these come first, listed
 * ones included. 'example.com/notes' and 'io.github.foo/bar' are addresses;
 * a single word that could be a name matches items of that name.
 */
async function exactMatches(db: D1Database, q: string, query: ListQuery, publisherId: string | undefined): Promise<string[]> {
  const shown = "i.status IN ('public', 'listed') AND i.visibility = 'public'";
  const extra: string[] = [];
  const binds: unknown[] = [];
  if (query.kind) extra.push(`i.kind = ?${binds.push(query.kind)}`);
  if (query.runtime) extra.push(`i.runtime = ?${binds.push(query.runtime)}`);
  if (publisherId) extra.push(`i.publisher_id = ?${binds.push(publisherId)}`);
  if (query.tag) extra.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag_id = ?${binds.push(query.tag)})`);
  const more = extra.length ? ` AND ${extra.join(' AND ')}` : '';
  const ref = /^([a-z0-9][a-z0-9.-]*)\/([A-Za-z0-9._-]+)$/i.exec(q);
  if (ref) {
    const n = binds.length;
    const { results } = await db
      .prepare(`SELECT i.id FROM ${FROM} WHERE ${shown}${more} AND ((p.handle = ?${n + 1} AND i.name = ?${n + 2}) OR i.source_key = ?${n + 3}) LIMIT 5`)
      .bind(...binds, ref[1].toLowerCase(), ref[2].toLowerCase(), `registry:${q}`)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }
  const word = q.toLowerCase();
  if (!NAME_RE.test(word)) return [];
  const { results } = await db
    .prepare(`SELECT i.id FROM ${FROM} WHERE i.name = ?${binds.length + 1} AND ${shown}${more} ORDER BY i.status = 'public' DESC, i.popularity DESC LIMIT 5`)
    .bind(...binds, word)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

// ---------------------------------------------------------------------------

interface VersionRow {
  id: string;
  revision: number;
  version: string | null;
  status: 'ok' | 'yanked' | 'blocked';
  risk: Risk;
  archive_sha256: string | null;
  archive_size: number | null;
  hosted: number;
  source_commit: string | null;
  source_url: string | null;
  metadata: string;
  permissions: string;
  checks: string;
  listing: string;
  packages: string;
  readme: string | null;
  created_at: string;
}

/** An item by its address (publisher handle and name), public or listed; null if there is none to show. */
async function itemRow(db: D1Database, handle: string, name: string): Promise<Row | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.handle = ?1 AND i.name = ?2 AND i.status IN ('public', 'listed') AND i.visibility = 'public'`)
    .bind(handle.toLowerCase(), name.toLowerCase())
    .first<Row>();
}

async function versionRow(db: D1Database, itemId: string, revision?: number): Promise<VersionRow | null> {
  const where = revision === undefined ? 'v.id = (SELECT latest_version_id FROM items WHERE id = ?1)' : 'v.item_id = ?1 AND v.revision = ?2';
  const stmt = db.prepare(
    `SELECT v.id, v.revision, v.version, v.status, v.risk, v.archive_sha256, v.archive_size, v.hosted, v.source_commit, v.source_url,
            v.metadata, v.permissions, v.checks, v.listing, v.packages, v.readme, v.created_at
       FROM item_versions v WHERE ${where}`,
  );
  return (revision === undefined ? stmt.bind(itemId) : stmt.bind(itemId, revision)).first<VersionRow>();
}

async function installInfo(db: D1Database, item: ItemSummary, v: VersionRow): Promise<InstallInfo> {
  const { results: files } = await db
    .prepare('SELECT path, sha256, size, executable FROM version_files WHERE version_id = ?1 ORDER BY path')
    .bind(v.id)
    .all<{ path: string; sha256: string; size: number; executable: number }>();
  const metadata = JSON.parse(v.metadata) as {
    skill?: SkillMeta;
    repository?: string;
    path?: string;
    name?: string;
    prompt?: PromptMeta;
    showcases?: Showcase[];
    assistant?: AssistantMeta;
  };
  const perms = JSON.parse(v.permissions) as PermissionProfile;
  const info: InstallInfo = {
    item: { id: item.id, ref: item.ref, kind: item.kind, title: item.title },
    version: { revision: v.revision, version: v.version, publishedAt: v.created_at, status: v.status },
    archive: v.hosted && v.archive_sha256 ? { url: `${API}/archives/${v.archive_sha256}.zip`, sha256: v.archive_sha256, size: v.archive_size ?? 0 } : null,
    files: files.map((f) => ({ ...f, executable: !!f.executable })),
    source: !v.hosted && metadata.repository && v.source_commit ? { repository: metadata.repository, commit: v.source_commit, path: metadata.path ?? '' } : null,
    permissions: perms.detected,
    risk: v.risk,
    reviewed: item.reviewed,
    advisories: [],
  };
  if (item.kind === 'skill' && metadata.skill) {
    const { name, description, allowedTools, license, compatibility } = metadata.skill;
    info.skill = { name, description, allowedTools, license, compatibility };
  }
  if (item.kind === 'mcp' || item.kind === 'connector') {
    info.server = metadata as InstallInfo['server'];
    info.packages = JSON.parse(v.packages) as PinnedPackage[];
  }
  if (item.kind === 'prompt' && metadata.prompt) {
    const { text, model, argumentHint, partial, rights, lang } = metadata.prompt;
    const showcases = metadata.showcases ?? [];
    const pictures = await picturesOf(db, showcases.flatMap((s) => [s.cover, s.motion]));
    info.prompt = {
      text,
      model,
      argumentHint,
      partial,
      rights,
      lang,
      // a moving preview only beside a still one, as on the cards
      showcases: showcases.map((s) => {
        const cover = pictureAt(pictures, s.cover);
        return { ...s, cover, motion: cover ? pictureAt(pictures, s.motion) : null };
      }),
    };
  }
  if (item.kind === 'assistant' && metadata.assistant) {
    const a = metadata.assistant;
    info.assistant = {
      name: a.name,
      file: a.file,
      description: a.description,
      model: a.model,
      tools: a.tools,
      disallowedTools: a.disallowedTools,
      access: accessOf(a.tools, a.disallowedTools),
      color: a.color,
      skills: await skillLinks(db, item.publisher.handle, a.skills),
      mcpServers: a.mcpServers,
      mcpLaunches: a.mcpLaunches,
      permissionMode: a.permissionMode,
      hooks: a.hooks,
      starters: a.starters,
      examples: a.examples,
      vibe: a.vibe,
      emoji: a.emoji,
      settings: a.settings,
      plugin: a.plugin,
      alsoIn: item.assistant?.alsoIn ?? [],
    };
  }
  return info;
}

/**
 * The skills an assistant has loaded, each with its address when its
 * publisher has a skill of that name here (a definition may name one by its
 * folder's path; the last part is its name).
 */
async function skillLinks(db: D1Database, handle: string, skills: string[]): Promise<{ name: string; ref: string | null }[]> {
  const names = skills.map((s) => s.replace(/\/+$/, '').split('/').pop()!.toLowerCase());
  const wanted = [...new Set(names.filter((n) => NAME_RE.test(n)))];
  const found = new Set<string>();
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT i.name FROM ${FROM} WHERE p.handle = ?1 AND i.kind = 'skill' AND i.status IN ('public', 'listed') AND i.visibility = 'public'
            AND i.name IN (${marks(chunk.length, 2)})`,
      )
      .bind(handle, ...chunk)
      .all<{ name: string }>();
    for (const r of results) found.add(r.name);
  }
  return skills.map((s, i) => ({ name: s, ref: found.has(names[i]) ? `${handle}/${names[i]}` : null }));
}

/** A prompt's text, by its item's address (public or listed); null if there is none. */
export async function promptText(db: D1Database, handle: string, name: string): Promise<string | null> {
  const row = await itemRow(db, handle, name);
  if (row?.kind !== 'prompt' || !row.latest_version_id) return null;
  const v = await db.prepare('SELECT metadata FROM item_versions WHERE id = ?1').bind(row.latest_version_id).first<{ metadata: string }>();
  return v ? ((JSON.parse(v.metadata) as { prompt?: PromptMeta }).prompt?.text ?? null) : null;
}

/** An item's page: its listing, permissions, checks, and how to install its latest version. */
export async function getItem(db: D1Database, handle: string, name: string): Promise<ItemDetail | null> {
  const row = await itemRow(db, handle, name);
  if (!row) return null;
  const [item] = await summaries(db, [row]);
  const v = await versionRow(db, row.id);
  if (!v) return null;
  const checks = JSON.parse(v.checks) as Checks;
  return {
    ...item,
    license: row.license,
    repositoryUrl: row.repository_url,
    websiteUrl: row.website_url,
    sourceUrl: v.source_url,
    listedReasons: item.status === 'listed' ? (JSON.parse(row.listed_reasons) as string[]) : [],
    permissions: JSON.parse(v.permissions) as PermissionProfile,
    checks: {
      findings: checks.findings,
      review: checks.review,
      rules: checks.rules,
      checkedAt: checks.checkedAt,
      secrets: checks.secrets.length,
      warnings: checks.format.warnings,
      dropped: checks.format.dropped,
    },
    readme: v.readme ? `${API}/items/${item.ref}/readme` : null,
    install: await installInfo(db, item, v),
  };
}

export async function getVersions(db: D1Database, handle: string, name: string): Promise<VersionSummary[] | null> {
  const row = await itemRow(db, handle, name);
  if (!row) return null;
  const { results } = await db
    .prepare('SELECT revision, version, status, risk, created_at FROM item_versions WHERE item_id = ?1 ORDER BY revision DESC LIMIT 100')
    .bind(row.id)
    .all<{ revision: number; version: string | null; status: VersionSummary['status']; risk: Risk; created_at: string }>();
  return results.map((r) => ({ revision: r.revision, version: r.version, status: r.status, risk: r.risk, publishedAt: r.created_at }));
}

export async function getVersion(db: D1Database, handle: string, name: string, revision: number): Promise<InstallInfo | null> {
  const row = await itemRow(db, handle, name);
  if (!row) return null;
  const v = await versionRow(db, row.id, revision);
  if (!v) return null;
  const [item] = await summaries(db, [row]);
  return installInfo(db, item, v);
}

/** The R2 key of an item's rendered description (latest version), or null. */
export async function readmeKey(db: D1Database, handle: string, name: string): Promise<string | null> {
  const row = await itemRow(db, handle, name);
  if (!row?.latest_version_id) return null;
  const v = await db.prepare('SELECT readme FROM item_versions WHERE id = ?1').bind(row.latest_version_id).first<{ readme: string | null }>();
  return v?.readme ?? null;
}

export async function getPublisher(db: D1Database, handle: string): Promise<PublisherInfo | null> {
  const p = await db
    .prepare(
      `SELECT p.id, p.handle, p.name, p.kind, p.verified, p.user_id, p.github_login, p.domain, p.avatar,
              (SELECT COUNT(*) FROM items i WHERE i.publisher_id = p.id AND i.status = 'public' AND i.visibility = 'public') AS items
         FROM publishers p WHERE p.handle = ?1`,
    )
    .bind(handle.toLowerCase())
    .first<{
      handle: string;
      name: string;
      kind: PublisherSummary['kind'];
      verified: number;
      user_id: string | null;
      github_login: string | null;
      domain: string | null;
      avatar: string | null;
      items: number;
    }>();
  if (!p) return null;
  return {
    handle: p.handle,
    name: p.name,
    kind: p.kind,
    verified: !!p.verified,
    unclaimed: p.kind !== 'user' && !p.user_id,
    avatar: p.avatar,
    githubLogin: p.github_login,
    domain: p.domain,
    items: p.items,
  };
}

/** Every tag with its count of public items, in all or of one kind. */
export async function listTags(db: D1Database, kind?: ItemKind): Promise<TagInfo[]> {
  const { results } = await db
    .prepare("SELECT t.id, t.name_en, t.name_zh, COALESCE(f.count, 0) AS count FROM tags t LEFT JOIN facets f ON f.key = 'tag:' || t.id || ?1 ORDER BY t.sort, t.id")
    .bind(kind ? `@${kind}` : '')
    .all<{ id: string; name_en: string; name_zh: string; count: number }>();
  return results.map((t) => ({ id: t.id, name: { en: t.name_en, zh: t.name_zh }, count: t.count }));
}

/** Counts per kind and runtime, from the facets. */
export async function facetCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare("SELECT key, count FROM facets WHERE key = 'all' OR key LIKE 'kind:%' OR key LIKE 'runtime:%'").all<{ key: string; count: number }>();
  return Object.fromEntries(results.map((r) => [r.key, r.count]));
}
