import { filesToReadFirst, pluginSpecs, type PluginSpec } from '../plugin';
import { gh, rawFile } from './github';

/**
 * Labels and dates for versions saved before plugins (docs/harness-plugins.md,
 * section 5): each version of a GitHub source without a version label gets
 * the one its commit's plugin manifest gave (the plugin that holds it, first
 * in its marketplace), else the tag on that commit; and every version gets the
 * time its commit was made. Only empty fields are filled: no new revision, no
 * file, hash or status changes, and neither is part of what /resolve hashes.
 *
 * A pass over the source's commits, a few at a time, in commit order: the
 * last commit done while there are more (the job carries on after it), else null.
 */

const COMMITS_PER_JOB = 8;

interface VersionRow {
  id: string;
  version: string | null;
  committed_at: string | null;
  metadata: string;
  kind: string;
}

const versionOf = (text: string | null): string | null => {
  try {
    const v = text ? (JSON.parse(text) as { version?: unknown }).version : null;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null;
  } catch {
    return null;
  }
};

/** A plugin's version at a commit, as its manifests give it: Claude Code's, Codex's, package.json, then its marketplace entry. */
async function specVersion(repo: string, sha: string, spec: PluginSpec): Promise<string | null> {
  for (const path of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
    const v = versionOf(await rawFile(repo, sha, spec.root ? `${spec.root}/${path}` : path));
    if (v) return v;
  }
  const own = spec.entry?.version;
  return typeof own === 'string' && own.trim() ? own.trim().slice(0, 64) : null;
}

export async function backfillVersions(env: Env, sourceId: string, after = ''): Promise<string | null> {
  const db = env.HARNESS_DB;
  const source = await db.prepare("SELECT url FROM import_sources WHERE id = ?1 AND kind = 'github'").bind(sourceId).first<{ url: string }>();
  if (!source) return null;
  const repo = source.url.replace(/^https:\/\/github\.com\//, '');
  const prefix = `${sourceId}:`;
  const { results: commits } = await db
    .prepare(
      `SELECT DISTINCT v.source_commit AS sha FROM item_versions v JOIN items i ON i.id = v.item_id
        WHERE i.source_key >= ?1 AND i.source_key < ?2 AND v.source_commit IS NOT NULL AND v.source_commit > ?3
          AND v.status != 'staged' AND (v.version IS NULL OR v.committed_at IS NULL)
        ORDER BY v.source_commit LIMIT ?4`,
    )
    .bind(prefix, `${prefix}\u{10FFFF}`, after, COMMITS_PER_JOB + 1)
    .all<{ sha: string }>();
  const tags = (await gh<{ name: string; commit: { sha: string } }[]>(env, `/repos/${repo}/tags?per_page=100`).catch(() => [])) ?? [];

  for (const { sha } of commits.slice(0, COMMITS_PER_JOB)) {
    const { results: rows } = await db
      .prepare(
        `SELECT v.id, v.version, v.committed_at, v.metadata, i.kind FROM item_versions v JOIN items i ON i.id = v.item_id
          WHERE i.source_key >= ?1 AND i.source_key < ?2 AND v.source_commit = ?3 AND v.status != 'staged'
            AND (v.version IS NULL OR v.committed_at IS NULL)`,
      )
      .bind(prefix, `${prefix}\u{10FFFF}`, sha)
      .all<VersionRow>();
    if (!rows.length) continue;
    const at = await gh<{ commit: { committer?: { date?: string } } }>(env, `/repos/${repo}/commits/${sha}`).catch(() => null);
    const date = at?.commit.committer?.date ?? null;

    // the plugins at that commit, and each one's version, read only for those that hold a version to label
    const needLabel = rows.filter((r) => !r.version && r.kind !== 'plugin');
    const labels = new Map<string, string | null>();
    if (needLabel.length) {
      const tree = await gh<{ tree: { path: string; type: string }[] }>(env, `/repos/${repo}/git/trees/${sha}?recursive=1`).catch(() => null);
      const paths = new Set((tree?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path));
      const first = new Map<string, string>();
      for (const p of filesToReadFirst(paths)) {
        const text = await rawFile(repo, sha, p).catch(() => null);
        if (text !== null) first.set(p, text);
      }
      const { specs } = pluginSpecs(paths, first);
      const versions = new Map<PluginSpec, string | null>();
      const tag = tags.find((t) => t.commit.sha === sha)?.name.replace(/^v(?=\d)/i, '').slice(0, 64) ?? null;
      for (const r of needLabel) {
        const meta = JSON.parse(r.metadata) as { path?: string; file?: string };
        const path = r.kind === 'assistant' ? [meta.path, meta.file].filter(Boolean).join('/') : (meta.path ?? '');
        const spec = specs.find((s) => (s.skills ? s.skills.includes(path) : s.root === '' || path === s.root || path.startsWith(`${s.root}/`)));
        let label: string | null = null;
        if (spec) {
          if (!versions.has(spec)) versions.set(spec, await specVersion(repo, sha, spec).catch(() => null));
          label = versions.get(spec) ?? null;
        }
        labels.set(r.id, label ?? tag);
      }
    }

    const statements = rows.map((r) =>
      db
        .prepare('UPDATE item_versions SET version = COALESCE(version, ?1), committed_at = COALESCE(committed_at, ?2) WHERE id = ?3')
        .bind(labels.get(r.id) ?? null, date, r.id),
    );
    for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  }
  return commits.length > COMMITS_PER_JOB ? commits[COMMITS_PER_JOB - 1].sha : null;
}
