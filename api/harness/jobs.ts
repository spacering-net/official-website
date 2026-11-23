import { uuidv7 } from '../ids';
import { backfillVersions } from './importers/backfill';
import { importRepo, type RepoConfig, type RepoResult } from './importers/github';
import { refreshAvatars } from './importers/avatars';
import { fetchMedia, MEDIA_BATCH } from './importers/media';
import { importPrompts, type PromptSourceConfig } from './importers/prompts';
import { importRegistryPage, recheckPackages } from './importers/registry';
import { refreshStars } from './importers/stars';
import { reconcile } from './reconcile';
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
  | { type: 'github.repo'; source: string; force?: boolean; part?: number; pin?: boolean; attempt?: number }
  /** make a source's last complete import current: its plugins, and where their members are (reconcile.ts) */
  | { type: 'github.reconcile'; source: string; run?: string; attempt?: number }
  /** fill in versions' labels and commit dates from their commits (importers/backfill.ts) */
  | { type: 'github.backfill'; source: string; after?: string }
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
  staged_run: string | null;
}

const source = (db: D1Database, id: string) => db.prepare('SELECT * FROM import_sources WHERE id = ?1').bind(id).first<SourceRow>();

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case 'registry.page':
      return registryPage(env, job);
    case 'github.repo':
      return githubRepo(env, job);
    case 'github.reconcile': {
      const r = await reconcile(env, job.source, job.run);
      if (r.status === 'busy' && (job.attempt ?? 0) < 10) {
        // another reconcile holds the source: this one comes again after it
        await env.HARNESS_JOBS.send({ ...job, attempt: (job.attempt ?? 0) + 1 } satisfies Job, { delaySeconds: 60 });
        return;
      }
      if (r.skipped.length) console.warn(`[harness] reconcile ${job.source}: left as they were: ${r.skipped.join(', ')}`);
      // when it ended and under which switch: what the plugin switch (scripts/harness-plugins.mjs) waits for
      const mark = { at: new Date().toISOString(), plugins: env.HARNESS_PLUGINS === 'on' ? 'on' : 'off', status: r.status, skipped: r.skipped };
      await env.HARNESS_DB.prepare("UPDATE import_sources SET stats = json_set(COALESCE(stats, '{}'), '$.reconciled', json(?1)) WHERE id = ?2")
        .bind(JSON.stringify(mark), job.source)
        .run();
      if (r.changed) {
        console.info(`[harness] reconcile ${job.source}: ${r.changed} items moved`);
        await env.HARNESS_JOBS.send({ type: 'facets' } satisfies Job);
      }
      return;
    }
    case 'github.backfill': {
      const next = await backfillVersions(env, job.source, job.after ?? '');
      if (next) await env.HARNESS_JOBS.send({ type: 'github.backfill', source: job.source, after: next } satisfies Job);
      return;
    }
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

/** Complete imports kept per source (import_runs): the reconcile reads the last. */
const RUNS_KEPT = 5;

/**
 * How long an import holds its source. An import and a reconcile of the same source never run at once
 * (reconcile.ts takes the same lease): a save that read an item before a reconcile moved it, or a
 * sweep that read a member before a reconcile took it, would otherwise undo the move.
 */
const IMPORT_LEASE_MS = 20 * 60 * 1000;

async function githubRepo(env: Env, job: Extract<Job, { type: 'github.repo' }>): Promise<void> {
  const { source: id } = job;
  const force = !!job.force;
  const part = job.part ?? 1;
  const pin = !!job.pin;
  const db = env.HARNESS_DB;
  const row = await source(db, id);
  if (!row?.enabled) return;
  const now = new Date().toISOString();
  const lease = uuidv7();
  const took = await db
    .prepare('UPDATE import_sources SET lease = ?1, lease_until = ?2 WHERE id = ?3 AND (lease IS NULL OR lease_until IS NULL OR lease_until < ?4)')
    .bind(lease, new Date(Date.now() + IMPORT_LEASE_MS).toISOString(), id, now)
    .run();
  if (took.meta.changes !== 1) {
    // a reconcile (or another import) holds the source: this one comes again after it
    if ((job.attempt ?? 0) < 20) await env.HARNESS_JOBS.send({ ...job, attempt: (job.attempt ?? 0) + 1 } satisfies Job, { delaySeconds: 60 });
    return;
  }
  const then: Job[] = [];
  try {
    await importHeld(env, row, id, force, part, pin, now, then);
  } finally {
    await db.prepare('UPDATE import_sources SET lease = NULL, lease_until = NULL WHERE id = ?1 AND lease = ?2').bind(id, lease).run();
  }
  for (const next of then) await env.HARNESS_JOBS.send(next);
}

