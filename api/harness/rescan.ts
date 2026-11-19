import { uuidv7 } from '../ids';
import { assistantFindings } from './assistant';
import type { PackageFile } from './files';
import type { AssistantMeta, Checks, ItemStatus, PromptMeta, Risk, Showcase } from './model';
import { pluginFindings, type PluginDescriptor } from './plugin';
import { promptFileOf } from './prompt';
import { riskOf, scanStructure, type Finding } from './scan/content';
import { applyRules, loadRules, type Rule } from './scan/rules';
import { docsFor, searchStatements } from './search';
import { decideStatus, runGroups } from './store';

/** What rescanning a version reads of it and its item. */
export interface RescanRow {
  seq: number;
  id: string;
  kind: string;
  status: ItemStatus;
  risk: Risk;
  listed_reasons: string;
  covered_by: string | null;
  source_key: string | null;
  version_id: string;
  hosted: number;
  source_commit: string | null;
  metadata: string;
  checks: string;
}

/** A version's findings by today's rules, from its files (null when they cannot be read now). */
export async function recheck(env: Env, r: RescanRow, rules: Rule[]): Promise<{ findings: Finding[]; risk: Risk } | null> {
  let files: PackageFile[];
  try {
    files = await filesOf(env, r);
  } catch (err) {
    console.warn(`[harness] rescan: item ${r.id} skipped this time`, String(err));
    return null;
  }
  // structural checks only make sense on a package's files (a registry entry is one server.json); an
  // assistant's file is instructions whatever it is called, and its frontmatter has checks of its own;
  // a plugin's rules run unscoped on what it runs on its own
  const meta = JSON.parse(r.metadata) as { assistant?: AssistantMeta; plugin?: PluginDescriptor };
  const findings =
    r.kind === 'plugin' && meta.plugin
      ? pluginFindings(files, meta.plugin, rules)
      : [
          ...(r.kind === 'mcp' ? [] : scanStructure(files, { instructions: r.kind === 'assistant' })),
          ...applyRules(rules, files),
          ...(meta.assistant ? assistantFindings(meta.assistant) : []),
        ];
  return { findings, risk: riskOf(findings) };
}

/** The import source of an item, by its source key ('github:owner/repo:…' → 'github:owner/repo'). */
export const sourceOfKey = (key: string | null) => (key && key.startsWith('github:') ? key.split(':').slice(0, 2).join(':') : null);

/**
 * Check items again when the rules change (docs: section 7): every latest
 * version checked with an older rule set is read again (its files from R2,
 * or from GitHub at its commit when they are not kept here), and its risk
 * and its item's place follow. A batch at a time, in item order after
 * `after`; an item that cannot be read now is skipped until the next pass.
 * Returns how many items the batch held and the last one's position.
 *
 * Plugins and their members are not moved here (docs/harness-plugins.md,
 * section 4): a member's version gets its new checks and stays deleted; a
 * plugin whose place would change has its source reconciled, which moves it
 * and its members together. A member gone from its repository is not read.
 */
export async function rescan(env: Env, limit = 50, after = 0): Promise<{ count: number; last: number }> {
  const db = env.HARNESS_DB;
  const { rules, hash } = await loadRules(db);
  const { results } = await db
    .prepare(
      `SELECT i.seq, i.id, i.kind, i.status, i.risk, i.listed_reasons, i.covered_by, i.source_key, v.id AS version_id, v.hosted, v.source_commit, v.metadata, v.checks
         FROM items i JOIN item_versions v ON v.id = i.latest_version_id
        WHERE i.seq > ?1 AND i.status NOT IN ('retired', 'removed', 'draft') AND NOT (i.status = 'deleted' AND i.covered_by IS NULL)
          AND json_extract(v.checks, '$.rules') IS NOT ?2
        ORDER BY i.seq LIMIT ?3`,
    )
    .bind(after, hash, limit)
    .all<RescanRow>();

  const now = new Date().toISOString();
  const groups: D1PreparedStatement[][] = [];
  const docs = await docsFor(db, results.map((r) => r.id));
  const reconcile = new Set<string>();
  for (const r of results) {
    const fresh = await recheck(env, r, rules);
    if (!fresh) continue;
    const { findings, risk } = fresh;
    const checks = JSON.parse(r.checks) as Checks;
    const status = decideStatus(r.status, risk, JSON.parse(r.listed_reasons) as string[]);
    const group = [db.prepare('UPDATE item_versions SET checks = ?1, risk = ?2 WHERE id = ?3').bind(JSON.stringify({ ...checks, findings, rules: hash, checkedAt: now }), risk, r.version_id)];
    if (r.status === 'deleted') {
      // a member: its checks, for the day it comes back; where it stands is the reconcile's
      groups.push(group);
      continue;
    }
    if (r.kind === 'plugin') {
      group.push(db.prepare('UPDATE items SET risk = ?1, updated_at = ?2 WHERE id = ?3 AND latest_version_id = ?4').bind(risk, now, r.id, r.version_id));
      groups.push(group);
      if (status !== r.status) {
        const source = sourceOfKey(r.source_key);
        if (source) reconcile.add(source);
      }
      continue;
    }
    // The version's own checks always; the item only if it is still where it was read:
    // a newer version, or another change made meanwhile, wins. The search row follows the item.
    group.push(
      db
        .prepare(
          `UPDATE items SET risk = ?1, status = ?2, updated_at = ?3,
                  published_at = COALESCE(published_at, CASE WHEN ?2 = 'public' THEN version_at END)
            WHERE id = ?4 AND latest_version_id = ?5 AND status = ?6`,
        )
        .bind(risk, status, now, r.id, r.version_id, r.status),
    );
    if (status !== r.status) {
      group.push(
        db
          .prepare(
            `INSERT INTO moderation_events (id, item_id, version_id, actor, action, reason, data, created_at)
             SELECT ?1, ?2, ?3, 'system', 'status', 'rules changed', ?4, ?5 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?2 AND latest_version_id = ?3 AND status = ?6)`,
          )
          .bind(uuidv7(), r.id, r.version_id, JSON.stringify({ from: r.status, to: status }), now, status),
      );
    }
    group.push(...searchStatements(db, r.id, r.version_id, docs.get(r.id)?.doc ?? null));
    groups.push(group);
  }
  await runGroups(db, groups);
  for (const source of reconcile) await env.HARNESS_JOBS.send({ type: 'github.reconcile', source });
  return { count: results.length, last: results[results.length - 1]?.seq ?? after };
}

