import { sha256 } from '../files';
import { serverDedupeKey, isPublicHttps, ownsRepository, packagesToPin, serverPermissions, serverReasons, serverRuntime, type ServerJson } from '../mcp';
import { listingOf, type Checks, type ItemStatus, type PinnedPackage, type Risk } from '../model';
import { riskOf } from '../scan/content';
import { applyRules, loadRules } from '../scan/rules';
import { redactDeep, scanJsonSecrets } from '../scan/secrets';
import { decideStatus, retireItems, runGroups, saveVersions, type VersionInput } from '../store';
import { docsFor, searchStatements } from '../search';
import { autoTags, loadTags } from '../tags';
import { descriptionQuality, localize, namespacePublisher, toName } from '../text';
import { pinPackages } from './packages';

/**
 * The official MCP Registry (docs: section 12): about 40,000 servers, read a
 * page at a time. A full sync walks every server's latest version; after
 * that, each hourly sync asks only for what changed since the last one began
 * (deleted servers included). The registry's metadata is CC0; server.json is
 * kept as it is, Harness's own checks and listing beside it.
 */
export const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const PAGE = 50;
/** a namespace with this many servers publishes in bulk: its servers stay listed */
export const BULK = 50;

interface Official {
  status?: 'active' | 'deprecated' | 'deleted';
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

interface Entry {
  server: ServerJson & Record<string, unknown>;
  _meta?: { 'io.modelcontextprotocol.registry/official'?: Official };
}

export interface PageResult {
  next: string | null;
  seen: number;
  created: number;
  updated: number;
  retired: number;
  skipped: number;
}

const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');

/** Run `fn` over `xs`, `n` at a time. */
async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++;
        out[i] = await fn(xs[i]);
      }
    }),
  );
  return out;
}

