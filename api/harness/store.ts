import { uuidv7 } from '../ids';
import { buildZip, putArchive, putBlob, sha256, type PackageFile } from './files';
import { renderMarkdown } from './markdown';
import type { Checks, ItemKind, ItemStatus, Listing, PinnedPackage, Risk } from './model';
import type { PermissionProfile } from './scan/permissions';
import { searchDoc, searchStatements } from './search';
import { loadTags } from './tags';

/** Who an imported item is published under, as its source names them. */
export interface PublisherRef {
  handle: string;
  kind: 'github' | 'domain';
  name: string;
  githubLogin?: string;
  githubId?: number;
  domain?: string;
  /** a new publisher already known to publish in bulk (registry imports count ahead) */
  bulk?: boolean;
}

/** One imported (or, from H2, uploaded) version of an item, checked and ready to keep. */
export interface VersionInput {
  /** where it came from, stable across imports: 'registry:<server name>', 'github:<owner>/<repo>:<path>' */
  sourceKey: string;
  source: 'registry' | 'github';
  publisher: PublisherRef;
  /** the item's name under its publisher (text.ts NAME_RE); another is chosen if it is taken */
  name: string;
  kind: ItemKind;
  listing: Listing;
  repositoryUrl?: string | null;
  websiteUrl?: string | null;
  license?: string | null;
  runtime: string;
  /** what it installs; copies of the same thing published again under other names stay listed */
  dedupeKey?: string | null;
  /** the publisher owns what it installs (its repository is theirs): wins over a copy in the same import */
  owns?: boolean;
  version?: string | null;
  contentSha256: string;
  sourceCommit?: string | null;
  sourceUrl?: string | null;
  files: PackageFile[];
  /** the license lets us keep and hand out the files */
  hosted: boolean;
  metadata: unknown;
  permissions: PermissionProfile;
  checks: Checks;
  packages: PinnedPackage[];
  /** the description, as Markdown */
  readme?: string | null;
  excerpt?: string | null;
  /** when the source published this version */
  versionAt: string;
  risk: Risk;
  repoStars?: number | null;
  /** what its card shows besides the title and summary (items.card), by kind: a prompt's StoredPromptCard */
  card?: unknown;
  /** what its own signals add to its popularity (items.boost): a prompt's results */
  boost?: number;
}

export interface SaveResult {
  created: number;
  updated: number;
  unchanged: number;
  /** inputs not reached before the deadline, left for the next run */
  remaining: number;
  /** new versions, by source key */
  versions: Map<string, string>;
}

/**
 * Where an item belongs. High risk waits for a person (pending); any reason
 * against the shelves keeps it listed; otherwise it is public. Removed items
 * stay removed: only a person brings one back.
 */
export function decideStatus(current: ItemStatus | undefined, risk: Risk, reasons: string[]): ItemStatus {
  if (current === 'removed') return 'removed';
  if (risk === 'high') return 'pending';
  return reasons.length ? 'listed' : 'public';
}

/** log10(1 + stars), with what the item's own signals add (`boost`), lowered for stuffed descriptions; installs join in H3. */
export const popularityOf = (quality: number, repoStars: number | null | undefined, featured = false, boost = 0) =>
  Math.round(quality * (Math.log10(1 + Math.max(0, repoStars ?? 0)) + boost + (featured ? 2 : 0)) * 1000) / 1000;

const json = (v: unknown) => JSON.stringify(v);
const unique = <T>(xs: T[]) => [...new Set(xs)];
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');

/** Run statements in batches of at most ~90, never splitting a group: each group is one item's change, all or nothing. */
export async function runGroups(db: D1Database, groups: D1PreparedStatement[][]): Promise<void> {
  let batch: D1PreparedStatement[] = [];
  for (const g of groups) {
    if (batch.length && batch.length + g.length > 90) {
      await db.batch(batch);
      batch = [];
    }
    batch.push(...g);
  }
  if (batch.length) await db.batch(batch);
}

