import { hex } from '../ids';
import { accessOf } from './assistant';
import { mediaPath } from './importers/media';
import type { AssistantMeta, Checks, ItemKind, ItemStatus, PinnedPackage, PromptMeta, Risk, Showcase, StoredAssistantCard, StoredPluginCard, StoredPromptCard } from './model';
import type { PluginDescriptor } from './plugin';
import type { PermissionProfile } from './scan/permissions';
import type {
  AssistantCard,
  AssistantInfo,
  InstallInfo,
  ItemDetail,
  ItemList,
  ItemSummary,
  PluginInfo,
  PromptCard,
  PublisherInfo,
  PublisherSummary,
  Release,
  Resolved,
  TagInfo,
  VersionState,
  VersionSummary,
} from './schemas';
import { facetKey, searchIds } from './search';
import type { SkillMeta } from './skill';
import { NAME_RE, type Localized } from './text';

export type { AssistantCard, AssistantInfo, InstallInfo, ItemDetail, ItemList, ItemSummary, PluginInfo, PromptCard, PublisherInfo, Release, Resolved, TagInfo, VersionState, VersionSummary };

/**
 * Reading the catalog: browsing, search, an item and its versions. The API
 * (routes.ts) and the website's pages both call these, so both show the same
 * thing. Only public items are browsed and searched; a listed item is found
 * by its address or its exact name.
 */

/** The kinds the shelves browse. */
export const KINDS = ['skill', 'mcp', 'prompt', 'assistant', 'connector', 'plugin'] as const satisfies readonly ItemKind[];
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
const pluginCard = (r: Row): StoredPluginCard | null => (r.kind === 'plugin' && r.card ? (JSON.parse(r.card) as StoredPluginCard) : null);

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

function summarize(r: Row, tags: string[], pictures: Map<string, Picture>, has: string | null): ItemSummary {
  const card = storedCard(r);
  const assistant = assistantCard(r);
  const plugin = pluginCard(r);
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
    ...(plugin ? { plugin: { skills: plugin.skills, assistants: plugin.assistants, hosts: plugin.hosts, autorun: plugin.autorun, has } } : {}),
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

async function summaries(db: D1Database, rows: Row[], q?: string): Promise<ItemSummary[]> {
  const urls = rows.flatMap((r) => storedCard(r)?.faces?.flatMap((f) => [f.cover, f.motion]) ?? []);
  const [tags, pictures, has] = await Promise.all([tagsOf(db, rows.map((r) => r.id)), picturesOf(db, urls), q ? membersMatched(db, rows, q) : new Map<string, string>()]);
  return rows.map((r) => summarize(r, tags.get(r.id) ?? [], pictures, has.get(r.id) ?? null));
}

/**
 * In a search, each plugin's member the query names (its card says the plugin
 * has it): a member called what was searched for, else one whose name holds
 * every word of it. None when the plugin's own name already does.
 */
async function membersMatched(db: D1Database, rows: Row[], q: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const plugins = rows.filter((r) => r.kind === 'plugin' && r.latest_version_id && words.length && !words.every((w) => r.name.includes(w)));
  if (!plugins.length) return out;
  const whole = words.join('-');
  const { results } = await db
    .prepare(`SELECT version_id, name FROM plugin_components WHERE version_id IN (${marks(plugins.length)}) ORDER BY kind = 'skill' DESC, name`)
    .bind(...plugins.map((r) => r.latest_version_id))
    .all<{ version_id: string; name: string }>();
  for (const r of plugins) {
    const names = results.filter((c) => c.version_id === r.latest_version_id).map((c) => c.name.toLowerCase());
    const hit = names.find((n) => n === whole) ?? names.find((n) => words.every((w) => n.includes(w)));
    if (hit) out.set(r.id, hit);
  }
  return out;
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
  // a publisher's page lists its plugins first (what their skills and assistants come in)
  const first = publisherId && !query.kind ? "(i.kind = 'plugin')" : null;
  const where = ["i.status = 'public'", "i.visibility = 'public'"];
  const binds: unknown[] = [];
  if (query.kind) where.push(`i.kind = ?${binds.push(query.kind)}`);
  if (query.runtime) where.push(`i.runtime = ?${binds.push(query.runtime)}`);
  if (publisherId) where.push(`i.publisher_id = ?${binds.push(publisherId)}`);
  if (query.tag) where.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.tag_id = ?${binds.push(query.tag)})`);
  const after = decodeCursor<{ v: number | string; i: string; p?: number }>(query.cursor);
  if (after && (typeof after.v === 'number' || typeof after.v === 'string') && typeof after.i === 'string') {
    // the next page starts after the last row of this one, in index order: no OFFSET
    if (first) where.push(`(${first}, ${sort.column}, i.id) < (?${binds.push(after.p === 1 ? 1 : 0)}, ?${binds.push(after.v)}, ?${binds.push(after.i)})`);
    else where.push(`(${sort.column}, i.id) < (?${binds.push(after.v)}, ?${binds.push(after.i)})`);
  }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${first ? `${first} DESC, ` : ''}${sort.column} DESC, i.id DESC LIMIT ?${binds.push(limit + 1)}`)
    .bind(...binds)
    .all<Row>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const next = results.length > limit && last ? encodeCursor({ v: last[sort.key], i: last.id, ...(first ? { p: last.kind === 'plugin' ? 1 : 0 } : {}) }) : null;
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
    // what is shown, whatever the index still holds (a row may outlive its item's leaving the shelves by a moment)
    const { results } = await db
      .prepare(`SELECT ${COLUMNS} FROM ${FROM} WHERE i.id IN (${marks(chunk.length)}) AND i.status IN ('public', 'listed') AND i.visibility = 'public'`)
      .bind(...chunk)
      .all<Row>();
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
  return { items: await summaries(db, page, q), next, approxTotal: ranked.length };
}

