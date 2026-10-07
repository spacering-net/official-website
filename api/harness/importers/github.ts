import { asText, readTar, sha256, type PackageFile } from '../files';
import { licenseFromText, REDISTRIBUTABLE, spdx } from '../limits';
import { excerpt } from '../markdown';
import { listingOf, type Checks } from '../model';
import { normalizePackage, type RawFile } from '../package';
import { riskOf, scanStructure } from '../scan/content';
import { skillPermissions } from '../scan/permissions';
import { applyRules, loadRules } from '../scan/rules';
import { redactDeep, redactSecrets, scanSecrets } from '../scan/secrets';
import { parseSkill } from '../skill';
import { retireItems, saveVersions, type VersionInput } from '../store';
import { autoTags, loadTags } from '../tags';
import { clip, descriptionQuality, localize } from '../text';

/**
 * Skills from GitHub repositories (docs: section 12): a curated list to begin
 * with, each checked daily for a new commit. The commit's tarball is read
 * once; every folder with a SKILL.md becomes an item under the repository's
 * owner, unclaimed until they sign in. Files are kept only when the license
 * allows; otherwise only their list and hashes, and clients fetch them from
 * GitHub at the same commit.
 */

const API = 'https://api.github.com';
/** a repository's tarball, unpacked, may not be bigger than this */
const MAX_TARBALL = 200 * 1024 * 1024;
/** nor the skills in it, together */
const MAX_SKILLS_BYTES = 80 * 1024 * 1024;

export interface RepoConfig {
  /** only skills under these paths (default: anywhere in the repository) */
  paths?: string[];
  /**
   * also skills in hidden folders below those paths. Off by default: they are
   * usually copies made for one agent (.claude/skills, .codex/skills).
   */
  hidden?: boolean;
}

export interface RepoResult {
  commit: string;
  changed: boolean;
  skills: number;
  created: number;
  updated: number;
  retired: number;
  /** skills not saved before the deadline: the import is not finished */
  remaining: number;
  rejected: { path: string; errors: string[] }[];
}

function headers(env: Env): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'spacering.net-harness', 'X-GitHub-Api-Version': '2022-11-28' };
  // the token only ever goes to api.github.com (this function's callers)
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