/** One page of the registry: fetched, checked, kept. `since` set means an incremental sync. */
export async function importRegistryPage(env: Env, cursor: string | null, since: string | null): Promise<PageResult> {
  const url = new URL(REGISTRY);
  url.searchParams.set('limit', String(PAGE));
  if (cursor) url.searchParams.set('cursor', cursor);
  if (since) url.searchParams.set('updated_since', since);
  else url.searchParams.set('version', 'latest');
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'spacering.net-harness' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const page = (await res.json()) as { servers?: Entry[]; metadata?: { nextCursor?: string } };
  const entries = page.servers ?? [];
  const result: PageResult = { next: page.metadata?.nextCursor ?? null, seen: entries.length, created: 0, updated: 0, retired: 0, skipped: 0 };

  const db = env.HARNESS_DB;
  const [{ rules, hash }, tags] = await Promise.all([loadRules(db), loadTags(db)]);
  const deleted: string[] = [];
  const candidates: { entry: Entry; official: Official; ns: NonNullable<ReturnType<typeof namespacePublisher>> }[] = [];
  for (const entry of entries) {
    const official = entry._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
    const name = entry.server?.name;
    const ns = typeof name === 'string' && name.includes('/') ? namespacePublisher(name.slice(0, name.indexOf('/'))) : null;
    if (!ns || official.isLatest === false) {
      result.skipped++;
      continue;
    }
    if (official.status === 'deleted') deleted.push(`registry:${name}`);
    else candidates.push({ entry, official, ns });
  }

  // only servers not counted yet add to a publisher's count: new ones, and retired ones coming back
  const keys = candidates.map((c) => `registry:${c.entry.server.name}`);
  const { results: known } = keys.length
    ? await db
        .prepare(`SELECT source_key FROM items WHERE source_key IN (${marks(keys.length)}) AND status != 'retired'`)
        .bind(...keys)
        .all<{ source_key: string }>()
    : { results: [] };
  const seen = new Set(known.map((k) => k.source_key));
  const bulk = await markBulkPublishers(
    env,
    candidates.map((c) => c.ns.handle),
    candidates.filter((c) => !seen.has(`registry:${c.entry.server.name}`)).map((c) => c.ns.handle),
  );
  const inputs = await pool(candidates, 8, async ({ entry, official, ns }): Promise<VersionInput> => {
    const original = entry.server;
    const text = JSON.stringify(original, null, 2);
    const secrets = scanJsonSecrets('server.json', original);
    // a credential the author published by mistake is not copied here: everything below reads the redacted copy
    const s: typeof original = secrets.length ? redactDeep(original) : original;
    const findings = applyRules(rules, [{ path: 'server.json', data: new TextEncoder().encode(text), executable: false }]);
    let pinned: PinnedPackage[] = packagesToPin(s);
    if (pinned.some((p) => p.verified === 'pending')) pinned = await pinPackages(db, pinned);
    const reasons = serverReasons(s, official.status);
    if (pinned.some((p) => p.verified === 'missing')) reasons.push('package_missing');
    if (pinned.some((p) => p.verified === 'pending')) reasons.push('package_unverified');
    const description = (s.description ?? '').trim();
    const title = localize(typeof s.title === 'string' ? s.title : '');
    const summary = localize(description);
    const itemName = toName(s.name.slice(s.name.indexOf('/') + 1), 'server');
    const checks: Checks = {
      format: { errors: [], warnings: [], dropped: [] },
      secrets,
      findings,
      rules: hash,
      quality: { reasons, score: descriptionQuality(description) },
      review: 'off',
      checkedAt: new Date().toISOString(),
    };
    return {
      sourceKey: `registry:${s.name}`,
      source: 'registry',
      publisher:
        ns.kind === 'github'
          ? { kind: 'github', handle: ns.handle, name: ns.login, githubLogin: ns.login, bulk: bulk.has(ns.handle) }
          : { kind: 'domain', handle: ns.handle, name: ns.domain, domain: ns.domain, bulk: bulk.has(ns.handle) },
      name: itemName,
      kind: 'mcp',
      listing: listingOf(title, summary, autoTags(tags, { name: itemName, title: title.en ?? title.zh, summary: description })),
      repositoryUrl: s.repository?.url && /^https:\/\//.test(s.repository.url) ? s.repository.url : null,
      websiteUrl: s.websiteUrl && isPublicHttps(s.websiteUrl) ? s.websiteUrl : null,
      license: null,
      runtime: serverRuntime(s),
      dedupeKey: serverDedupeKey(s),
      owns: ns.kind === 'github' ? ownsRepository(s, ns.login) : true,
      version: typeof s.version === 'string' ? s.version : null,
      // the source's own content, so a change upstream is noticed even where the copy is redacted
      contentSha256: await sha256(JSON.stringify(original)),
      files: [],
      hosted: true,
      metadata: s,
      permissions: serverPermissions(s, pinned),
      checks,
      packages: pinned,
      versionAt: official.publishedAt ?? official.updatedAt ?? new Date().toISOString(),
      risk: riskOf(findings),
    };
  });

  const saved = await saveVersions(env, inputs);
  result.created = saved.created;
  result.updated = saved.updated;
  result.retired = await retireItems(db, deleted);
  return result;
}

/**
 * Publishers among `handles` with at least BULK servers, counting the ones
 * already kept and the new ones in this page (`fresh`, one entry per new
 * server). Those newly over the line are marked, and their public servers
 * taken off the shelves together with their search rows. Returns every bulk
 * handle in the page, including ones not created yet.
 */