/**
 * Items whose address or name is exactly the query: these come first, listed
 * ones included. 'example.com/notes' and 'io.github.foo/bar' are addresses;
 * a single word that could be a name matches items of that name.
 */
async function exactMatches(db: D1Database, q: string, query: ListQuery, publisherId: string | undefined): Promise<string[]> {
  // a plugin only listed is not found by its name: its members are items of their own then (the switch is
  // off, or it is not used whole), and they are what a search shows
  const shown = "(i.status = 'public' OR (i.status = 'listed' AND i.kind != 'plugin')) AND i.visibility = 'public'";
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
  // then the plugins on the shelves that have a member of that name (its own item no longer is one)
  const { results: holders } = await db
    .prepare(
      `SELECT i.id FROM ${FROM} WHERE i.kind = 'plugin' AND i.status = 'public' AND i.visibility = 'public'${more}
          AND EXISTS (SELECT 1 FROM plugin_components c WHERE c.version_id = i.latest_version_id AND c.name = ?${binds.length + 1})
        ORDER BY i.popularity DESC LIMIT 5`,
    )
    .bind(...binds, word)
    .all<{ id: string }>();
  return [...new Set([...results, ...holders].map((r) => r.id))];
}

// ---------------------------------------------------------------------------

interface VersionRow {
  id: string;
  revision: number;
  version: string | null;
  status: 'ok' | 'yanked' | 'blocked';
  content_sha256: string;
  committed_at: string | null;
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
  // a staged version (a plugin's, not yet made current) is no version to anyone
  const where = revision === undefined ? 'v.id = (SELECT latest_version_id FROM items WHERE id = ?1)' : "v.item_id = ?1 AND v.revision = ?2 AND v.status != 'staged'";
  const stmt = db.prepare(
    `SELECT v.id, v.revision, v.version, v.status, v.risk, v.archive_sha256, v.archive_size, v.hosted, v.source_commit, v.source_url,
            v.metadata, v.permissions, v.checks, v.listing, v.packages, v.readme, v.created_at, v.content_sha256, v.committed_at
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
    plugin?: PluginDescriptor;
  };
  const perms = JSON.parse(v.permissions) as PermissionProfile;
  const info: InstallInfo = {
    item: { id: item.id, ref: item.ref, kind: item.kind, title: item.title },
    version: { revision: v.revision, version: v.version, publishedAt: v.committed_at ?? v.created_at, status: v.status },
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
  if (item.kind === 'plugin' && metadata.plugin) {
    const d = metadata.plugin;
    const whole = await wholeOf(db, item.id);
    info.plugin = {
      name: d.name,
      hosts: d.hosts,
      unknownManifests: d.unknownManifests,
      components: d.components.map((c) => ({ kind: c.kind, name: c.name, path: c.path, summary: c.summary })),
      autorun: d.autorun,
      autorunFiles: d.autorunFiles,
      mcpUnpinned: d.mcpUnpinned ?? [],
      execSha256: d.execSha256,
      approved: whole.approved.has(v.revision),
      full: whole.full,
      notFull: whole.notFull,
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
    .prepare("SELECT revision, version, status, risk, created_at, committed_at FROM item_versions WHERE item_id = ?1 AND status != 'staged' ORDER BY revision DESC LIMIT 100")
    .bind(row.id)
    .all<{ revision: number; version: string | null; status: VersionSummary['status']; risk: Risk; created_at: string; committed_at: string | null }>();
  // when its source committed it (section 5 of docs/harness-plugins.md), else when it was imported
  return results.map((r) => ({ revision: r.revision, version: r.version, status: r.status, risk: r.risk, publishedAt: r.committed_at ?? r.created_at }));
}

export async function getVersion(db: D1Database, handle: string, name: string, revision: number): Promise<InstallInfo | null> {
  const row = await itemRow(db, handle, name);
  if (!row) return null;
  const v = await versionRow(db, row.id, revision);
  if (!v) return null;
  const [item] = await summaries(db, [row]);
  return installInfo(db, item, v);
}

/** JSON with every object's keys in order, so the same state always reads the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );

interface ResolveRow {
  /** which of the asked this row answers */
  n: number;
  id: string | null;
  kind: ItemKind;
  status: ItemStatus;
  visibility: 'public' | 'private';
  name: string;
  reviewed: number;
  latest_revision: number;
  version_at: string;
  handle: string;
  latest_version: string | null;
  revision: number | null;
  v_status: VersionState['status'];
  v_risk: Risk;
  permissions: string;
  checks: string;
  packages: string;
  metadata: string | null;
}

/** A version as it stands now: what may change after it is published, and a hash that tells when any of it has. */
async function versionState(db: D1Database, r: ResolveRow): Promise<VersionState> {
  const checks = JSON.parse(r.checks) as Checks;
  const count = (severity: Risk) => checks.findings.filter((f) => f.severity === severity).length;
  // a plugin's: whether this revision may be installed whole, and which may now (an approval given or taken back changes the hash)
  let plugin: VersionState['plugin'];
  if (r.kind === 'plugin' && r.id) {
    const d = (JSON.parse(r.metadata ?? '{}') as { plugin?: PluginDescriptor }).plugin;
    const whole = await wholeOf(db, r.id);
    plugin = { approved: whole.approved.has(r.revision!), full: whole.full, execSha256: d?.execSha256 ?? '' };
  }
  const state = {
    revision: r.revision!,
    status: r.v_status,
    risk: r.v_risk,
    reviewed: !!r.reviewed,
    permissions: JSON.parse(r.permissions) as PermissionProfile,
    checks: { findings: { low: count('low'), medium: count('medium'), high: count('high') }, secrets: checks.secrets.length, review: checks.review },
    packages: (JSON.parse(r.packages) as PinnedPackage[]).map((p) => ({
      registryType: p.registryType,
      identifier: p.identifier,
      version: p.version,
      verified: p.verified,
      hasInstallScript: !!p.hasInstallScript,
    })),
    ...(plugin ? { plugin } : {}),
  };
  return { ...state, stateSha256: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(state)))) };
}

/**
 * What a client has installed, as it stands now: asked by the items' ids, so
 * a rename changes nothing, and answered in the order asked. An item that is
 * out tells its address, its latest version and the asked revision's state; a
 * retired or removed one only that revision's status; anything else (not out
 * yet, private, no such id) is told apart from nothing: 'unavailable'.
 *
 * One statement, with the list as one JSON parameter (a statement takes at
 * most a hundred): each id is looked up by the items' unique index, each
 * revision by the versions'.
 */
export async function resolveInstalled(db: D1Database, installed: { id: string; revision: number }[]): Promise<Resolved[]> {
  if (installed.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT j.key AS n, i.id, i.kind, i.status, i.visibility, i.name, i.reviewed, i.latest_revision, i.version_at, p.handle,
              (SELECT l.version FROM item_versions l WHERE l.id = i.latest_version_id) AS latest_version,
              v.revision, v.status AS v_status, v.risk AS v_risk, v.permissions, v.checks, v.packages, v.metadata
         FROM json_each(?1) j
         LEFT JOIN items i ON i.id = json_extract(j.value, '$.id')
         LEFT JOIN publishers p ON p.id = i.publisher_id
         LEFT JOIN item_versions v ON v.item_id = i.id AND v.revision = json_extract(j.value, '$.revision') AND v.status != 'staged'
        ORDER BY j.key`,
    )
    .bind(JSON.stringify(installed))
    .all<ResolveRow>();
  const rows = new Map(results.map((r) => [r.n, r]));
  return Promise.all(
    installed.map(async ({ id }, n): Promise<Resolved> => {
      const r = rows.get(n);
      if (!r?.id || r.visibility !== 'public') return { id, status: 'unavailable' };
      if (r.status === 'retired' || r.status === 'removed') {
        return { id, status: r.status, installed: r.revision === null ? null : { revision: r.revision, status: r.v_status } };
      }
      if (r.status !== 'public' && r.status !== 'listed') return { id, status: 'unavailable' };
      return {
        id,
        status: r.status,
        ref: `${r.handle}/${r.name}`,
        kind: r.kind,
        latest: { revision: r.latest_revision, version: r.latest_version, publishedAt: r.version_at },
        advisories: [],
        installed: r.revision === null ? null : await versionState(db, r),
      };
    }),
  );
}

