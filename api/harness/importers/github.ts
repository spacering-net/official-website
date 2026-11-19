import { asText, readTar, sha256, treeHash, type PackageFile } from '../files';
import { licenseFromText, REDISTRIBUTABLE, spdx } from '../limits';
import { excerpt, firstHeading, renderMarkdown } from '../markdown';
import { listingOf, type Checks } from '../model';
import { normalizePackage, type RawFile } from '../package';
import { riskOf, scanStructure } from '../scan/content';
import { skillPermissions } from '../scan/permissions';
import { applyRules, loadRules, type Rule } from '../scan/rules';
import { redactDeep, redactSecrets, scanJsonSecrets, scanSecrets } from '../scan/secrets';
import { parseSkill } from '../skill';
import { rankInputs, retireItems, saveVersions, type PublisherRef, type VersionInput } from '../store';
import { autoTags, loadTags } from '../tags';
import { clip, descriptionQuality, localize, toName } from '../text';
import { filesToReadFirst, folderProblem, pluginFindings, pluginPermissionLines, pluginSpecs, readPlugin, type PluginDescriptor, type PluginSpec } from '../plugin';
import { assistantInputs, findAssistantFiles, pluginOf, type AssistantConfig } from './assistants';
import { pinPackages } from './packages';

/**
 * Skills from GitHub repositories (docs: section 12): a curated list to begin
 * with, each checked daily for a new commit. The commit's tarball is read
 * once; every folder with a SKILL.md becomes an item under the repository's
 * owner, unclaimed until they sign in. Files are kept only when the license
 * allows; otherwise only their list and hashes, and clients fetch them from
 * GitHub at the same commit. A source may take the repository's assistants
 * too, in the same run (importers/assistants.ts), or only those.
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
  /** false: not this repository's skills (a source of assistants only) */
  skills?: boolean;
  /** its assistants too, found as this says; none without it */
  assistants?: AssistantConfig;
  /**
   * which commit to import (docs/harness-plugins.md, section 5): 'head', the
   * default branch's latest; 'release', the latest GitHub release's; 'auto'
   * (the default), the release's when the repository is one plugin whose
   * manifest has the release's version. A release is followed only forward.
   */
  track?: 'auto' | 'release' | 'head';
  /** plugins taken whole or split whatever their contents say (section 3, step 4), by name */
  plugins?: Record<string, 'whole' | 'split'>;
}

/** A plugin as one complete import saw it: what the reconcile commits (import_runs.plugins). */
export interface PluginRun {
  key: string;
  /** the version this import saved (staged), or the current one when nothing changed */
  version: string;
  order: number;
  /** its members' source keys */
  members: string[];
  autorun: boolean;
  /** what Claude Code installs it as from the repository's own marketplace (`name@marketplace`), when it is in one */
  claude?: string;
}

export interface RepoResult {
  commit: string;
  changed: boolean;
  skills: number;
  assistants?: number;
  /** plugins used whole, and those that are not (their skills stay items of their own) */
  plugins?: number;
  loosePlugins?: number;
  created: number;
  updated: number;
  retired: number;
  /** skills not saved before the deadline: the import is not finished */
  remaining: number;
  rejected: { path: string; errors: string[] }[];
  /** which commit it follows, and why (section 5) */
  track?: 'head' | 'release';
  trackNote?: string;
  /** for the reconcile, once the import is complete */
  run?: { plugins: PluginRun[]; loose: string[] };
}

export interface ImportOptions {
  /** what the source followed last time (import_sources.stats.track) */
  lastTrack?: 'head' | 'release';
  /** import the last imported commit again, not a newer one (a plugin's whole/split changed) */
  pin?: boolean;
  /** plugins take their members off the shelves (HARNESS_PLUGINS is on) */
  plugins?: boolean;
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

/** The same, null for a 404 (no such release, tag or file). */
async function ghMaybe<T>(env: Env, path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, { headers: headers(env), signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path} answered ${res.status}`);
  return res.json() as Promise<T>;
}

/** A file of the repository at a commit, as text; null when there is none. */
export async function rawFile(repo: string, sha: string, path: string): Promise<string | null> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { 'User-Agent': 'spacering.net-harness' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub raw ${path} answered ${res.status}`);
  return res.text();
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

interface Commit {
  sha: string;
  commit: { committer?: { date?: string } };
}

const parseJson = (text: string | null): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};
const versionIn = (v: unknown): string | null => (v && typeof v === 'object' && typeof (v as { version?: unknown }).version === 'string' ? (v as { version: string }).version.trim() || null : null);

