import { uuidv7 } from '../ids';
import { importRepo, type RepoConfig } from './importers/github';
import { refreshAvatars } from './importers/avatars';
import { fetchMedia, MEDIA_BATCH } from './importers/media';
import { importPrompts, type PromptSourceConfig } from './importers/prompts';
import { importRegistryPage, recheckPackages } from './importers/registry';
import { refreshStars } from './importers/stars';
import { rescan } from './rescan';
import { recountFacets, repairIndex } from './search';

/**
 * Harness's background work, as messages on the harness-jobs queue (one per
 * invocation, two at a time; wrangler.jsonc). Imports run as chains of jobs,
 * each a small step that queues the next, with their progress kept in
 * import_sources: a sync that dies is picked up where it stopped once its
 * lease runs out, so nothing is left "running" for ever.
 */
export type Job =
  | { type: 'registry.page'; run: string; cursor: string | null }
  | { type: 'github.repo'; source: string; force?: boolean; part?: number }
  | { type: 'stars' }
  | { type: 'packages'; after?: number }
  | { type: 'rescan'; after?: number }
  | { type: 'facets' }
  | { type: 'avatars'; after?: string }
  | { type: 'media' };

/** How long a running sync may go without progress before it is presumed dead. */
const LEASE_MS = 30 * 60 * 1000;

interface SyncState {
  run: string;
  /** when this sync began: the next one asks for changes since then */
  startedAt: string;
  since: string | null;
  pages: number;
  seen: number;
  created: number;
  updated: number;
  retired: number;
}

interface SourceRow {
  id: string;
  url: string;
  config: string;
  enabled: number;
  state: 'idle' | 'running';
  lease_until: string | null;
  cursor: string | null;
  synced_at: string | null;
  synced_ref: string | null;
  stats: string | null;
}

const source = (db: D1Database, id: string) => db.prepare('SELECT * FROM import_sources WHERE id = ?1').bind(id).first<SourceRow>();

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case 'registry.page':
      return registryPage(env, job);
    case 'github.repo':
      return githubRepo(env, job.source, !!job.force, job.part ?? 1);
    case 'stars': {
      const limit = 2000;
      const n = await refreshStars(env, limit);
      if (n >= limit) await env.HARNESS_JOBS.send({ type: 'stars' } satisfies Job);
      return;
    }
    case 'packages': {
      // servers whose packages npm or PyPI could not be asked about; a full batch means there may be more after it
      const limit = 200;
      const { count, last } = await recheckPackages(env, limit, job.after ?? 0);
      if (count >= limit) await env.HARNESS_JOBS.send({ type: 'packages', after: last } satisfies Job);
      return;
    }
    case 'rescan': {
      // versions checked with older rules, in item order; a full batch means there may be more after it
      const limit = 50;
      const { count, last } = await rescan(env, limit, job.after ?? 0);
      if (count >= limit) await env.HARNESS_JOBS.send({ type: 'rescan', after: last } satisfies Job);
      return;
    }
    case 'avatars': {
      // publishers' pictures, a batch at a time, in id order; the next batch follows while there is one
      const next = await refreshAvatars(env, job.after ?? '');
      if (next) await env.HARNESS_JOBS.send({ type: 'avatars', after: next } satisfies Job);
      return;
    }
    case 'media': {
      // pictures of items' results, a batch at a time; a full batch means there may be more
      const n = await fetchMedia(env);
      if (n >= MEDIA_BATCH) await env.HARNESS_JOBS.send({ type: 'media' } satisfies Job);
      return;
    }
    case 'facets': {
      // the search index is kept in step as items change; this mends anything that slipped, then counts
      const fixed = await repairIndex(env.HARNESS_DB);
      if (fixed) console.warn(`[harness] search index: ${fixed} rows mended`);
      return recountFacets(env.HARNESS_DB);
    }
  }
}