/**
 * Which of a plugin's revisions may be installed whole (docs/harness-plugins.md,
 * section 6): one that is out (not yanked, blocked or staged), whose MCP
 * servers are all pinned, and that runs nothing on its own or has its whole
 * package approved. `full`: the latest such; `notFull`: why the latest
 * revision is not it.
 */
export async function wholeOf(
  db: D1Database,
  itemId: string,
): Promise<{ approved: Set<number>; full: { revision: number; version: string | null } | null; notFull: 'pending_review' | 'mcp_unpinned' | null }> {
  const { results } = await db
    .prepare(
      `SELECT v.revision, v.version, v.status, json_array_length(v.metadata, '$.plugin.autorun') AS autorun,
              json_array_length(v.metadata, '$.plugin.mcpUnpinned') AS unpinned, a.content_sha256 IS NOT NULL AS approved
         FROM item_versions v LEFT JOIN exec_approvals a ON a.content_sha256 = v.content_sha256
        WHERE v.item_id = ?1 AND v.status != 'staged' ORDER BY v.revision DESC`,
    )
    .bind(itemId)
    .all<{ revision: number; version: string | null; status: string; autorun: number | null; unpinned: number | null; approved: number }>();
  const approved = new Set(results.filter((r) => !!r.approved || !r.autorun).map((r) => r.revision));
  const ok = results.filter((r) => r.status === 'ok' && !r.unpinned && approved.has(r.revision));
  const full = ok[0] ? { revision: ok[0].revision, version: ok[0].version } : null;
  const latest = results[0];
  const notFull = !latest || full?.revision === latest.revision ? null : latest.unpinned ? 'mcp_unpinned' : 'pending_review';
  return { approved, full, notFull };
}

