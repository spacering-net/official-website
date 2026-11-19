/**
 * What the Harness pages read, from the same catalog the API serves
 * (api/harness/catalog.ts), with the page's own query checked first.
 */
import { env } from 'cloudflare:workers';
import {
  facetCounts,
  getItem,
  getPublisher,
  getReleases,
  getVersions,
  KINDS,
  listItems,
  listTags,
  SORTS,
  type AssistantCard,
  type AssistantInfo,
  type ItemDetail,
  type ItemList,
  type ItemSummary,
  type PromptCard,
  type PublisherInfo,
  type Release,
  type TagInfo,
  type VersionSummary,
} from '../../api/harness/catalog';
import type { ItemKind } from '../../api/harness/model';

export type { AssistantCard, AssistantInfo, ItemDetail, ItemList, ItemSummary, PromptCard, PublisherInfo, Release, TagInfo, VersionSummary };
export { modelName } from '../../api/harness/prompt';
export { roleText, withoutAgentWord } from '../../api/harness/assistant';

export interface BrowseState {
  q: string;
  kind?: ItemKind;
  runtime?: string;
  tag?: string;
  sort: (typeof SORTS)[number];
  cursor?: string;
}

/** The browse state in a page's query string; anything malformed is ignored. */
export function browseState(url: URL): BrowseState {
  const p = url.searchParams;
  const word = (v: string | null, max: number) => (v && new RegExp(`^[a-z0-9-]{1,${max}}$`).test(v) ? v : undefined);
  const kind = p.get('kind');
  const sort = p.get('sort');
  return {
    q: (p.get('q') ?? '').trim().slice(0, 200),
    // plugins are a kind of the shelves once the switch puts them there (docs/harness-plugins.md, section 10)
    kind: (KINDS as readonly string[]).includes(kind ?? '') && (kind !== 'plugin' || env.HARNESS_PLUGINS === 'on') ? (kind as ItemKind) : undefined,
    runtime: word(p.get('runtime'), 20),
    tag: word(p.get('tag'), 40),
    sort: SORTS.includes(sort as BrowseState['sort']) ? (sort as BrowseState['sort']) : 'popular',
    cursor: p.get('cursor')?.slice(0, 500) || undefined,
  };
}

/** The same page with some of its query changed; undefined drops a key. The cursor is dropped unless set. */
export function withQuery(path: string, state: BrowseState, change: Partial<Record<keyof BrowseState, string | undefined>>): string {
  const next: Record<string, string | undefined> = { q: state.q || undefined, kind: state.kind, runtime: state.runtime, tag: state.tag, sort: state.sort === 'popular' ? undefined : state.sort, ...change };
  if (!('cursor' in change)) delete next.cursor;
  const qs = new URLSearchParams(Object.entries(next).filter((e): e is [string, string] => !!e[1])).toString();
  return qs ? `${path}?${qs}` : path;
}

export async function loadBrowse(state: BrowseState, publisher?: string): Promise<{ list: ItemList; tags: TagInfo[]; counts: Record<string, number> }> {
  const db = env.HARNESS_DB;
  // with a kind chosen, the tags count within it
  const [list, tags, counts] = await Promise.all([listItems(db, { ...state, q: state.q || undefined, publisher }), listTags(db, state.kind), facetCounts(db)]);
  return { list, tags, counts };
}

/** What a plugin's page shows besides its item: its releases (the latest ones' notes with them), and how Claude Code installs it from its repository. */
export interface PluginPage {
  releases: (Release & { html: string | null })[];
  /** `name@marketplace`, when its repository is a Claude Code marketplace that lists it */
  claude: string | null;
}

/** Releases whose notes a plugin's page shows; older ones link to theirs. */
const NOTES_SHOWN = 10;

async function loadPlugin(item: ItemDetail, publisher: string, name: string): Promise<PluginPage> {
  const db = env.HARNESS_DB;
  const [releases, keys, run] = await Promise.all([
    getReleases(db, publisher, name),
    db.prepare('SELECT version, notes_key FROM releases WHERE item_id = ?1').bind(item.id).all<{ version: string; notes_key: string | null }>(),
    db
      .prepare(
        `SELECT r.plugins, i.source_key FROM items i JOIN import_runs r ON i.source_key >= r.source || ':' AND i.source_key < r.source || ';'
          WHERE i.id = ?1 ORDER BY r.completed_at DESC, r.run_id DESC LIMIT 1`,
      )
      .bind(item.id)
      .first<{ plugins: string; source_key: string }>(),
  ]);
  const key = new Map(keys.results.map((k) => [k.version, k.notes_key]));
  const list = releases ?? [];
  const html = await Promise.all(
    list.slice(0, NOTES_SHOWN).map(async (r) => {
      const k = key.get(r.version);
      const object = k ? await env.HARNESS_FILES.get(k) : null;
      return object ? object.text() : null;
    }),
  );
  let claude: string | null = null;
  try {
    const plugins = run ? (JSON.parse(run.plugins) as { plugins?: { key: string; claude?: string }[] }).plugins : undefined;
    claude = plugins?.find((p) => p.key === run!.source_key)?.claude ?? null;
  } catch {}
  return { releases: list.map((r, i) => ({ ...r, html: html[i] ?? null })), claude };
}

export async function loadItem(
  publisher: string,
  name: string,
): Promise<{ item: ItemDetail; readme: string | null; versions: VersionSummary[]; plugin: PluginPage | null } | null> {
  const db = env.HARNESS_DB;
  const item = await getItem(db, publisher, name);
  if (!item) return null;
  const [versions, readme, plugin] = await Promise.all([
    getVersions(db, publisher, name),
    (async () => {
      const key = item.readme ? await db.prepare('SELECT readme FROM item_versions WHERE item_id = ?1 AND revision = ?2').bind(item.id, item.latest.revision).first<{ readme: string | null }>() : null;
      const object = key?.readme ? await env.HARNESS_FILES.get(key.readme) : null;
      return object ? object.text() : null;
    })(),
    item.kind === 'plugin' ? loadPlugin(item, publisher, name) : null,
  ]);
  return { item, readme, versions: versions ?? [], plugin };
}

export const loadPublisher = (handle: string): Promise<PublisherInfo | null> => getPublisher(env.HARNESS_DB, handle);

/** A publisher's items on the shelves per kind (`kind:skill`, ...) and in all (`all`), as the facets count the catalog. */
export async function loadPublisherKinds(handle: string): Promise<Record<string, number>> {
  const { results } = await env.HARNESS_DB.prepare(
    `SELECT i.kind, COUNT(*) AS n FROM items i JOIN publishers p ON p.id = i.publisher_id
      WHERE p.handle = ?1 AND i.status = 'public' AND i.visibility = 'public' GROUP BY i.kind`,
  )
    .bind(handle.toLowerCase())
    .all<{ kind: string; n: number }>();
  const counts: Record<string, number> = { all: 0 };
  for (const r of results) {
    counts[`kind:${r.kind}`] = r.n;
    counts.all += r.n;
  }
  return counts;
}

/** Items per sitemap shard; each is listed in both languages, under the 50,000 addresses a sitemap may hold. */
export const SITEMAP_SHARD = 20_000;

/**
 * Headers for a Harness page: the same for every reader, so browsers keep it a
 * minute and the Worker's edge cache five (api/index.ts).
 */
export function cacheable(headers: Headers) {
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
}