/**
 * The version of the one plugin at a repository's root, at a commit: its
 * marketplace's only plugin (at './'), else its root manifests, Claude Code's,
 * Codex's, package.json in turn. Null for anything else (none, or several).
 */
export async function rootPluginVersion(repo: string, sha: string): Promise<string | null> {
  const market = parseJson(await rawFile(repo, sha, '.claude-plugin/marketplace.json')) as { plugins?: { source?: unknown; version?: unknown }[] } | null;
  if (market && Array.isArray(market.plugins)) {
    if (market.plugins.length !== 1 || typeof market.plugins[0].source !== 'string' || !/^\.\/?$/.test(market.plugins[0].source)) return null;
    const own = versionIn(market.plugins[0]);
    if (own) return own;
  }
  for (const path of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const v = versionIn(parseJson(await rawFile(repo, sha, path)));
    if (v) return v;
  }
  // package.json only for a Pi package: any other one says nothing of a plugin
  const pkg = parseJson(await rawFile(repo, sha, 'package.json')) as { pi?: unknown } | null;
  return pkg && typeof pkg.pi === 'object' && pkg.pi ? versionIn(pkg) : null;
}

/**
 * Which commit to import (section 5): the default branch's latest, or the
 * latest release's, never one behind what was imported last (that would make
 * old content a newer revision). While following releases, a release that is
 * behind leaves things as they are.
 */
async function chooseCommit(
  env: Env,
  repo: Repo,
  config: RepoConfig,
  lastCommit: string | null,
  options: ImportOptions,
): Promise<{ commit: Commit; track: 'head' | 'release'; note: string }> {
  const at = (ref: string) => gh<Commit>(env, `/repos/${repo.full_name}/commits/${encodeURIComponent(ref)}`);
  if (options.pin && lastCommit) return { commit: await at(lastCommit), track: options.lastTrack ?? 'head', note: 'pinned to the last import' };
  const head = async (note: string) => ({ commit: await at(repo.default_branch), track: 'head' as const, note });
  if (config.track === 'head') return head('configured');
  // a source following releases stays where it is while GitHub cannot say what the release is
  const following = options.lastTrack === 'release' && !!lastCommit;
  const stay = async (note: string) => ({ commit: await at(lastCommit!), track: 'release' as const, note });
  let release: { tag_name?: string } | null;
  let tagged: Commit;
  let version: string | null = null;
  try {
    release = await ghMaybe<{ tag_name?: string }>(env, `/repos/${repo.full_name}/releases/latest`);
    if (!release?.tag_name) return following ? stay('no release now') : head('no release');
    tagged = await at(release.tag_name);
    if (config.track !== 'release') version = await rootPluginVersion(repo.full_name, tagged.sha);
  } catch (err) {
    // following releases, it waits for GitHub; otherwise it goes on with the branch, as before
    if (following) return stay(`release not read: ${String(err).slice(0, 100)}`);
    return head(`release not read: ${String(err).slice(0, 100)}`);
  }
  if (config.track !== 'release' && (!version || version !== release.tag_name.replace(/^v(?=\d)/i, ''))) return head(`release ${release.tag_name} is not a root plugin's version`);
  if (lastCommit && lastCommit !== tagged.sha) {
    const cmp = await ghMaybe<{ status?: string }>(env, `/repos/${repo.full_name}/compare/${lastCommit}...${tagged.sha}`).catch(() => null);
    if (!cmp && following) return stay(`release ${release.tag_name} not compared`);
    if (cmp?.status !== 'ahead' && cmp?.status !== 'identical') {
      if (options.lastTrack === 'release') return { commit: await at(lastCommit), track: 'release', note: `release ${release.tag_name} is not ahead of the last import` };
      return head(`release ${release.tag_name} is not ahead of the last import`);
    }
  }
  return { commit: tagged, track: 'release', note: `release ${release.tag_name}` };
}