/**
 * A plugin's releases (section 5): as its repository published them, newest
 * first, each with the revision here that has its version and the members
 * that changed since the one before.
 */
export async function getReleases(db: D1Database, handle: string, name: string): Promise<Release[] | null> {
  const row = await itemRow(db, handle, name);
  if (!row || row.kind !== 'plugin') return null;
  const [{ results: releases }, { results: revisions }] = await Promise.all([
    db
      .prepare('SELECT version, tag, url, notes_key, published_at FROM releases WHERE item_id = ?1 ORDER BY published_at DESC, version DESC LIMIT 50')
      .bind(row.id)
      .all<{ version: string; tag: string | null; url: string | null; notes_key: string | null; published_at: string | null }>(),
    db
      .prepare("SELECT id, revision, version FROM item_versions WHERE item_id = ?1 AND status = 'ok' ORDER BY revision")
      .bind(row.id)
      .all<{ id: string; revision: number; version: string | null }>(),
  ]);
  const components = new Map<string, Map<string, string>>();
  for (let i = 0; i < revisions.length; i += 90) {
    const chunk = revisions.slice(i, i + 90).map((r) => r.id);
    const { results } = await db
      .prepare(`SELECT version_id, kind, name, tree_sha256 FROM plugin_components WHERE version_id IN (${marks(chunk.length)})`)
      .bind(...chunk)
      .all<{ version_id: string; kind: string; name: string; tree_sha256: string }>();
    for (const c of results) {
      if (!components.has(c.version_id)) components.set(c.version_id, new Map());
      components.get(c.version_id)!.set(`${c.kind}:${c.name}`, c.tree_sha256);
    }
  }
  return releases.map((r) => {
    const at = revisions.map((v, n) => ({ v, n })).filter((x) => x.v.version === r.version).pop();
    let changed: Release['changed'] = null;
    if (at && at.n > 0) {
      const now = components.get(at.v.id) ?? new Map<string, string>();
      const before = components.get(revisions[at.n - 1].id) ?? new Map<string, string>();
      const label = (k: string) => k.slice(k.indexOf(':') + 1);
      changed = {
        added: [...now.keys()].filter((k) => !before.has(k)).map(label).sort(),
        updated: [...now.keys()].filter((k) => before.has(k) && before.get(k) !== now.get(k)).map(label).sort(),
        removed: [...before.keys()].filter((k) => !now.has(k)).map(label).sort(),
      };
    }
    return {
      version: r.version,
      tag: r.tag,
      url: r.url,
      notes: r.notes_key ? `${API}/items/${row.handle}/${row.name}/releases/${encodeURIComponent(r.version)}/notes` : null,
      publishedAt: r.published_at,
      revision: at?.v.revision ?? null,
      changed,
    };
  });
}

/** The R2 key of a release's notes, by its plugin's address and version; null if there is none. */
export async function releaseNotesKey(db: D1Database, handle: string, name: string, version: string): Promise<string | null> {
  const row = await itemRow(db, handle, name);
  if (!row || row.kind !== 'plugin') return null;
  const r = await db.prepare('SELECT notes_key FROM releases WHERE item_id = ?1 AND version = ?2').bind(row.id, version).first<{ notes_key: string | null }>();
  return r?.notes_key ?? null;
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