interface ItemRow {
  id: string;
  latest_version_id: string;
  publisher_id: string;
  name: string;
  status: ItemStatus;
  listed_reasons: string;
  latest_revision: number;
  source_key: string;
  published_at: string | null;
  quality: number;
  repo_stars: number | null;
  featured: number;
  card: string | null;
  boost: number;
  content_sha256: string | null;
}

/**
 * Keep a set of versions: publishers and items created as needed, a new
 * revision only where the content changed, files and the package zip stored
 * in R2 by hash (when the license allows), then the search index brought up
 * to date. Each item's rows are written together or not at all. With a
 * deadline (a time in ms), no chunk is started after it: what is left is
 * counted in `remaining`, for a later run (where what was saved is unchanged).
 *
 * `collection`: the source-key prefix of a source whose importer already
 * keeps its items' dedupe keys apart (a prompt collection merges copies of a
 * prompt into one item). Its own items saved before do not count as holding
 * a key, since in this same import they may be changing or leaving: an entry
 * that takes over another's prompt is not a copy of it.
 */
export async function saveVersions(env: Env, inputs: VersionInput[], until?: number, collection?: string): Promise<SaveResult> {
  const result: SaveResult = { created: 0, updated: 0, unchanged: 0, remaining: 0, versions: new Map() };
  for (let i = 0; i < inputs.length; i += 40) {
    if (until !== undefined && Date.now() >= until) {
      result.remaining = inputs.length - i;
      break;
    }
    await saveChunk(env, inputs.slice(i, i + 40), result, collection);
  }
  return result;
}

/** Run these, at most `limit` at a time (a Worker has six connections open at once). */
async function inParallel(tasks: Iterable<() => Promise<unknown>>, limit = 6): Promise<void> {
  const queue = [...tasks];
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) await task();
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

