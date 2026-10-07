import { uuidv7 } from '../ids';
import type { PackageFile } from './files';
import type { Checks, ItemStatus, PromptMeta, Risk, Showcase } from './model';
import { promptFileOf } from './prompt';
import { riskOf, scanStructure } from './scan/content';
import { applyRules, loadRules } from './scan/rules';
import { docsFor, searchStatements } from './search';
import { decideStatus, runGroups } from './store';

/**
 * Check items again when the rules change (docs: section 7): every latest
 * version checked with an older rule set is read again (its files from R2,
 * or from GitHub at its commit when they are not kept here), and its risk
 * and its item's place follow. A batch at a time, in item order after
 * `after`; an item that cannot be read now is skipped until the next pass.
 * Returns how many items the batch held and the last one's position.
 */
export async function rescan(env: Env, limit = 50, after = 0): Promise<{ count: number; last: number }> {
  const db = env.HARNESS_DB;
  const { rules, hash } = await loadRules(db);
  const { results } = await db
    .prepare(
      `SELECT i.seq, i.id, i.kind, i.status, i.risk, i.listed_reasons, v.id AS version_id, v.hosted, v.source_commit, v.metadata, v.checks
         FROM items i JOIN item_versions v ON v.id = i.latest_version_id
        WHERE i.seq > ?1 AND i.status NOT IN ('retired', 'removed') AND json_extract(v.checks, '$.rules') IS NOT ?2
        ORDER BY i.seq LIMIT ?3`,
    )
    .bind(after, hash, limit)
    .all<{ seq: number; id: string; kind: string; status: ItemStatus; risk: Risk; listed_reasons: string; version_id: string; hosted: number; source_commit: string | null; metadata: string; checks: string }>();

  const now = new Date().toISOString();
  const groups: D1PreparedStatement[][] = [];
  const docs = await docsFor(db, results.map((r) => r.id));
  for (const r of results) {
    let files: PackageFile[];
    try {
      files = await filesOf(env, r);
    } catch (err) {
      console.warn(`[harness] rescan: item ${r.id} skipped this time`, String(err));
      continue;
    }
    const checks = JSON.parse(r.checks) as Checks;
    // structural checks only make sense on a package's files; a registry entry is one server.json
    const findings = [...(r.kind === 'mcp' ? [] : scanStructure(files)), ...applyRules(rules, files)];
    const risk = riskOf(findings);
    const status = decideStatus(r.status, risk, JSON.parse(r.listed_reasons) as string[]);
    // The version's own checks always; the item only if it is still where it was read:
    // a newer version, or another change made meanwhile, wins. The search row follows the item.
    const group = [
      db.prepare('UPDATE item_versions SET checks = ?1, risk = ?2 WHERE id = ?3').bind(JSON.stringify({ ...checks, findings, rules: hash, checkedAt: now }), risk, r.version_id),
      db
        .prepare(
          `UPDATE items SET risk = ?1, status = ?2, updated_at = ?3,
                  published_at = COALESCE(published_at, CASE WHEN ?2 = 'public' THEN version_at END)
            WHERE id = ?4 AND latest_version_id = ?5 AND status = ?6`,
        )
        .bind(risk, status, now, r.id, r.version_id, r.status),
    ];
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
  return { count: results.length, last: results[results.length - 1]?.seq ?? after };
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