/** The tag that names a commit, without a leading v; null when none does. */
async function tagAt(env: Env, repo: string, sha: string): Promise<string | null> {
  const tags = await ghMaybe<{ name: string; commit: { sha: string } }[]>(env, `/repos/${repo}/tags?per_page=100`).catch(() => null);
  const tag = tags?.find((t) => t.commit.sha === sha)?.name ?? null;
  return tag ? tag.replace(/^v(?=\d)/i, '').slice(0, 64) : null;
}

/**
 * Import one repository at the commit chooseCommit picks. Nothing is done
 * when that commit was imported already, unless `force`. Saving stops at the
 * deadline `until` (ms), if given: the rest is counted in `remaining`, and
 * skills gone from the repository are retired only once all are saved.
 *
 * Plugins used whole are saved as staged versions, and their members as
 * usual; which of them are on the shelves changes only in the reconcile that
 * follows the complete import (reconcile.ts), from `result.run`.
 */
export async function importRepo(
  env: Env,
  fullName: string,
  config: RepoConfig,
  lastCommit: string | null,
  force = false,
  until?: number,
  options: ImportOptions = {},
): Promise<RepoResult> {
  const repo = await gh<Repo>(env, `/repos/${fullName}`);
  const chosen = await chooseCommit(env, repo, config, lastCommit, options);
  const commit = chosen.commit;
  const result: RepoResult = { commit: commit.sha, changed: false, skills: 0, created: 0, updated: 0, retired: 0, remaining: 0, rejected: [], track: chosen.track, trackNote: chosen.note };
  if (!force && commit.sha === lastCommit) return result;
  result.changed = true;
  const committedAt = commit.commit.committer?.date ?? new Date().toISOString();

  // which folders are skills, and which files may be assistants: the tree lists every path with its
  // size, before anything is downloaded
  const tree = await gh<{ tree: { path: string; type: string; size?: number; mode?: string }[]; truncated: boolean }>(env, `/repos/${repo.full_name}/git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo.full_name}: tree too large to list`);
  const blobs = tree.tree.filter((e) => e.type === 'blob');
  const paths = new Set(blobs.map((e) => e.path));
  const within = (p: string) =>
    (config.paths?.length ? config.paths : ['']).some((root) => {
      const r = root.replace(/\/$/, '');
      if (r && !p.startsWith(`${r}/`)) return false;
      const folders = (r ? p.slice(r.length + 1) : p).split('/').slice(0, -1);
      return config.hidden || !folders.some((f) => f.startsWith('.'));
    });
  // a skill inside another skill's folder is part of that skill
  const outermost = (dirs: string[]) => dirs.filter((d, _, all) => !all.some((o) => o !== d && (o === '' || d.startsWith(`${o}/`))));
  const skillFiles = blobs.filter((e) => /(^|\/)SKILL\.md$/.test(e.path));
  const skillDirs = config.skills === false ? [] : outermost(skillFiles.filter((e) => within(e.path)).map((e) => e.path.replace(/\/?SKILL\.md$/, ''))).sort();
  const dirOf = (path: string) => skillDirs.find((d) => d === '' || path === d || path.startsWith(`${d}/`));
  // an agent inside any skill's folder is that skill's own, whether or not the skills are taken
  const assistantFiles = config.assistants
    ? findAssistantFiles(
        blobs.map((e) => e.path),
        config.assistants,
        outermost(skillFiles.map((e) => e.path.replace(/\/?SKILL\.md$/, ''))),
      )
    : [];
  const wanted = new Set(assistantFiles);

  // the plugins it declares (docs/harness-plugins.md, section 3): their marketplaces are read first, and
  // each plugin's folder is downloaded whole, as one package, when a package may be that big
  const first = new Map<string, string>();
  for (const path of filesToReadFirst(paths)) {
    const text = await rawFile(repo.full_name, commit.sha, path);
    if (text !== null) first.set(path, text);
  }
  const declared = pluginSpecs(paths, first);
  // the repository as a Claude Code marketplace: its name, and the plugins it lists from its own folders
  const claudeMarket = (() => {
    const m = parseJson(first.get('.claude-plugin/marketplace.json') ?? null) as { name?: unknown; plugins?: unknown } | null;
    const word = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : null);
    const name = word(m?.name);
    if (!name || !Array.isArray(m?.plugins)) return null;
    const plugins = new Set(m.plugins.filter((e) => e && typeof e === 'object' && typeof (e as { source?: unknown }).source === 'string').map((e) => word((e as { name?: unknown }).name)));
    return { name, plugins };
  })();
  for (const p of declared.problems) result.rejected.push({ path: `plugin:${p.plugin}`, errors: [p.reason] });
  const specs = declared.specs.filter((spec) => {
    const problem = folderProblem(spec.root, tree.tree);
    if (problem) result.rejected.push({ path: `plugin:${spec.name ?? (spec.root || '.')}`, errors: [problem] });
    return !problem;
  });
  const roots = [...new Set(specs.map((s) => s.root))];
  const rootOf = (path: string) => roots.filter((r) => r === '' || path.startsWith(`${r}/`));

  // the folders above each assistant, where its license may be
  const above = new Set<string>();
  for (const p of assistantFiles) for (let d = parentOf(p); ; d = parentOf(d)) {
    above.add(d);
    if (!d) break;
  }
  const isLicense = (path: string) => /^LICEN[CS]E(\.(md|txt))?$/i.test(path.slice(path.lastIndexOf('/') + 1));
  const bytes = blobs.filter((e) => dirOf(e.path) !== undefined || wanted.has(e.path) || rootOf(e.path).length > 0).reduce((n, e) => n + (e.size ?? 0), 0);
  if (bytes > MAX_SKILLS_BYTES) throw new Error(`${repo.full_name}: skills too large (${bytes} bytes)`);

  // one download: the commit's tarball, keeping only files inside skill folders and plugins, the
  // assistants, and the license files above them
  const raw = new Map<string, RawFile[]>(skillDirs.map((d) => [d, []]));
  const pluginRaw = new Map<string, RawFile[]>(roots.map((r) => [r, []]));
  const licenses = new Map<string, string>();
  const assistantData = new Map<string, Uint8Array>();
  const folderLicenses = new Map<string, string>();
  if (skillDirs.length || assistantFiles.length || roots.length) {
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
        const inPlugins = rootOf(path);
        if (e.type !== 'file' && e.type !== 'dir') {
          if (dir !== undefined) raw.get(dir)!.push({ path: path.slice(dir ? dir.length + 1 : 0), data: new Uint8Array(), type: e.type });
          for (const r of inPlugins) pluginRaw.get(r)!.push({ path: path.slice(r ? r.length + 1 : 0), data: new Uint8Array(), type: e.type });
          return false;
        }
        if (dir === undefined && !inPlugins.length) return e.type === 'file' && (wanted.has(path) || (isLicense(path) && above.has(parentOf(path))));
        return e.type === 'file';
      },
      (e, data) => {
        const path = strip(e.path);
        const dir = dirOf(path);
        const executable = (e.mode & 0o111) !== 0;
        for (const r of rootOf(path)) pluginRaw.get(r)!.push({ path: path.slice(r ? r.length + 1 : 0), data, executable, type: 'file' });
        if (dir === undefined) {
          if (wanted.has(path)) assistantData.set(path, data);
          else if (isLicense(path) && above.has(parentOf(path))) {
            const id = licenseFromText(asText(data) ?? '');
            if (id) folderLicenses.set(parentOf(path), id);
          }
          return;
        }
        const rel = path.slice(dir ? dir.length + 1 : 0);
        raw.get(dir)!.push({ path: rel, data, executable, type: 'file' });
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
  const publisher = { kind: 'github' as const, handle: repo.owner.login.toLowerCase(), name: repo.owner.login, githubLogin: repo.owner.login, githubId: repo.owner.id };
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
    const heading = firstHeading(parsed.body);
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
      publisher,
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
      versionAt: committedAt,
      risk: riskOf(findings),
      repoStars: repo.stargazers_count,
    });
  }
  result.skills = inputs.length;
  const prefix = `github:${repo.full_name.toLowerCase()}:`;

  // the assistants, named clear of the skills of this import
  const assistants = assistantFiles.length
    ? await assistantInputs(
        db,
        {
          fullName: repo.full_name,
          htmlUrl: repo.html_url,
          commit: commit.sha,
          committedAt,
          stars: repo.stargazers_count,
          publisher,
          license: repoLicense,
        },
        assistantData,
        folderLicenses,
        new Map(assistantFiles.map((p) => [p, pluginOf(p, (path) => paths.has(path))])),
        new Map(inputs.map((i) => [i.name, i.sourceKey])),
        { rules, hash },
      )
    : { inputs: [], rejected: [] };
  result.assistants = assistants.inputs.length;
  result.rejected.push(...assistants.rejected);

  // the plugins: read, told whole or not, their members found among this import's items
  const plugins: { spec: PluginSpec; d: PluginDescriptor; files: PackageFile[] }[] = [];
  for (const spec of specs) {
    const pkg = normalizePackage(pluginRaw.get(spec.root) ?? [], { stripWrapper: false });
    const label = spec.name ?? (spec.root || '.');
    if (pkg.errors.length) {
      result.rejected.push({ path: `plugin:${label}`, errors: pkg.errors.map((e) => e.code) });
      continue;
    }
    try {
      const d = await readPlugin(spec, pkg.files, spec.name ? config.plugins?.[spec.name] : undefined);
      if (!spec.name && config.plugins?.[d.name]) Object.assign(d, await readPlugin(spec, pkg.files, config.plugins[d.name]));
      // a manifest that does not read, or a path one names out of the folder: not a package Harness can vouch for
      if (d.problems.length) {
        result.rejected.push({ path: `plugin:${label}`, errors: d.problems });
        continue;
      }
      plugins.push({ spec, d, files: pkg.files });
    } catch (err) {
      result.rejected.push({ path: `plugin:${label}`, errors: [`unreadable: ${String(err).slice(0, 200)}`] });
    }
  }
  const byKey = new Map([...inputs, ...assistants.inputs].map((i) => [i.sourceKey, i]));
  const memberOf = new Map<string, string>();
  const runs: PluginRun[] = [];
  const pluginInputs: VersionInput[] = [];
  const loose: string[] = [];
  const pluginKey = (name: string) => `${prefix}plugin:${toName(name, 'plugin')}`;
  for (const { spec, d, files } of plugins.sort((a, b) => a.spec.order - b.spec.order)) {
    const key = pluginKey(d.name);
    const repoPath = (p: string) => [spec.root, p].filter(Boolean).join('/');
    const members = d.components.map((c) => `${prefix}${repoPath(c.path)}`).filter((k) => byKey.has(k));
    // each member's version, from the plugin that has it first, when its own SKILL.md gives none
    for (const k of members) {
      const i = byKey.get(k)!;
      if (!i.version && d.version) i.version = d.version;
    }
    if (!d.whole) {
      loose.push(key);
      continue;
    }
    // a plugin is taken from a source only through what the source takes from it (its configured paths):
    // one with none of this import's skills or assistants is not this source's to list. A member two
    // plugins have is in both lists: the reconcile gives it to the first that can hold it.
    if (!members.length) {
      loose.push(key);
      continue;
    }
    for (const k of members) if (!memberOf.has(k)) memberOf.set(k, key);
    pluginInputs.push(await pluginInput(repo, commit.sha, committedAt, spec, d, files, { rules, hash, tags, repoLicense, publisher, name: d.name, key, db }));
    const claude = spec.name && claudeMarket?.plugins.has(spec.name) ? `${spec.name}@${claudeMarket.name}` : undefined;
    runs.push({ key, version: '', order: spec.order, members, autorun: d.autorun.length > 0, ...(claude ? { claude } : {}) });
  }
  result.plugins = runs.length;
  result.loosePlugins = loose.length;

  // a version for the rest: the tag on this commit, if any
  const unlabelled = [...inputs, ...assistants.inputs].filter((i) => !i.version);
  if (unlabelled.length) {
    const tag = await tagAt(env, repo.full_name, commit.sha);
    if (tag) for (const i of unlabelled) i.version = tag;
  }
  // a member is off the shelves while the switch is on; it is found and ranked apart from the rest
  if (options.plugins) for (const k of memberOf.keys()) byKey.get(k)!.member = true;
  rankInputs([...inputs, ...assistants.inputs].filter((i) => !i.member));
  rankInputs([...inputs, ...assistants.inputs].filter((i) => i.member));
  rankInputs(pluginInputs);

  const saved = await saveVersions(env, inputs, until);
  result.created = saved.created;
  result.updated = saved.updated;
  result.remaining = saved.remaining + (saved.remaining ? assistants.inputs.length + pluginInputs.length : 0);
  if (result.remaining) return result;
  // The assistants' copies inside this repository are told apart by the import itself, on every run:
  // its own items saved before hold no body against one another (one may be changing now)
  const savedAssistants = await saveVersions(env, assistants.inputs, until, prefix);
  result.created += savedAssistants.created;
  result.updated += savedAssistants.updated;
  result.remaining = savedAssistants.remaining + (savedAssistants.remaining ? pluginInputs.length : 0);
  if (result.remaining) return result;
  const savedPlugins = await saveVersions(env, pluginInputs, until);
  result.created += savedPlugins.created;
  result.updated += savedPlugins.updated;
  result.remaining = savedPlugins.remaining;
  if (result.remaining) return result;
  for (const r of runs) r.version = savedPlugins.versions.get(r.key)!;

  // a single plugin's releases, as a record beside its versions
  if (plugins.length === 1 && runs.length === 1) {
    await syncReleases(env, repo, commit.sha, committedAt, runs[0].key, plugins[0].d.version, plugins[0].files).catch((err) =>
      console.warn(`[harness] ${repo.full_name}: releases not read`, String(err)),
    );
  }

  // skills and assistants that were in this repository before and are gone now: retired; a member that is
  // gone stays deleted (nothing to come back to), and no plugin holds it any more. Plugins go in the reconcile.
  const now = new Set([...inputs, ...assistants.inputs].map((i) => i.sourceKey));
  const { results: before } = await db
    .prepare("SELECT source_key, status, listed_reasons FROM items WHERE source_key >= ?1 AND source_key < ?2 AND status NOT IN ('retired', 'removed', 'draft') AND kind != 'plugin'")
    .bind(prefix, `${prefix}\u{10FFFF}`)
    .all<{ source_key: string; status: string; listed_reasons: string }>();
  const gone = before.filter((b) => !now.has(b.source_key));
  result.retired = await retireItems(db, gone.filter((b) => b.status !== 'deleted').map((b) => b.source_key));
  await markGone(db, gone.filter((b) => b.status === 'deleted' && b.listed_reasons.includes('"in_plugin"')).map((b) => b.source_key));
  result.run = { plugins: runs, loose };
  return result;
}