/**
 * Hourly: start a registry sync, unless one is under way. The first sync is
 * full; later ones ask for changes since the last one began (with a few
 * minutes' overlap). A sync whose lease ran out resumes from its last page.
 */
export async function startRegistrySync(env: Env): Promise<void> {
  const db = env.HARNESS_DB;
  const row = await source(db, 'mcp-registry');
  if (!row?.enabled) return;
  const now = new Date();
  if (row.state === 'running' && row.lease_until && row.lease_until > now.toISOString()) return;

  let state: SyncState;
  let cursor: string | null = null;
  const previous = row.stats ? (JSON.parse(row.stats) as Partial<SyncState>) : null;
  if (row.state === 'running' && previous?.run && previous.startedAt) {
    state = previous as SyncState; // resume the stalled run where it stopped
    cursor = row.cursor;
    console.warn(`[harness] registry sync ${state.run} stalled after ${state.pages} pages; resuming`);
  } else {
    const since = row.synced_at ? new Date(Date.parse(row.synced_at) - 10 * 60 * 1000).toISOString() : null;
    state = { run: uuidv7(), startedAt: now.toISOString(), since, pages: 0, seen: 0, created: 0, updated: 0, retired: 0 };
  }
  await db
    .prepare("UPDATE import_sources SET state = 'running', lease_until = ?1, cursor = ?2, stats = ?3, updated_at = ?4 WHERE id = 'mcp-registry'")
    .bind(new Date(now.getTime() + LEASE_MS).toISOString(), cursor, JSON.stringify(state), now.toISOString())
    .run();
  await env.HARNESS_JOBS.send({ type: 'registry.page', run: state.run, cursor } satisfies Job);
}

async function registryPage(env: Env, job: Extract<Job, { type: 'registry.page' }>): Promise<void> {
  const db = env.HARNESS_DB;
  const row = await source(db, 'mcp-registry');
  const state = row?.stats ? (JSON.parse(row.stats) as SyncState) : null;
  // a page from a run that has since been replaced (or a repeated delivery of an older page)
  if (!row || row.state !== 'running' || state?.run !== job.run || row.cursor !== job.cursor) return;

  const page = await importRegistryPage(env, job.cursor, state.since);
  const now = new Date();
  state.pages++;
  state.seen += page.seen;
  state.created += page.created;
  state.updated += page.updated;
  state.retired += page.retired;

  // Move the sync on only if it is still where this job found it: when the same page ran twice
  // (a redelivery beside a resumed run), one copy advances and queues the next page, the other stops.
  const still = (cursor: number, run: number) => `id = 'mcp-registry' AND state = 'running' AND cursor IS ?${cursor} AND json_extract(stats, '$.run') = ?${run}`;
  if (page.next && page.seen > 0) {
    const moved = await db
      .prepare(`UPDATE import_sources SET cursor = ?1, lease_until = ?2, stats = ?3, last_error = NULL, updated_at = ?4 WHERE ${still(5, 6)}`)
      .bind(page.next, new Date(now.getTime() + LEASE_MS).toISOString(), JSON.stringify(state), now.toISOString(), job.cursor, state.run)
      .run();
    if (moved.meta.changes === 1) await env.HARNESS_JOBS.send({ type: 'registry.page', run: state.run, cursor: page.next } satisfies Job);
    return;
  }
  const done = await db
    .prepare(
      `UPDATE import_sources SET state = 'idle', lease_until = NULL, cursor = NULL, synced_at = ?1, stats = ?2, last_error = NULL, updated_at = ?3
        WHERE ${still(4, 5)}`,
    )
    .bind(state.startedAt, JSON.stringify(state), now.toISOString(), job.cursor, state.run)
    .run();
  if (done.meta.changes !== 1) return;
  console.info(`[harness] registry sync ${state.run}: ${state.pages} pages, ${state.seen} servers, ${state.created} new, ${state.updated} updated, ${state.retired} retired`);
  await env.HARNESS_JOBS.sendBatch([{ body: { type: 'packages' } satisfies Job }, { body: { type: 'stars' } satisfies Job }, { body: { type: 'facets' } satisfies Job }]);
}