async function markBulkPublishers(env: Env, handles: string[], fresh: string[]): Promise<Set<string>> {
  const db = env.HARNESS_DB;
  const added = new Map<string, number>();
  for (const h of fresh) added.set(h, (added.get(h) ?? 0) + 1);
  const list = [...new Set(handles)];
  if (!list.length) return new Set();
  const { results } = await db
    .prepare(
      `SELECT p.id, p.handle, p.bulk, p.bulk_exempt,
              (SELECT COUNT(*) FROM items i WHERE i.publisher_id = p.id AND i.source = 'registry' AND i.status != 'retired') AS n
         FROM publishers p WHERE p.handle IN (${marks(list.length)})`,
    )
    .bind(...list)
    .all<{ id: string; handle: string; bulk: number; bulk_exempt: number; n: number }>();
  const known = new Map(results.map((r) => [r.handle, r]));
  const bulk = new Set<string>();
  const now = new Date().toISOString();
  for (const handle of list) {
    const p = known.get(handle);
    if (p?.bulk) {
      bulk.add(handle);
      continue;
    }
    if ((p?.n ?? 0) + (added.get(handle) ?? 0) < BULK) continue;
    bulk.add(handle);
    if (!p) continue; // created with the mark (store.ts)
    const statements = [db.prepare('UPDATE publishers SET bulk = 1, updated_at = ?1 WHERE id = ?2').bind(now, p.id)];
    if (!p.bulk_exempt) {
      statements.push(
        db.prepare("DELETE FROM item_search WHERE rowid IN (SELECT seq FROM items WHERE publisher_id = ?1 AND status = 'public')").bind(p.id),
        db
          .prepare(
            `UPDATE items SET status = 'listed', listed_reasons = json_insert(listed_reasons, '$[#]', 'bulk_publisher'), updated_at = ?1
              WHERE publisher_id = ?2 AND status = 'public'`,
          )
          .bind(now, p.id),
      );
    }
    await db.batch(statements);
  }
  return bulk;
}

/**
 * Look again at servers whose packages could not be checked (npm or PyPI did
 * not answer): pin them now, and put each server where it belongs. A batch at
 * a time, in item order after `after`, so ones that still fail do not hold
 * up the rest.
 */
export async function recheckPackages(env: Env, limit = 200, after = 0): Promise<{ count: number; last: number }> {
  const db = env.HARNESS_DB;
  const { results } = await db
    .prepare(
      `SELECT i.seq, i.id, i.status, i.risk, i.listed_reasons, v.id AS version_id, v.metadata, v.packages
         FROM items i JOIN item_versions v ON v.id = i.latest_version_id
        WHERE i.seq > ?1 AND i.status = 'listed' AND i.kind = 'mcp' AND i.listed_reasons LIKE '%package_unverified%'
        ORDER BY i.seq LIMIT ?2`,
    )
    .bind(after, limit)
    .all<{ seq: number; id: string; status: ItemStatus; risk: Risk; listed_reasons: string; version_id: string; metadata: string; packages: string }>();
  const now = new Date().toISOString();
  const groups: D1PreparedStatement[][] = [];
  const docs = await docsFor(db, results.map((r) => r.id));
  for (const r of results) {
    const pinned = await pinPackages(db, JSON.parse(r.packages) as PinnedPackage[]);
    const reasons = (JSON.parse(r.listed_reasons) as string[]).filter((x) => x !== 'package_unverified' && x !== 'package_missing');
    if (pinned.some((p) => p.verified === 'missing')) reasons.push('package_missing');
    if (pinned.some((p) => p.verified === 'pending')) reasons.push('package_unverified');
    const status = decideStatus(r.status, r.risk, reasons);
    // only if the server is still where it was read: a newer version or another change wins
    groups.push([
      db
        .prepare('UPDATE item_versions SET packages = ?1, permissions = ?2 WHERE id = ?3')
        .bind(JSON.stringify(pinned), JSON.stringify(serverPermissions(JSON.parse(r.metadata) as ServerJson, pinned)), r.version_id),
      db
        .prepare(
          `UPDATE items SET listed_reasons = ?1, status = ?2, updated_at = ?3,
                  published_at = COALESCE(published_at, CASE WHEN ?2 = 'public' THEN version_at END)
            WHERE id = ?4 AND latest_version_id = ?5 AND status = ?6 AND listed_reasons = ?7`,
        )
        .bind(JSON.stringify(reasons), status, now, r.id, r.version_id, r.status, r.listed_reasons),
      ...searchStatements(db, r.id, r.version_id, docs.get(r.id)?.doc ?? null),
    ]);
  }
  await runGroups(db, groups);
  return { count: results.length, last: results[results.length - 1]?.seq ?? after };
}