export async function gh<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers(env), signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`GitHub ${path} answered ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Repo {
  full_name: string;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  archived: boolean;
  license: { spdx_id?: string | null } | null;
  owner: { id: number; login: string; type: string };
}

/**
 * Import one repository at its default branch's latest commit. Nothing is
 * done when that commit was imported already, unless `force`. Saving stops
 * at the deadline `until` (ms), if given: the rest is counted in `remaining`,
 * and skills gone from the repository are retired only once all are saved.
 */
export async function importRepo(
  env: Env,
  fullName: string,
  config: RepoConfig,
  lastCommit: string | null,
  force = false,
  until?: number,
): Promise<RepoResult> {
  const repo = await gh<Repo>(env, `/repos/${fullName}`);
  const commit = await gh<{ sha: string; commit: { committer?: { date?: string } } }>(env, `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`);
  const result: RepoResult = { commit: commit.sha, changed: false, skills: 0, created: 0, updated: 0, retired: 0, remaining: 0, rejected: [] };
  if (!force && commit.sha === lastCommit) return result;
  result.changed = true;

  // which folders are skills: the tree lists every path with its size, before anything is downloaded
  const tree = await gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(env, `/repos/${repo.full_name}/git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo.full_name}: tree too large to list`);
  const within = (p: string) =>
    (config.paths?.length ? config.paths : ['']).some((root) => {
      const r = root.replace(/\/$/, '');
      if (r && !p.startsWith(`${r}/`)) return false;
      const folders = (r ? p.slice(r.length + 1) : p).split('/').slice(0, -1);
      return config.hidden || !folders.some((f) => f.startsWith('.'));
    });
  const skillDirs = tree.tree
    .filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path) && within(e.path))
    .map((e) => e.path.replace(/\/?SKILL\.md$/, ''))
    // a skill inside another skill's folder is part of that skill
    .filter((d, _, all) => !all.some((o) => o !== d && (o === '' || d.startsWith(`${o}/`))))
    .sort();
  const dirOf = (path: string) => skillDirs.find((d) => d === '' || path === d || path.startsWith(`${d}/`));
  const bytes = tree.tree.filter((e) => e.type === 'blob' && dirOf(e.path) !== undefined).reduce((n, e) => n + (e.size ?? 0), 0);
  if (bytes > MAX_SKILLS_BYTES) throw new Error(`${repo.full_name}: skills too large (${bytes} bytes)`);

  // one download: the commit's tarball, keeping only files inside skill folders
  const raw = new Map<string, RawFile[]>(skillDirs.map((d) => [d, []]));
  const licenses = new Map<string, string>();
  if (skillDirs.length) {
    const res = await fetch(`https://codeload.github.com/${repo.full_name}/tar.gz/${commit.sha}`, {
      headers: { 'User-Agent': 'spacering.net-harness' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) throw new Error(`${repo.full_name}: tarball answered ${res.status}`);
    // paths in the tarball start with a folder named after the repository and commit
    const strip = (p: string) => p.slice(p.indexOf('/') + 1);
    await readTar(
      res.body.pipeThrough(new DecompressionStream('gzip')),
      (e) => {
        const path = strip(e.path);
        const dir = dirOf(path);
        if (dir === undefined) return false;
        if (e.type !== 'file' && e.type !== 'dir') raw.get(dir)!.push({ path: path.slice(dir ? dir.length + 1 : 0), data: new Uint8Array(), type: e.type });
        return e.type === 'file';
      },
      (e, data) => {
        const path = strip(e.path);
        const dir = dirOf(path)!;
        const rel = path.slice(dir ? dir.length + 1 : 0);
        raw.get(dir)!.push({ path: rel, data, executable: (e.mode & 0o111) !== 0, type: 'file' });
        if (/^LICEN[CS]E(\.(md|txt))?$/i.test(rel)) {
          const id = licenseFromText(asText(data) ?? '');
          if (id) licenses.set(dir, id);
        }
      },
      MAX_TARBALL,
    );
  }

  const db = env.HARNESS_DB;
  const [{ rules, hash }, tags] = await Promise.all([loadRules(db), loadTags(db)]);
  const repoLicense = spdx(repo.license?.spdx_id ?? null);
  const inputs: VersionInput[] = [];
  for (const dir of skillDirs) {
    const folder = dir ? dir.slice(dir.lastIndexOf('/') + 1) : repo.full_name.split('/')[1];
    const pkg = normalizePackage(raw.get(dir) ?? [], { stripWrapper: false });
    const skillFile = pkg.files.find((f) => f.path === 'SKILL.md');
    const parsed = skillFile ? parseSkill(asText(skillFile.data) ?? '', folder, { lenient: true }) : null;
    const errors = [...pkg.errors.map((e) => e.code), ...(parsed?.errors ?? ['skill_md_missing'])];
    if (!parsed?.meta || pkg.errors.length) {
      result.rejected.push({ path: dir || '.', errors });
      continue;
    }
    const meta = parsed.meta;
    // the skill's own license (frontmatter, then a license file beside it), else the repository's;
    // a license we cannot name (often "proprietary, see LICENSE.txt") is shown as written, and the files are not kept
    const licenseId = spdx(meta.license) ?? licenses.get(dir) ?? (meta.license ? null : repoLicense);
    const license = licenseId ?? (meta.license ? clip(meta.license, 64) : null);
    const secrets = pkg.files.flatMap((f) => {
      const text = asText(f.data);
      return text === null ? [] : scanSecrets(f.path, text);
    });
    // a package with an author's credentials in it is not copied here at all (docs: section 6),
    // and the little that is shown of it has them taken out
    const hosted = !!licenseId && REDISTRIBUTABLE.has(licenseId) && !secrets.length;
    const clean = (text: string) => (secrets.length ? redactSecrets(text) : text);
    const findings = [...scanStructure(pkg.files), ...applyRules(rules, pkg.files)];
    const description = clean(meta.description);
    const summary = localize(description);
    // skills have no title field; the body's first heading is the author's own
    const heading = /^#\s+(.{2,80})$/m.exec(parsed.body.split('\n').slice(0, 20).join('\n'))?.[1].trim();
    const title = localize(heading && heading.toLowerCase() !== meta.name ? clean(heading.replace(/[*_`]/g, '')) : '');
    const checks: Checks = {
      format: { errors: [], warnings: parsed.warnings, dropped: pkg.dropped },
      secrets,
      findings,
      rules: hash,
      quality: { reasons: [], score: descriptionQuality(description) },
      review: 'off',
      checkedAt: new Date().toISOString(),
    };
    const files: PackageFile[] = pkg.files;
    const sourcePath = dir ? `/tree/${commit.sha}/${dir}` : `/tree/${commit.sha}`;
    inputs.push({
      sourceKey: `github:${repo.full_name.toLowerCase()}:${dir}`,
      source: 'github',
      publisher: { kind: 'github', handle: repo.owner.login.toLowerCase(), name: repo.owner.login, githubLogin: repo.owner.login, githubId: repo.owner.id },
      name: meta.name,
      kind: 'skill',
      listing: listingOf(title, summary, autoTags(tags, { name: meta.name, title: title.en ?? title.zh, summary: description })),
      repositoryUrl: repo.html_url,
      websiteUrl: null,
      license,
      runtime: skillRuntime(files),
      dedupeKey: `skill:${await sha256(skillFile!.data)}`,
      owns: true,
      version: meta.metadata?.version ?? null,
      contentSha256: await treeHash(files),
      sourceCommit: commit.sha,
      sourceUrl: `${repo.html_url}${sourcePath}`,
      files,
      hosted,
      metadata: { skill: secrets.length ? redactDeep(meta) : meta, repository: repo.full_name, path: dir },
      permissions: skillPermissions(files, meta.allowedTools),
      checks,
      packages: [],
      // the body is part of the package: kept (and searched) only when the files are
      readme: hosted ? parsed.body : null,
      excerpt: hosted ? excerpt(parsed.body) : null,
      versionAt: commit.commit.committer?.date ?? new Date().toISOString(),
      risk: riskOf(findings),
      repoStars: repo.stargazers_count,
    });
  }
  result.skills = inputs.length;
  const saved = await saveVersions(env, inputs, until);
  result.created = saved.created;
  result.updated = saved.updated;
  result.remaining = saved.remaining;
  if (result.remaining) return result;

  // skills that were in this repository before and are gone now
  const prefix = `github:${repo.full_name.toLowerCase()}:`;
  const { results: before } = await db
    .prepare("SELECT source_key FROM items WHERE source_key >= ?1 AND source_key < ?2 AND status NOT IN ('retired', 'removed')")
    .bind(prefix, `${prefix}\u{10FFFF}`)
    .all<{ source_key: string }>();
  const now = new Set(inputs.map((i) => i.sourceKey));
  result.retired = await retireItems(db, before.map((b) => b.source_key).filter((k) => !now.has(k)));
  return result;
}

/** One hash for a set of files: their paths, modes and contents. A re-import that changed nothing makes no new version. */
async function treeHash(files: PackageFile[]): Promise<string> {
  const lines: string[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) lines.push(`${f.executable ? 'x' : '-'} ${await sha256(f.data)} ${f.path}`);
  return sha256(lines.join('\n'));
}

/** A skill's runtime for filtering: the language of its scripts, or 'none' for instructions only. */
function skillRuntime(files: PackageFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const r = /\.py$/i.test(f.path) ? 'python' : /\.(js|mjs|cjs|ts)$/i.test(f.path) ? 'node' : /\.(sh|bash|zsh)$/i.test(f.path) ? 'shell' : null;
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
}