/** The import itself, with the source held; the jobs it leads to are queued once the source is let go (`then`). */
async function importHeld(env: Env, row: SourceRow, id: string, force: boolean, part: number, pin: boolean, now: string, then: Job[]): Promise<void> {
  const db = env.HARNESS_DB;
  try {
    const fullName = row.url.replace(/^https:\/\/github\.com\//, '');
    // a repository of skills, or a collection of prompts (its config says which)
    const config = JSON.parse(row.config) as RepoConfig | PromptSourceConfig;
    const prompts = 'kind' in config && config.kind === 'prompt';
    const lastTrack = (row.stats ? (JSON.parse(row.stats) as { track?: 'head' | 'release' }) : {}).track;
    const result = prompts
      ? await importPrompts(env, fullName, config, row.synced_ref, force, Date.now() + SAVE_MS)
      : await importRepo(env, fullName, config as RepoConfig, row.synced_ref, force, Date.now() + SAVE_MS, { lastTrack, pin, plugins: env.HARNESS_PLUGINS === 'on' });
    if (result.remaining) {
      // not finished: the commit is not marked as imported, so the next job carries on with it
      const left = `${result.remaining} of ${result.skills + (result.assistants ?? 0)} ${prompts ? 'prompts' : 'skills and assistants'} left after part ${part}`;
      await db
        .prepare('UPDATE import_sources SET stats = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4')
        .bind(JSON.stringify(result), part < PARTS ? null : `stopped: ${left}`, now, id)
        .run();
      console.info(`[harness] ${fullName}@${result.commit.slice(0, 7)}: ${result.created} new, ${result.updated} updated, ${left}`);
      if (part < PARTS) then.push({ type: 'github.repo', source: id, force, part: part + 1, pin } satisfies Job);
      return;
    }
    const run = 'run' in result ? (result as RepoResult).run : undefined;
    const stats = JSON.stringify({ ...result, run: undefined });
    if (run) {
      // a complete import: what the reconcile commits, recorded with the commit it marks imported
      const runId = uuidv7();
      await db.batch([
        db.prepare('INSERT INTO import_runs (run_id, source, "commit", completed_at, plugins) VALUES (?1, ?2, ?3, ?4, ?5)').bind(runId, id, result.commit, now, JSON.stringify(run)),
        db
          .prepare('UPDATE import_sources SET synced_ref = ?1, synced_at = ?2, stats = ?3, last_error = NULL, updated_at = ?2, staged_run = ?4 WHERE id = ?5')
          .bind(result.commit, now, stats, runId, id),
        db
          .prepare('DELETE FROM import_runs WHERE source = ?1 AND run_id NOT IN (SELECT run_id FROM import_runs WHERE source = ?1 ORDER BY completed_at DESC, run_id DESC LIMIT ?2)')
          .bind(id, RUNS_KEPT),
      ]);
      then.push({ type: 'github.reconcile', source: id, run: runId } satisfies Job);
    } else {
      await db
        .prepare('UPDATE import_sources SET synced_ref = ?1, synced_at = ?2, stats = ?3, last_error = NULL, updated_at = ?2 WHERE id = ?4')
        .bind(result.commit, now, stats, id)
        .run();
      // Nothing new: the last run is reconciled again (only the database is read). This catches what moved
      // since (a rescan, a publisher marked as bulk, an approval), and a reconcile that was never queued
      // (a send that failed after the run was recorded: the job was retried and found the commit imported).
      if (row.staged_run) then.push({ type: 'github.reconcile', source: id } satisfies Job);
    }
    if (result.changed) {
      console.info(
        `[harness] ${fullName}@${result.commit.slice(0, 7)}: ${result.skills} ${prompts ? 'prompts' : 'skills'}${result.assistants ? `, ${result.assistants} assistants` : ''}, ${result.created} new, ${result.updated} updated, ${result.retired} retired, ${result.rejected.length} rejected`,
      );
      then.push({ type: 'facets' } satisfies Job);
      // the pictures it named, for the cards
      if (prompts) then.push({ type: 'media' } satisfies Job);
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