/**
 * Members gone from their repository: still deleted, and never brought back by a plugin's going. The
 * plugin lets go of them (and of the dedupe key they held) in its reconcile, with everything else it holds.
 */
async function markGone(db: D1Database, keys: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    await db
      .prepare(
        `UPDATE items SET listed_reasons = '["gone"]', updated_at = ?1
          WHERE source_key IN (${chunk.map((_, n) => `?${n + 2}`).join(', ')}) AND status = 'deleted' AND listed_reasons LIKE '%"in_plugin"%'`,
      )
      .bind(now, ...chunk)
      .run();
  }
}

interface PluginContext {
  rules: Rule[];
  hash: string;
  tags: Awaited<ReturnType<typeof loadTags>>;
  repoLicense: string | null;
  publisher: PublisherRef;
  name: string;
  key: string;
  db: D1Database;
}

/** A plugin's version, to be staged: the whole folder as one package. */
async function pluginInput(repo: Repo, sha: string, committedAt: string, spec: PluginSpec, d: PluginDescriptor, files: PackageFile[], ctx: PluginContext): Promise<VersionInput> {
  const license = files.map((f) => (/^LICEN[CS]E(\.(md|txt))?$/i.test(f.path) ? licenseFromText(asText(f.data) ?? '') : null)).find(Boolean) ?? ctx.repoLicense;
  // its files, and what its marketplace's entry says of it (with `strict: false`, its manifest: hooks and
  // servers declared there run as much as those in the folder)
  const secrets = [
    ...files.flatMap((f) => {
      const text = asText(f.data);
      return text === null ? [] : scanSecrets(f.path, text);
    }),
    ...(spec.entry ? [...scanJsonSecrets('.claude-plugin/marketplace.json', spec.entry), ...leafSecrets('.claude-plugin/marketplace.json', spec.entry)] : []),
  ];
  const hosted = !!license && REDISTRIBUTABLE.has(license) && !secrets.length;
  const clean = (text: string) => (secrets.length ? redactSecrets(text) : text);
  const findings = pluginFindings(files, d, ctx.rules);
  const description = clean(d.description ?? '');
  const title = localize(clean(d.title ?? ''));
  const readmeFile = files.find((f) => /^README\.(md|markdown)$/i.test(f.path));
  const readme = readmeFile ? asText(readmeFile.data) : null;
  // what is shown of what runs comes from the descriptor as kept: with any credential taken out
  const kept = secrets.length ? redactDeep(d) : d;
  const lines = pluginPermissionLines(kept);
  const base = skillPermissions(files, undefined);
  const name = toName(ctx.name, 'plugin');
  return {
    sourceKey: ctx.key,
    source: 'github',
    publisher: ctx.publisher,
    name,
    altNames: [`${name.slice(0, 57).replace(/-+$/, '')}-plugin`],
    kind: 'plugin',
    listing: listingOf(title, localize(description), autoTags(ctx.tags, { name, title: title.en ?? title.zh, summary: description })),
    repositoryUrl: repo.html_url,
    websiteUrl: null,
    license,
    runtime: skillRuntime(files),
    dedupeKey: `plugin:${await treeHash(files)}`,
    owns: true,
    version: d.version,
    contentSha256: await treeHash(files),
    sourceCommit: sha,
    sourceUrl: spec.root ? `${repo.html_url}/tree/${sha}/${spec.root}` : `${repo.html_url}/tree/${sha}`,
    files,
    hosted,
    metadata: { plugin: kept, repository: repo.full_name, path: spec.root },
    permissions: {
      declared: {},
      detected: { ...base.detected, runsCode: [...new Set([...base.detected.runsCode, ...lines.servers])].sort(), hooks: lines.hooks, code: lines.code },
    },
    checks: {
      format: { errors: [], warnings: [], dropped: [] },
      secrets,
      findings,
      rules: ctx.hash,
      quality: { reasons: [], score: descriptionQuality(description) },
      review: 'off',
      checkedAt: new Date().toISOString(),
    },
    // its MCP servers' packages, checked as an MCP server's are
    // (one that names no exact version is not looked up: the plugin is not installed whole while it has one)
    packages: [
      ...(await pinPackages(ctx.db, d.packages.filter((p) => p.version).map((p) => ({ registryType: p.registryType, identifier: p.identifier, version: p.version, verified: 'pending' as const })))),
      ...d.packages.filter((p) => !p.version).map((p) => ({ registryType: p.registryType, identifier: p.identifier, version: null, verified: 'unchecked' as const })),
    ],
    readme: hosted && readme ? clean(readme) : null,
    excerpt: hosted && readme ? excerpt(clean(readme)) : null,
    versionAt: committedAt,
    risk: riskOf(findings),
    repoStars: repo.stargazers_count,
    staged: true,
    components: d.components,
  };
}

