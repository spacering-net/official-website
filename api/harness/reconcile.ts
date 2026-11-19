import { uuidv7 } from '../ids';
import type { PluginRun } from './importers/github';
import type { Checks, ItemStatus, Listing, Risk } from './model';
import { excerpt, renderMarkdown } from './markdown';
import { pluginCardOf, type PluginDescriptor } from './plugin';
import { freshChecks, type RescanRow } from './rescan';
import { docsFor, membersOf, searchDoc, searchStatements, withMembers } from './search';
import { decideStatus, popularityOf } from './store';
import { loadTags } from './tags';

/**
 * The reconcile (docs/harness-plugins.md, section 4): the one place where a
 * plugin's version becomes current and its members leave the shelves or come
 * back. It reads only the database: the last complete import of a source
 * (import_runs, named by import_sources.staged_run) and the items as they
 * stand. Plugins that share members, now or before, are one group, and a
 * group changes in one batch, so a member is never on the shelves beside the
 * plugin that holds it, nor missing while no plugin holds it.
 *
 * Every batch begins with a guard that fails it unless the source still has
 * this lease and this run: a reconcile that has been overtaken (a newer
 * import, another reconcile) changes nothing.
 */

const LEASE_MS = 10 * 60 * 1000;
/** staged versions an import left and no reconcile took, kept this long */
const STAGED_DAYS = 7;
/** a group is one batch; one bigger than this is left as it is, and reported */
const MAX_GROUP = 900;

const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');
const json = (v: unknown) => JSON.stringify(v);

export interface ReconcileResult {
  status: 'done' | 'busy' | 'stale' | 'none';
  /** items whose place changed */
  changed: number;
  /** groups left as they were (too big) */
  skipped: string[];
}

interface ItemRow {
  seq: number;
  id: string;
  kind: string;
  name: string;
  status: ItemStatus;
  listed_reasons: string;
  source_key: string;
  publisher_id: string;
  handle: string;
  covered_by: string | null;
  covered_status: string | null;
  latest_version_id: string | null;
  latest_revision: number;
  dedupe_key: string | null;
  repo_stars: number | null;
  featured: number;
  boost: number;
  runtime: string;
  bulk: number;
  bulk_exempt: number;
}

interface VersionRow {
  id: string;
  item_id: string;
  revision: number;
  status: string;
  risk: Risk;
  checks: string;
  listing: string;
  content_sha256: string;
  committed_at: string | null;
  created_at: string;
  excerpt: string | null;
  hosted: number;
  source_commit: string | null;
  metadata: string;
  readme: string | null;
}

const ITEM_COLUMNS = `i.seq, i.id, i.kind, i.name, i.status, i.listed_reasons, i.source_key, i.publisher_id, p.handle, i.covered_by, i.covered_status,
  i.latest_version_id, i.latest_revision, i.dedupe_key, i.repo_stars, i.featured, i.boost, i.runtime, p.bulk, p.bulk_exempt`;

async function items(db: D1Database, where: string, binds: unknown[]): Promise<ItemRow[]> {
  const { results } = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM items i JOIN publishers p ON p.id = i.publisher_id WHERE ${where}`).bind(...binds).all<ItemRow>();
  return results;
}

async function itemsByKey(db: D1Database, keys: string[]): Promise<ItemRow[]> {
  const out: ItemRow[] = [];
  for (let i = 0; i < keys.length; i += 90) out.push(...(await items(db, `i.source_key IN (${marks(keys.slice(i, i + 90).length)})`, keys.slice(i, i + 90))));
  return out;
}

async function versions(db: D1Database, ids: string[]): Promise<Map<string, VersionRow>> {
  const out = new Map<string, VersionRow>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT id, item_id, revision, status, risk, checks, listing, content_sha256, committed_at, created_at, excerpt, hosted, source_commit, metadata, readme
           FROM item_versions WHERE id IN (${marks(chunk.length)})`,
      )
      .bind(...chunk)
      .all<VersionRow>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