async function saveChunk(env: Env, inputs: VersionInput[], result: SaveResult, collection?: string): Promise<void> {
  const db = env.HARNESS_DB;
  const now = new Date().toISOString();

  // what already exists: publishers, the items themselves, names in use, and holders of the same dedupe keys
  const handles = unique(inputs.map((i) => i.publisher.handle));
  const { results: pubRows } = await db
    .prepare(`SELECT id, handle, bulk, bulk_exempt FROM publishers WHERE handle IN (${marks(handles.length)})`)
    .bind(...handles)
    .all<{ id: string; handle: string; bulk: number; bulk_exempt: number }>();
  const publishers = new Map(pubRows.map((p) => [p.handle, p]));

  const keys = inputs.map((i) => i.sourceKey);
  const { results: itemRows } = await db
    .prepare(
      `SELECT i.id, i.latest_version_id, i.publisher_id, i.name, i.status, i.listed_reasons, i.latest_revision, i.source_key, i.published_at,
              i.quality, i.repo_stars, i.featured, i.card, i.boost, v.content_sha256
         FROM items i LEFT JOIN item_versions v ON v.id = i.latest_version_id
        WHERE i.source_key IN (${marks(keys.length)})`,
    )
    .bind(...keys)
    .all<ItemRow>();
  const existing = new Map(itemRows.map((r) => [r.source_key, r]));

  // names already used under these publishers (a cross product, filtered below)
  const pubIds = unique(pubRows.map((p) => p.id));
  const names = unique(inputs.map((i) => i.name));
  const taken = new Set<string>();
  if (pubIds.length) {
    const { results } = await db
      .prepare(`SELECT publisher_id, name FROM items WHERE publisher_id IN (${marks(pubIds.length)}) AND name IN (${marks(names.length, pubIds.length + 1)})`)
      .bind(...pubIds, ...names)
      .all<{ publisher_id: string; name: string }>();
    for (const r of results) taken.add(`${r.publisher_id}/${r.name}`);
  }
  /** a free name under the publisher: the one asked for, or it with -2, -3, ... */
  const freeName = async (pubId: string, name: string) => {
    if (!taken.has(`${pubId}/${name}`)) return name;
    const base = name.slice(0, 60);
    const { results } = await db
      .prepare("SELECT name FROM items WHERE publisher_id = ?1 AND name LIKE ?2 || '-%'")
      .bind(pubId, base)
      .all<{ name: string }>();
    for (const r of results) taken.add(`${pubId}/${r.name}`);
    let n = 2;
    while (taken.has(`${pubId}/${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  // Who holds each dedupe key: an item already on the shelves (or waiting for review) keeps it.
  // Among new ones in this set, an owner beats a copy; otherwise the first one wins.
  const dedupe = unique(inputs.map((i) => i.dedupeKey).filter((k): k is string => !!k));
  const holders = new Map<string, string>();
  const keptByDb = new Set<string>();
  if (dedupe.length) {
    const { results } = await db
      .prepare(`SELECT dedupe_key, source_key FROM items WHERE dedupe_key IN (${marks(dedupe.length)}) AND status IN ('public', 'pending') ORDER BY seq`)
      .bind(...dedupe)
      .all<{ dedupe_key: string; source_key: string }>();
    for (const r of results) {
      if (holders.has(r.dedupe_key) || (collection && r.source_key.startsWith(collection))) continue;
      holders.set(r.dedupe_key, r.source_key);
      keptByDb.add(r.dedupe_key);
    }
  }
  for (const i of inputs) {
    if (!i.dedupeKey || keptByDb.has(i.dedupeKey)) continue;
    const held = holders.get(i.dedupeKey);
    if (!held) holders.set(i.dedupeKey, i.sourceKey);
    else if (i.owns && !inputs.find((x) => x.sourceKey === held)?.owns) holders.set(i.dedupeKey, i.sourceKey);
  }
  const tagNames = new Map((await loadTags(db)).map((t) => [t.id, t]));

  const groups: D1PreparedStatement[][] = [];
  /** R2 writes for the new versions, each object once (many skills share a file) */
  const writes = new Map<string, () => Promise<unknown>>();

  for (const input of inputs) {
    const group: D1PreparedStatement[] = [];
    let pub = publishers.get(input.publisher.handle);
    if (!pub) {
      const p = input.publisher;
      pub = { id: uuidv7(), handle: p.handle, bulk: p.bulk ? 1 : 0, bulk_exempt: 0 };
      publishers.set(pub.handle, pub);
      group.push(
        db
          .prepare(
            `INSERT INTO publishers (id, handle, kind, github_id, github_login, domain, name, bulk, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) ON CONFLICT (handle) DO NOTHING`,
          )
          .bind(pub.id, p.handle, p.kind, p.githubId ?? null, p.githubLogin ?? null, p.domain ?? null, p.name, pub.bulk, now),
      );
    } else if (input.publisher.githubId) {
      group.push(db.prepare('UPDATE OR IGNORE publishers SET github_id = ?1, updated_at = ?2 WHERE id = ?3 AND github_id IS NULL').bind(input.publisher.githubId, now, pub.id));
    }

    const old = existing.get(input.sourceKey);
    const reasons = [...input.checks.quality.reasons];
    if (input.checks.secrets.length) reasons.push('secrets');
    if (input.checks.format.errors.length) reasons.push('format');
    if (input.dedupeKey && holders.get(input.dedupeKey) !== input.sourceKey) reasons.push('duplicate');
    if (pub.bulk && !pub.bulk_exempt) reasons.push('bulk_publisher');
    const status = decideStatus(old?.status, input.risk, reasons);
    const quality = input.checks.quality.score;
    const repoStars = input.repoStars ?? old?.repo_stars ?? null;
    const boost = input.boost ?? 0;
    const popularity = popularityOf(quality, repoStars, !!old?.featured, boost);
    const card = input.card === undefined || input.card === null ? null : json(input.card);
    const { title, summary, tags } = input.listing;
    // files, and anything read from them, are kept only when the license allows it
    const excerpt = input.hosted ? (input.excerpt ?? null) : null;
    const doc = (name: string) =>
      searchDoc({
        name,
        handle: input.publisher.handle,
        kind: input.kind,
        runtime: input.runtime,
        title,
        summary,
        excerpt,
        tags: tags.map((t) => tagNames.get(t)).filter((t): t is NonNullable<typeof t> => !!t),
      });

    if (old && old.content_sha256 === input.contentSha256) {
      // same content: only where it stands may have changed (a source's status, a publisher found to publish in bulk),
      // and what its card shows (the pictures it picks from, as they are found)
      result.unchanged++;
      if (old.status !== status || old.listed_reasons !== json(reasons) || old.repo_stars !== repoStars || old.card !== card || old.boost !== boost) {
        group.push(
          db
            .prepare(
              `UPDATE items SET status = ?1, listed_reasons = ?2, repo_stars = ?3, popularity = ?4, updated_at = ?5, card = ?7, boost = ?8,
                      published_at = COALESCE(published_at, CASE WHEN ?1 = 'public' THEN version_at END)
                WHERE id = ?6`,
            )
            .bind(status, json(reasons), repoStars, popularity, now, old.id, card, boost),
        );
        if (old.status !== status) group.push(event(db, old.id, null, status, old.status, now));
        group.push(...searchStatements(db, old.id, old.latest_version_id, doc(old.name)));
      }
      if (group.length) groups.push(group);
      continue;
    }

    // a new version: files and the zip go into R2 before any row refers to them (by hash; a failed
    // write leaves the rows unwritten and only unreferenced objects behind)
    const versionId = uuidv7();
    const fileRows: { path: string; sha: string; size: number; executable: boolean }[] = [];
    for (const f of input.files) {
      const sha = await sha256(f.data);
      if (input.hosted) writes.set(`blob:${sha}`, () => putBlob(env.HARNESS_FILES, sha, f.data));
      fileRows.push({ path: f.path, sha, size: f.data.length, executable: f.executable });
    }
    let archive: { sha: string; size: number } | null = null;
    if (input.hosted && input.files.length) {
      const zip = buildZip(input.files);
      const sha = await sha256(zip);
      archive = { sha, size: zip.length };
      writes.set(`archive:${sha}`, () => putArchive(env.HARNESS_FILES, sha, zip));
    }
    let readmeKey: string | null = null;
    if (input.hosted && input.readme?.trim()) {
      const key = `readme/${versionId}.html`;
      const html = renderMarkdown(input.readme);
      readmeKey = key;
      writes.set(key, () => env.HARNESS_FILES.put(key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }));
    }

    let itemId: string;
    let name: string;
    const revision = (old?.latest_revision ?? 0) + 1;
    if (!old) {
      itemId = uuidv7();
      name = await freeName(pub.id, input.name);
      taken.add(`${pub.id}/${name}`);
      group.push(
        db
          .prepare(
            `INSERT INTO items (id, publisher_id, name, kind, status, listed_reasons, title_en, title_zh, summary_en, summary_zh,
                                source, source_key, dedupe_key, repository_url, website_url, license, runtime, risk, latest_version_id,
                                latest_revision, repo_stars, quality, popularity, created_at, updated_at, version_at, published_at, card, boost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?24, ?25,
                     CASE WHEN ?5 = 'public' THEN ?25 END, ?26, ?27)`,
          )
          .bind(
            itemId, pub.id, name, input.kind, status, json(reasons), title.en ?? null, title.zh ?? null, summary.en ?? null, summary.zh ?? null,
            input.source, input.sourceKey, input.dedupeKey ?? null, input.repositoryUrl ?? null, input.websiteUrl ?? null, input.license ?? null,
            input.runtime, input.risk, versionId, revision, repoStars, quality, popularity, now, input.versionAt, card, boost,
          ),
      );
      if (status === 'pending') group.push(event(db, itemId, versionId, status, null, now));
      result.created++;
    } else {
      itemId = old.id;
      name = old.name;
      group.push(
        db
          .prepare(
            `UPDATE items SET status = ?1, listed_reasons = ?2, title_en = ?3, title_zh = ?4, summary_en = ?5, summary_zh = ?6,
                    dedupe_key = ?7, repository_url = ?8, website_url = ?9, license = ?10, runtime = ?11, risk = ?12,
                    latest_version_id = ?13, latest_revision = ?14, repo_stars = ?15, quality = ?16, popularity = ?17,
                    updated_at = ?18, version_at = ?19, published_at = COALESCE(published_at, CASE WHEN ?1 = 'public' THEN ?19 END),
                    card = ?21, boost = ?22
              WHERE id = ?20`,
          )
          .bind(
            status, json(reasons), title.en ?? null, title.zh ?? null, summary.en ?? null, summary.zh ?? null, input.dedupeKey ?? null,
            input.repositoryUrl ?? null, input.websiteUrl ?? null, input.license ?? null, input.runtime, input.risk, versionId, revision,
            repoStars, quality, popularity, now, input.versionAt, itemId, card, boost,
          ),
      );
      if (old.status !== status) group.push(event(db, itemId, versionId, status, old.status, now));
      result.updated++;
    }

    group.push(
      db
        .prepare(
          `INSERT INTO item_versions (id, item_id, revision, version, risk, content_sha256, archive_sha256, archive_size, file_count, files_size,
                                      hosted, source_commit, source_url, metadata, permissions, checks, listing, packages, readme, excerpt, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
        )
        .bind(
          versionId, itemId, revision, input.version ?? null, input.risk, input.contentSha256, archive?.sha ?? null, archive?.size ?? null,
          fileRows.length, fileRows.reduce((n, f) => n + f.size, 0), input.hosted ? 1 : 0, input.sourceCommit ?? null, input.sourceUrl ?? null,
          json(input.metadata), json(input.permissions), json(input.checks), json(input.listing), json(input.packages), readmeKey,
          excerpt, now,
        ),
    );
    for (const f of fileRows) {
      group.push(
        db
          .prepare('INSERT INTO version_files (version_id, path, sha256, size, executable) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(versionId, f.path, f.sha, f.size, f.executable ? 1 : 0),
      );
    }
    group.push(db.prepare('DELETE FROM item_tags WHERE item_id = ?1').bind(itemId));
    for (const tag of tags) group.push(db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)').bind(itemId, tag));
    // the search row changes with the item, in the same batch
    group.push(...searchStatements(db, itemId, versionId, doc(name)));

    groups.push(group);
    result.versions.set(input.sourceKey, versionId);
  }

  // each one is a round trip, so they overlap
  await inParallel(writes.values());
  await runGroups(db, groups);
}

/** An entry in the moderation log: an item moved from one status to another. */
function event(db: D1Database, itemId: string, versionId: string | null, to: ItemStatus, from: ItemStatus | null, now: string) {
  return db
    .prepare("INSERT INTO moderation_events (id, item_id, version_id, actor, action, data, created_at) VALUES (?1, ?2, ?3, 'system', 'status', ?4, ?5)")
    .bind(uuidv7(), itemId, versionId, json({ from, to }), now);
}

/** Retire items their source no longer has (deleted from the registry, gone from a repository), search rows and all. */
export async function retireItems(db: D1Database, sourceKeys: string[]): Promise<number> {
  if (!sourceKeys.length) return 0;
  const now = new Date().toISOString();
  let retired = 0;
  for (let i = 0; i < sourceKeys.length; i += 90) {
    const keys = sourceKeys.slice(i, i + 90);
    const [, updated] = await db.batch([
      db.prepare(`DELETE FROM item_search WHERE rowid IN (SELECT seq FROM items WHERE source_key IN (${marks(keys.length)}))`).bind(...keys),
      db
        .prepare(`UPDATE items SET status = 'retired', updated_at = ?1 WHERE source_key IN (${marks(keys.length, 2)}) AND status NOT IN ('retired', 'removed')`)
        .bind(now, ...keys),
    ]);
    retired += updated.meta.changes ?? 0;
  }
  return retired;
}