/**
 * Bring these versions' checks up to today's rules where they were made with
 * older ones, before their items come back on the shelves (the reconcile).
 * Returns each one's risk and checks as they now stand; one that cannot be
 * read now is left out.
 */
export async function freshChecks(env: Env, rows: RescanRow[]): Promise<Map<string, { risk: Risk; checks: Checks }>> {
  const db = env.HARNESS_DB;
  const { rules, hash } = await loadRules(db);
  const out = new Map<string, { risk: Risk; checks: Checks }>();
  const now = new Date().toISOString();
  const writes: D1PreparedStatement[][] = [];
  for (const r of rows) {
    const checks = JSON.parse(r.checks) as Checks;
    if (checks.rules === hash) {
      out.set(r.version_id, { risk: r.risk, checks });
      continue;
    }
    const fresh = await recheck(env, r, rules);
    if (!fresh) continue;
    const next = { ...checks, findings: fresh.findings, rules: hash, checkedAt: now };
    out.set(r.version_id, { risk: fresh.risk, checks: next });
    writes.push([db.prepare('UPDATE item_versions SET checks = ?1, risk = ?2 WHERE id = ?3').bind(JSON.stringify(next), fresh.risk, r.version_id)]);
  }
  await runGroups(db, writes);
  return out;
}

async function filesOf(env: Env, r: { kind: string; version_id: string; hosted: number; source_commit: string | null; metadata: string }): Promise<PackageFile[]> {
  if (r.kind === 'mcp') {
    // as it was checked when imported (with any credential already redacted)
    return [{ path: 'server.json', data: new TextEncoder().encode(JSON.stringify(JSON.parse(r.metadata), null, 2)), executable: false }];
  }
  if (r.kind === 'prompt') {
    // PROMPT.md is written from the collection's entry, not read from the repository: written again the same way
    const meta = JSON.parse(r.metadata) as { prompt?: PromptMeta; showcases?: Showcase[] };
    if (!meta.prompt) throw new Error(`version ${r.version_id} has no prompt`);
    return [{ path: 'PROMPT.md', data: new TextEncoder().encode(promptFileOf(meta.prompt, meta.showcases ?? [])), executable: false }];
  }
  const { results } = await env.HARNESS_DB.prepare('SELECT path, sha256, executable FROM version_files WHERE version_id = ?1')
    .bind(r.version_id)
    .all<{ path: string; sha256: string; executable: number }>();
  const meta = JSON.parse(r.metadata) as { repository?: string; path?: string };
  const files: PackageFile[] = [];
  for (const f of results) {
    let data: Uint8Array;
    if (r.hosted) {
      const object = await env.HARNESS_FILES.get(`blobs/${f.sha256}`);
      if (!object) throw new Error(`blob ${f.sha256} missing`);
      data = new Uint8Array(await object.arrayBuffer());
    } else {
      // not kept here: read it again from GitHub, at the same commit
      if (!meta.repository || !r.source_commit) throw new Error(`version ${r.version_id} has no source to read`);
      const path = [meta.path, f.path].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`https://raw.githubusercontent.com/${meta.repository}/${r.source_commit}/${path}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GitHub raw ${res.status} for ${f.path}`);
      data = new Uint8Array(await res.arrayBuffer());
    }
    files.push({ path: f.path, data, executable: !!f.executable });
  }
  return files;
}