/**
 * A plugin version's description, when it was saved without one (before
 * plugins kept theirs): its README, rendered as an import renders one, and
 * its excerpt for search. Null when there is nothing to add.
 */
async function described(env: Env, v: VersionRow): Promise<D1PreparedStatement | null> {
  if (!v.hosted || v.readme || (JSON.parse(v.checks) as Checks).secrets.length) return null;
  const db = env.HARNESS_DB;
  const file = await db
    .prepare("SELECT sha256 FROM version_files WHERE version_id = ?1 AND (path LIKE 'README.md' OR path LIKE 'README.markdown') ORDER BY path LIMIT 1")
    .bind(v.id)
    .first<{ sha256: string }>();
  const object = file ? await env.HARNESS_FILES.get(`blobs/${file.sha256}`) : null;
  if (!object) return null;
  const text = await object.text();
  if (!text.trim()) return null;
  const key = `readme/${v.id}.html`;
  await env.HARNESS_FILES.put(key, renderMarkdown(text), { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  v.readme = key;
  v.excerpt ??= excerpt(text);
  return db.prepare('UPDATE item_versions SET readme = ?1, excerpt = COALESCE(excerpt, ?2) WHERE id = ?3 AND readme IS NULL').bind(key, v.excerpt, v.id);
}

/** Why an item would not be on the shelves, by the same rules saving uses (store.ts), but for its being a copy. */
function reasonsOf(checks: Checks, item: ItemRow): string[] {
  const reasons = [...checks.quality.reasons];
  if (checks.secrets.length) reasons.push('secrets');
  if (checks.format.errors.length) reasons.push('format');
  if (item.bulk && !item.bulk_exempt) reasons.push('bulk_publisher');
  return reasons;
}

/** Whether another item holds this dedupe key ahead of the item (one on the shelves, waiting for review, or a member that was public). */
async function heldByOther(db: D1Database, key: string | null, item: { id: string; seq: number }): Promise<boolean> {
  if (!key) return false;
  const holder = await db
    .prepare(
      `SELECT id FROM items WHERE dedupe_key = ?1 AND id != ?2
          AND (status IN ('public', 'pending') OR (status = 'deleted' AND covered_by IS NOT NULL AND covered_status = 'public'))
        ORDER BY seq LIMIT 1`,
    )
    .bind(key, item.id)
    .first<{ id: string }>();
  return !!holder;
}

/**
 * Reconcile a source: make its last complete import's plugins current, and
 * put each plugin's members where the plugin's place says. `runId`: the run a
 * job was queued for; a newer one makes it stale.
 */
export async function reconcile(env: Env, sourceId: string, runId?: string): Promise<ReconcileResult> {
  const db = env.HARNESS_DB;
  const result: ReconcileResult = { status: 'done', changed: 0, skipped: [] };
  const source = await db.prepare('SELECT id, staged_run, lease, lease_until FROM import_sources WHERE id = ?1').bind(sourceId).first<{ id: string; staged_run: string | null }>();
  if (!source?.staged_run) return { ...result, status: 'none' };
  if (runId && runId !== source.staged_run) return { ...result, status: 'stale' };
  const run = source.staged_run;
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const lease = uuidv7();
  const took = await db
    .prepare('UPDATE import_sources SET lease = ?1, lease_until = ?2 WHERE id = ?3 AND staged_run = ?4 AND (lease IS NULL OR lease_until IS NULL OR lease_until < ?5)')
    .bind(lease, new Date(nowDate.getTime() + LEASE_MS).toISOString(), sourceId, run, now)
    .run();
  if (took.meta.changes !== 1) return { ...result, status: 'busy' };
  try {
    return await reconcileHeld(env, sourceId, run, lease, result);
  } finally {
    await db.prepare('UPDATE import_sources SET lease = NULL, lease_until = NULL WHERE id = ?1 AND lease = ?2').bind(sourceId, lease).run();
  }
}

async function reconcileHeld(env: Env, sourceId: string, run: string, lease: string, result: ReconcileResult): Promise<ReconcileResult> {
  const db = env.HARNESS_DB;
  const flag = env.HARNESS_PLUGINS === 'on';
  const now = new Date().toISOString();
  const row = await db.prepare('SELECT plugins FROM import_runs WHERE run_id = ?1').bind(run).first<{ plugins: string }>();
  if (!row) return { ...result, status: 'none' };
  const manifest = JSON.parse(row.plugins) as { plugins: PluginRun[]; loose: string[] };
  const prefix = `${sourceId}:`;
  const pluginPrefix = `${prefix}plugin:`;

  // what is there: this source's plugins, the members its run names, and whatever its plugins hold now
  const pluginItems = await items(db, "i.source_key >= ?1 AND i.source_key < ?2 AND i.kind = 'plugin'", [pluginPrefix, `${pluginPrefix}\u{10FFFF}`]);
  const pluginByKey = new Map(pluginItems.map((p) => [p.source_key, p]));
  const pluginIds = pluginItems.map((p) => p.id);
  const memberKeys = [...new Set(manifest.plugins.flatMap((p) => p.members))];
  const memberRows = new Map((await itemsByKey(db, memberKeys)).map((m) => [m.id, m]));
  for (let i = 0; i < pluginIds.length; i += 90) {
    for (const m of await items(db, `i.covered_by IN (${marks(pluginIds.slice(i, i + 90).length)})`, pluginIds.slice(i, i + 90))) memberRows.set(m.id, m);
  }
  // members made deleted and not yet held by a plugin (new ones, while plugins take their members)
  for (const m of await items(db, "i.source_key >= ?1 AND i.source_key < ?2 AND i.status = 'deleted' AND i.covered_by IS NULL AND i.listed_reasons LIKE '%\"in_plugin\"%'", [prefix, `${prefix}\u{10FFFF}`])) {
    memberRows.set(m.id, m);
  }
  const memberByKey = new Map([...memberRows.values()].map((m) => [m.source_key, m]));

  const pluginVersions = await versions(db, manifest.plugins.map((p) => p.version).filter(Boolean));
  const memberVersions = await versions(db, [...memberRows.values()].map((m) => m.latest_version_id).filter((v): v is string => !!v));

  // each plugin's place, by its version
  interface PluginPlan {
    run: PluginRun;
    item: ItemRow;
    version: VersionRow;
    status: ItemStatus;
    reasons: string[];
    covers: boolean;
    /** what the package's holding was decided by: checked again when the batch commits */
    holds: { key: string; mine: string[]; older: boolean };
  }
  // plugins gone from the repository are retired; those no longer used whole are deleted (their members
  // come back); both lose what they held
  const inRun = new Set(manifest.plugins.map((p) => p.key));
  const loose = new Set(manifest.loose);
  const leaving = pluginItems.filter((p) => !inRun.has(p.source_key) && !['retired', 'removed', 'draft'].includes(p.status) && !(p.status === 'deleted' && loose.has(p.source_key)));

  const plans: PluginPlan[] = [];
  const candidates = [...manifest.plugins]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ p, item: pluginByKey.get(p.key), version: pluginVersions.get(p.version) }))
    .filter((c): c is { p: PluginRun; item: ItemRow; version: VersionRow } => !!c.item && !!c.version && c.version.item_id === c.item.id);
  for (const { p, item, version } of candidates) {
    const checks = JSON.parse(version.checks) as Checks;
    const reasons = reasonsOf(checks, item);
    // A copy of a package stays listed. One out elsewhere (another source's) holds it, as for any item,
    // unless this plugin already holds it and is the older; among this run's plugins with the package, the
    // oldest, whatever this run makes of the others. So a replay, here or there, decides the same.
    // Plugins this reconcile takes off hold nothing.
    const key = `plugin:${version.content_sha256}`;
    const same = candidates.filter((c) => c.version.content_sha256 === version.content_sha256).map((c) => c.item);
    const mine = [...same, ...leaving].map((x) => x.id);
    const elsewhere = await db
      // a copy (one listed or waiting for review as a duplicate) holds nothing
      .prepare(
        `SELECT min(seq) AS seq FROM items WHERE dedupe_key = ?1 AND status IN ('public', 'pending') AND listed_reasons NOT LIKE '%"duplicate"%'
            AND id NOT IN (${marks(mine.length, 2)})`,
      )
      .bind(key, ...mine)
      .first<{ seq: number | null }>();
    // holding it now: out (or waiting for review) with this package, and not as a copy
    const holds = item.dedupe_key === key && (item.status === 'public' || item.status === 'pending') && !item.listed_reasons.includes('"duplicate"');
    const other = elsewhere?.seq ?? null;
    if ((other !== null && (other < item.seq || !holds)) || Math.min(...same.map((x) => x.seq)) !== item.seq) reasons.push('duplicate');
    const holding = { key, mine, older: holds };
    // until plugins take their members, a plugin is only reachable by its address
    if (!flag) reasons.push('plugins_off');
    const status = decideStatus(item.status === 'removed' ? 'removed' : undefined, version.risk, reasons);
    plans.push({ run: p, item, version, status, reasons, covers: flag && status === 'public', holds: holding });
  }

  // which plugin holds each member: the first that can, of those that have it; members that are not
  // items of their own now (waiting for review, taken down, retired, gone, deleted by a person) stay as they are
  const holder = new Map<string, PluginPlan>();
  for (const plan of plans) {
    if (!plan.covers) continue;
    for (const key of plan.run.members) {
      const m = memberByKey.get(key);
      if (!m || holder.has(m.id)) continue;
      const reasons = JSON.parse(m.listed_reasons) as string[];
      const takeable = m.status === 'public' || m.status === 'listed' || (m.status === 'deleted' && reasons.includes('in_plugin'));
      if (takeable) holder.set(m.id, plan);
    }
  }

  // the place a member would have on its own: from its checks by today's rules (read again where older ones
  // made them, before it comes back), and whether something else holds its dedupe key
  const inPlugin = (m: ItemRow) => m.status === 'deleted' && (JSON.parse(m.listed_reasons) as string[]).includes('in_plugin');
  const fresh = await freshChecks(
    env,
    [...memberRows.values()]
      .filter((m) => inPlugin(m) && m.latest_version_id && memberVersions.has(m.latest_version_id))
      .map((m) => rescanRow(m, memberVersions.get(m.latest_version_id!)!)),
  );
  const places = new Map<string, { status: ItemStatus; reasons: string[] } | null>();
  const placeOf = async (m: ItemRow): Promise<{ status: ItemStatus; reasons: string[] } | null> => {
    if (places.has(m.id)) return places.get(m.id)!;
    const v = m.latest_version_id ? fresh.get(m.latest_version_id) : undefined;
    let place: { status: ItemStatus; reasons: string[] } | null = null;
    if (v) {
      const reasons = reasonsOf(v.checks, m);
      if (await heldByOther(db, m.dedupe_key, m)) reasons.push('duplicate');
      place = { status: decideStatus(undefined, v.risk, reasons), reasons };
    }
    places.set(m.id, place);
    return place;
  };
  // a member made deleted at saving (new) is taken only if it would be on the shelves or listed on its own;
  // one waiting for review comes back to wait
  const unplaced = new Set<string>();
  for (const [id] of [...holder]) {
    const m = memberRows.get(id)!;
    if (m.status !== 'deleted' || m.covered_by) continue;
    const place = await placeOf(m);
    if (!place) unplaced.add(id);
    else if (place.status !== 'public' && place.status !== 'listed') holder.delete(id);
  }
  // members to bring back: deleted for a plugin, and held by none from now on
  const restore = [...memberRows.values()].filter((m) => inPlugin(m) && !holder.has(m.id));

  // groups: plugins linked by members they hold now or will hold
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const join = (a: string, b: string) => {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const p of [...plans.map((x) => x.item), ...leaving]) join(p.id, p.id);
  // a plugin handing its package to another (a rename) changes with it, in one batch
  for (const p of leaving) for (const plan of plans) if (p.dedupe_key && p.dedupe_key === plan.holds.key) join(p.id, plan.item.id);
  for (const [m, plan] of holder) join(m, plan.item.id);
  // every plugin with every member it could hold: which one does may change with any of them
  for (const plan of plans) for (const key of plan.run.members) {
    const m = memberByKey.get(key);
    if (m) join(m.id, plan.item.id);
  }
  for (const m of memberRows.values()) if (m.covered_by) join(m.id, m.covered_by);
  for (const m of restore) join(m.id, m.id);

  const tags = new Map((await loadTags(db)).map((t) => [t.id, t]));
  const members = await membersOf(db, plans.map((p) => p.version.id));
  const restoreDocs = await docsFor(db, restore.map((m) => m.id));
  // each batch fails whole unless the source still has this lease, unexpired, and this run; and holds on to it
  const guarded = (statements: D1PreparedStatement[]) => {
    const at = new Date();
    return [
      db
        .prepare("SELECT json(CASE WHEN EXISTS (SELECT 1 FROM import_sources WHERE id = ?1 AND lease = ?2 AND staged_run = ?3 AND lease_until > ?4) THEN '1' ELSE 'stale' END)")
        .bind(sourceId, lease, run, at.toISOString()),
      db.prepare('UPDATE import_sources SET lease_until = ?1 WHERE id = ?2 AND lease = ?3').bind(new Date(at.getTime() + LEASE_MS).toISOString(), sourceId, lease),
      ...statements,
    ];
  };
  const groups = new Map<string, { statements: D1PreparedStatement[]; changed: number; label: string; blocked: boolean }>();
  const groupOf = (id: string) => {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, { statements: [], changed: 0, label: id, blocked: false });
    return groups.get(root)!;
  };
  const event = (itemId: string, versionId: string | null, from: ItemStatus, to: ItemStatus, reason: string) =>
    db
      .prepare("INSERT INTO moderation_events (id, item_id, version_id, actor, action, reason, data, created_at) VALUES (?1, ?2, ?3, 'system', 'status', ?4, ?5, ?6)")
      .bind(uuidv7(), itemId, versionId, reason, json({ from, to }), now);
  const unindex = (id: string) => db.prepare('DELETE FROM item_search WHERE rowid = (SELECT seq FROM items WHERE id = ?1)').bind(id);

  for (const plan of plans) {
    const { item, version, status, reasons } = plan;
    const g = groupOf(item.id);
    g.label = item.source_key;
    const listing = JSON.parse(version.listing) as Listing;
    const committed = version.committed_at ?? version.created_at;
    const newVersion = item.latest_version_id !== version.id;
    // Another source's reconcile may have put the same package out since this one read it (each holds only
    // its own source): when this plugin is to be out, the batch fails unless the package is still free for
    // it, and the job is run again, to find it held.
    if ((status === 'public' || status === 'pending') && !reasons.includes('duplicate')) {
      const { key, mine, older } = plan.holds;
      g.statements.push(
        db
          .prepare(
            `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM items WHERE dedupe_key = ?1 AND status IN ('public', 'pending')
                                       AND listed_reasons NOT LIKE '%"duplicate"%' AND id NOT IN (${marks(mine.length, 4)})
                                       AND (seq < ?2 OR ?3 = 0)) THEN 'held' ELSE '1' END)`,
          )
          .bind(key, item.seq, older ? 1 : 0, ...mine),
      );
    }
    if (newVersion) g.statements.push(db.prepare("UPDATE item_versions SET status = 'ok' WHERE id = ?1 AND status = 'staged'").bind(version.id));
    const description = await described(env, version);
    if (description) g.statements.push(description);
    const quality = (JSON.parse(version.checks) as Checks).quality.score;
    const popularity = popularityOf(quality, item.repo_stars, !!item.featured, item.boost, plan.run.order + 1);
    const descriptor = (JSON.parse(version.metadata) as { plugin?: PluginDescriptor }).plugin;
    g.statements.push(
      db
        .prepare(
          `UPDATE items SET status = ?1, listed_reasons = ?2, latest_version_id = ?3, latest_revision = ?4, title_en = ?5, title_zh = ?6,
                  summary_en = ?7, summary_zh = ?8, dedupe_key = ?9, risk = ?10, quality = ?11, popularity = ?12, version_at = ?13,
                  published_at = COALESCE(published_at, CASE WHEN ?1 = 'public' THEN ?13 END), updated_at = ?14, card = ?16
            WHERE id = ?15 AND latest_revision <= ?4`,
        )
        .bind(
          status, json(reasons), version.id, version.revision, listing.title.en ?? null, listing.title.zh ?? null, listing.summary.en ?? null,
          listing.summary.zh ?? null, `plugin:${version.content_sha256}`, version.risk, quality, popularity, committed, now, item.id,
          descriptor ? json(pluginCardOf(descriptor)) : null,
        ),
    );
    if (newVersion) {
      g.statements.push(db.prepare('DELETE FROM item_tags WHERE item_id = ?1').bind(item.id));
      for (const t of listing.tags) g.statements.push(db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?1, ?2)').bind(item.id, t));
    }
    if (item.status !== status || newVersion || description) {
      const doc = searchDoc({
        name: item.name,
        handle: item.handle,
        kind: 'plugin',
        runtime: item.runtime,
        title: listing.title,
        summary: listing.summary,
        excerpt: withMembers(version.hosted ? version.excerpt : null, members.get(version.id) ?? []),
        tags: listing.tags.map((t) => tags.get(t)).filter((t): t is NonNullable<typeof t> => !!t),
      });
      g.statements.push(...searchStatements(db, item.id, version.id, doc));
    }
    if (item.status !== status) {
      g.statements.push(event(item.id, version.id, item.status, status, 'reconcile'));
      g.changed++;
    }
  }

  for (const [id, plan] of holder) {
    const m = memberRows.get(id)!;
    if (m.status === 'deleted' && m.covered_by === plan.item.id) continue;
    const g = groupOf(id);
    let was = m.status === 'deleted' ? (m.covered_status as ItemStatus | null) : m.status;
    if (m.status === 'deleted' && !m.covered_by) {
      // made deleted at saving: the place it would have had decides whether it keeps its key
      if (unplaced.has(id)) {
        g.blocked = true;
        continue;
      }
      was = (await placeOf(m))!.status;
    }
    g.statements.push(
      db
        .prepare(`UPDATE items SET status = 'deleted', covered_by = ?1, covered_status = ?2, listed_reasons = '["in_plugin"]', updated_at = ?3 WHERE id = ?4`)
        .bind(plan.item.id, was, now, id),
    );
    g.statements.push(unindex(id));
    if (m.status !== 'deleted') {
      g.statements.push(event(id, m.latest_version_id, m.status, 'deleted', 'in_plugin'));
      g.changed++;
    }
  }

  // members gone from the repository while held: no longer held, nor holding their key; still deleted
  for (const m of memberRows.values()) {
    if (m.status !== 'deleted' || !m.covered_by || !(JSON.parse(m.listed_reasons) as string[]).includes('gone')) continue;
    groupOf(m.id).statements.push(db.prepare('UPDATE items SET covered_by = NULL, covered_status = NULL, updated_at = ?1 WHERE id = ?2').bind(now, m.id));
  }

  for (const m of restore) {
    const place = await placeOf(m);
    const g = groupOf(m.id);
    if (!place) {
      // its files cannot be read now: its group stays as it is until the next reconcile, so that it is not
      // left off the shelves with nothing holding it
      g.blocked = true;
      continue;
    }
    g.statements.push(
      db
        .prepare(
          `UPDATE items SET status = ?1, listed_reasons = ?2, covered_by = NULL, covered_status = NULL, risk = ?3, updated_at = ?4,
                  published_at = COALESCE(published_at, CASE WHEN ?1 = 'public' THEN version_at END)
            WHERE id = ?5`,
        )
        .bind(place.status, json(place.reasons), fresh.get(m.latest_version_id!)!.risk, now, m.id),
    );
    const doc = restoreDocs.get(m.id);
    if (doc) g.statements.push(...searchStatements(db, m.id, doc.version, doc.doc));
    g.statements.push(event(m.id, m.latest_version_id, 'deleted', place.status, 'out_of_plugin'));
    g.changed++;
  }

  for (const p of leaving) {
    const g = groupOf(p.id);
    const to: ItemStatus = loose.has(p.source_key) ? 'deleted' : 'retired';
    g.statements.push(
      db
        .prepare(`UPDATE items SET status = ?1, listed_reasons = ?2, updated_at = ?3 WHERE id = ?4`)
        .bind(to, to === 'deleted' ? '["not_whole"]' : p.listed_reasons, now, p.id),
    );
    g.statements.push(unindex(p.id));
    g.statements.push(event(p.id, p.latest_version_id, p.status, to, to === 'deleted' ? 'not_whole' : 'gone'));
    g.changed++;
  }

  for (const g of groups.values()) {
    if (!g.statements.length) continue;
    if (g.blocked) {
      result.skipped.push(g.label);
      continue;
    }
    if (g.statements.length > MAX_GROUP) {
      console.warn(`[harness] reconcile ${sourceId}: group of ${g.label} has ${g.statements.length} statements; left as it is`);
      result.skipped.push(g.label);
      continue;
    }
    try {
      await db.batch(guarded(g.statements));
    } catch (err) {
      const still = await db.prepare('SELECT 1 AS ok FROM import_sources WHERE id = ?1 AND lease = ?2 AND staged_run = ?3').bind(sourceId, lease, run).first();
      if (!still) return { ...result, status: 'stale' };
      throw err;
    }
    result.changed += g.changed;
  }

  // plugins that run things on their own and wait for a person to approve their package (pnpm harness:approve-exec)
  for (const plan of plans) {
    const autorun = (JSON.parse(plan.version.metadata) as { plugin?: { autorun?: unknown[] } }).plugin?.autorun?.length;
    if (!autorun) continue;
    const ok = await db.prepare('SELECT 1 AS ok FROM exec_approvals WHERE content_sha256 = ?1').bind(plan.version.content_sha256).first();
    if (!ok) console.info(`[harness] awaiting approval to install whole: ${plan.item.handle}/${plan.item.name} #${plan.version.revision}`);
  }

  // staged versions left by imports no reconcile took, after a while
  const before = new Date(Date.now() - STAGED_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const keep = manifest.plugins.map((p) => p.version);
  const { results: old } = await db
    .prepare(
      `SELECT v.id FROM item_versions v JOIN items i ON i.id = v.item_id
        WHERE i.source_key >= ?1 AND i.source_key < ?2 AND v.status = 'staged' AND v.created_at < ?3`,
    )
    .bind(pluginPrefix, `${pluginPrefix}\u{10FFFF}`, before)
    .all<{ id: string }>();
  for (const { id } of old.filter((o) => !keep.includes(o.id))) {
    await db.batch(
      guarded([
      db.prepare('DELETE FROM plugin_components WHERE version_id = ?1').bind(id),
      db.prepare('DELETE FROM version_files WHERE version_id = ?1').bind(id),
      db.prepare("DELETE FROM item_versions WHERE id = ?1 AND status = 'staged'").bind(id),
      ]),
    );
  }
  return result;
}

function rescanRow(m: ItemRow, v: VersionRow): RescanRow {
  return {
    seq: m.seq,
    id: m.id,
    kind: m.kind,
    status: m.status,
    risk: v.risk,
    listed_reasons: m.listed_reasons,
    covered_by: m.covered_by,
    source_key: m.source_key,
    version_id: v.id,
    hosted: v.hosted,
    source_commit: v.source_commit,
    metadata: v.metadata,
    checks: v.checks,
  };
}