/** Credentials in a JSON value's strings, each read as written (not as JSON escapes it), with its key. */
function leafSecrets(path: string, value: unknown, key?: string): ReturnType<typeof scanSecrets> {
  if (typeof value === 'string') return [...scanSecrets(path, value), ...(key ? scanSecrets(path, `${key}: ${value}`) : [])];
  if (Array.isArray(value)) return value.flatMap((v) => leafSecrets(path, v));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leafSecrets(path, v, k));
  return [];
}

/** Releases since Harness began keeping them (section 5), with the one current then: the record a plugin's page shows. */
const RELEASES_SINCE = '2026-10-07T00:00:00Z';

/**
 * Keep a single-plugin repository's releases beside its plugin: each GitHub
 * release since RELEASES_SINCE, its notes rendered (credentials taken out);
 * for this commit's version, when no release has it, the section of
 * RELEASE-NOTES.md or CHANGELOG.md that names it.
 */
async function syncReleases(env: Env, repo: Repo, sha: string, committedAt: string, key: string, version: string | null, files: PackageFile[]): Promise<void> {
  const db = env.HARNESS_DB;
  const item = await db.prepare('SELECT id FROM items WHERE source_key = ?1').bind(key).first<{ id: string }>();
  if (!item) return;
  const list = (await ghMaybe<{ tag_name: string; html_url: string; body: string | null; published_at: string | null; draft: boolean; prerelease: boolean }[]>(env, `/repos/${repo.full_name}/releases?per_page=30`)) ?? [];
  const rows: { version: string; tag: string | null; url: string | null; notes: string | null; at: string | null; commit: string | null }[] = [];
  // and the one that was current when Harness began
  const before = list.filter((r) => !r.draft && r.published_at && r.published_at < RELEASES_SINCE).sort((a, b) => (a.published_at! < b.published_at! ? 1 : -1))[0];
  for (const r of list) {
    if (r.draft || !r.published_at || (r.published_at < RELEASES_SINCE && r !== before)) continue;
    const v = r.tag_name.replace(/^v(?=\d)/i, '').slice(0, 64);
    rows.push({ version: v, tag: r.tag_name, url: r.html_url, notes: r.body, at: r.published_at, commit: v === version ? sha : null });
  }
  const current = rows.find((r) => r.version === version);
  if (version && !current) rows.push({ version, tag: null, url: null, notes: notesFromFiles(files, version), at: committedAt, commit: sha });
  else if (version && current && !current.notes?.trim()) current.notes = notesFromFiles(files, version);
  const statements: D1PreparedStatement[] = [];
  for (const r of rows) {
    let notesKey: string | null = null;
    if (r.notes?.trim()) {
      const html = renderMarkdown(redactSecrets(r.notes.slice(0, 64 * 1024)));
      notesKey = `releases/${await sha256(html)}.html`;
      await env.HARNESS_FILES.put(notesKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO releases (item_id, version, tag, url, notes_key, published_at, source_commit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (item_id, version) DO UPDATE SET tag = COALESCE(excluded.tag, tag), url = COALESCE(excluded.url, url),
             notes_key = COALESCE(excluded.notes_key, notes_key), published_at = COALESCE(published_at, excluded.published_at),
             source_commit = COALESCE(source_commit, excluded.source_commit)`,
        )
        .bind(item.id, r.version, r.tag, r.url, notesKey, r.at, r.commit),
    );
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
}

/** The section of RELEASE-NOTES.md or CHANGELOG.md whose heading names this version. */
export function notesFromFiles(files: PackageFile[], version: string): string | null {
  for (const name of [/^RELEASE[-_ ]?NOTES\.md$/i, /^CHANGELOG\.md$/i]) {
    const f = files.find((x) => name.test(x.path));
    const text = f ? asText(f.data) : null;
    if (!text) continue;
    const lines = text.split('\n');
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const start = lines.findIndex((l) => /^#{1,4}\s/.test(l) && new RegExp(`(^|[^\\w.])v?${esc}(?![\\w.])`).test(l));
    if (start < 0) continue;
    const level = /^#+/.exec(lines[start])![0].length;
    let end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
    if (end < 0) end = lines.length;
    const body = lines.slice(start + 1, end).join('\n').trim();
    if (body) return body;
  }
  return null;
}

/** A path's folder ('' at the top). */
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A skill's runtime for filtering: the language of its scripts, or 'none' for instructions only. */
function skillRuntime(files: PackageFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const r = /\.py$/i.test(f.path) ? 'python' : /\.(js|mjs|cjs|ts)$/i.test(f.path) ? 'node' : /\.(sh|bash|zsh)$/i.test(f.path) ? 'shell' : null;
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
}