/**
 * How long one job may spend saving a repository's skills. A job may run 15
 * minutes; a big repository (hundreds of skills) takes several jobs, each
 * starting where the last stopped (what it saved is unchanged by then), up
 * to PARTS of them.
 */
const SAVE_MS = 7 * 60 * 1000;
const PARTS = 20;

async function githubRepo(env: Env, id: string, force: boolean, part: number): Promise<void> {
  const db = env.HARNESS_DB;
  const row = await source(db, id);
  if (!row?.enabled) return;
  const now = new Date().toISOString();
  try {
    const fullName = row.url.replace(/^https:\/\/github\.com\//, '');
    // a repository of skills, or a collection of prompts (its config says which)
    const config = JSON.parse(row.config) as RepoConfig | PromptSourceConfig;
    const prompts = 'kind' in config && config.kind === 'prompt';
    const result = prompts
      ? await importPrompts(env, fullName, config, row.synced_ref, force, Date.now() + SAVE_MS)
      : await importRepo(env, fullName, config as RepoConfig, row.synced_ref, force, Date.now() + SAVE_MS);
    if (result.remaining) {
      // not finished: the commit is not marked as imported, so the next job carries on with it
      const left = `${result.remaining} of ${result.skills} ${prompts ? 'prompts' : 'skills'} left after part ${part}`;
      await db
        .prepare('UPDATE import_sources SET stats = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4')
        .bind(JSON.stringify(result), part < PARTS ? null : `stopped: ${left}`, now, id)
        .run();
      console.info(`[harness] ${fullName}@${result.commit.slice(0, 7)}: ${result.created} new, ${result.updated} updated, ${left}`);
      if (part < PARTS) await env.HARNESS_JOBS.send({ type: 'github.repo', source: id, force, part: part + 1 } satisfies Job);
      return;
    }
    await db
      .prepare('UPDATE import_sources SET synced_ref = ?1, synced_at = ?2, stats = ?3, last_error = NULL, updated_at = ?2 WHERE id = ?4')
      .bind(result.commit, now, JSON.stringify(result), id)
      .run();
    if (result.changed) {
      console.info(
        `[harness] ${fullName}@${result.commit.slice(0, 7)}: ${result.skills} ${prompts ? 'prompts' : 'skills'}, ${result.created} new, ${result.updated} updated, ${result.retired} retired, ${result.rejected.length} rejected`,
      );
      await env.HARNESS_JOBS.send({ type: 'facets' } satisfies Job);
      // the pictures it named, for the cards
      if (prompts) await env.HARNESS_JOBS.send({ type: 'media' } satisfies Job);
    }
  } catch (err) {
    await db.prepare('UPDATE import_sources SET last_error = ?1, updated_at = ?2 WHERE id = ?3').bind(String(err).slice(0, 500), now, id).run();
    throw err;
  }
}

/**
 * Daily: look at every skill repository and prompt collection for a new
 * commit, retry package lookups that failed, check again what older rules
 * checked, fill in missing stars, recount the facets, look for publishers'
 * pictures not looked for in 30 days, and for results' pictures due again.
 */
export async function daily(env: Env): Promise<void> {
  const { results } = await env.HARNESS_DB.prepare("SELECT id FROM import_sources WHERE kind = 'github' AND enabled = 1").all<{ id: string }>();
  const jobs: Job[] = [
    ...results.map((r) => ({ type: 'github.repo', source: r.id }) as Job),
    { type: 'packages' },
    { type: 'rescan' },
    { type: 'stars' },
    { type: 'facets' },
    { type: 'avatars' },
    { type: 'media' },
  ];
  for (let i = 0; i < jobs.length; i += 100) await env.HARNESS_JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
}
