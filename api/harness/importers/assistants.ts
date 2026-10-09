import { assistantCard, assistantFindings, assistantNames, assistantPermissions, assistantTitle, bodyKey, fallbackNames, needsPlugin, parseAssistant } from '../assistant';
import { asText, sha256, type PackageFile } from '../files';
import { REDISTRIBUTABLE } from '../limits';
import { plainText, prose } from '../markdown';
import { listingOf, type AssistantMeta, type Checks } from '../model';
import { riskOf, scanStructure } from '../scan/content';
import { applyRules, type Rule } from '../scan/rules';
import { redactDeep, redactSecrets, scanSecrets } from '../scan/secrets';
import type { PublisherRef, VersionInput } from '../store';
import { autoTags, loadTags } from '../tags';
import { descriptionQuality, localize } from '../text';

/**
 * Assistants from GitHub repositories (docs: harness-assistants.md), read in
 * the same job as a repository's skills (importers/github.ts): one item per
 * definition file, under the repository's owner. Copies a repository makes of
 * an assistant for several of its plugins are told apart here, by their
 * bodies, on every run: one of each is on the shelves, the rest are listed.
 */

/** Which of a repository's files are assistants (a source's config, `assistants`). */
export interface AssistantConfig {
  /** only under these paths (default: anywhere in the repository) */
  paths?: string[];
  /** and not under these */
  exclude?: string[];
  /** also in hidden folders below the paths (a project's own `.claude/agents`) */
  hidden?: boolean;
  /** 'agents' (default): Markdown files in a folder named `agents`; 'all': every Markdown file under the paths */
  match?: 'agents' | 'all';
}

/** Folders of tests and samples: what is in them is not for installing. */
const NOT_ITEMS = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|examples?|samples?)\//i;
/** Markdown that is never a definition, templates for writing one included. */
const NOT_DEFINITIONS =
  /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICEN[CS]E|CODE_OF_CONDUCT|SECURITY|AGENTS|CLAUDE|GEMINI|index|(?:[\w-]*[-_.])?template)\.(md|markdown)$/i;

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * The files of a repository that may be assistants, from its file tree, before
 * anything is downloaded: Markdown files in an `agents` folder (or any, with
 * `match: 'all'`) under the configured paths; not in hidden folders unless
 * asked; not inside a skill's folder (those are the skill's own); not among
 * tests and samples; not READMEs and the like. Whether each is a definition
 * is for its frontmatter to say, once read.
 */
export function findAssistantFiles(paths: string[], config: AssistantConfig, skillDirs: string[]): string[] {
  const roots = config.paths?.length ? config.paths.map((p) => p.replace(/\/$/, '')) : [''];
  const exclude = (config.exclude ?? []).map((p) => p.replace(/\/$/, ''));
  return paths
    .filter((path) => {
      if (!/\.(md|markdown)$/i.test(path) || NOT_DEFINITIONS.test(path) || NOT_ITEMS.test(path)) return false;
      const root = roots.find((r) => !r || path.startsWith(`${r}/`));
      if (root === undefined || exclude.some((e) => path === e || path.startsWith(`${e}/`))) return false;
      const folders = dirname(root ? path.slice(root.length + 1) : path).split('/').filter(Boolean);
      if (!config.hidden && folders.some((f) => f.startsWith('.'))) return false;
      if ((config.match ?? 'agents') === 'agents' && !dirname(path).split('/').includes('agents')) return false;
      return !skillDirs.some((d) => d === '' || path.startsWith(`${d}/`));
    })
    .sort();
}

/** The plugin a definition comes in: the folder above its `agents` folder, when that folder is a Claude Code plugin. */
export function pluginOf(path: string, has: (path: string) => boolean): string | null {
  const parts = path.split('/');
  const at = parts.lastIndexOf('agents', parts.length - 2);
  if (at < 1) return null;
  return has(`${parts.slice(0, at).join('/')}/.claude-plugin/plugin.json`) ? parts[at - 1] : null;
}

/** A body's blocks (headings, paragraphs, lists: what blank lines part), each in a form to compare; its code and comments, which search leaves out anyway, left out. */
const blocks = (body: string) =>
  prose(body)
    .split(/\n[ \t]*\n/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/**
 * Blocks most of a collection's assistants share word for word: ECC opens
 * each with the same statement of rules (its heading and its list, the
 * assistant's own words following under the same heading), and many repeat
 * the same headings. Kept in each body, but left out of what search reads,
 * where they would make every one match the same words.
 */
function sharedBlocks(bodies: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const body of bodies) for (const b of new Set(blocks(body))) counts.set(b, (counts.get(b) ?? 0) + 1);
  const at = Math.max(5, Math.ceil(bodies.length / 2));
  return new Set([...counts].filter(([, n]) => n >= at).map(([b]) => b));
}

/**
 * The prefix most of a collection's names share (cs in cs-ceo-advisor,
 * cs-cto-advisor, …): a namespace, left out of titles made from names.
 */
function namespaceOf(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) {
    const m = /^([a-z]{2,4})-[a-z0-9]/.exec(n);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const [prefix, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return n >= Math.max(5, names.length * 0.3) ? prefix : '';
}

export interface AssistantRepo {
  fullName: string;
  htmlUrl: string;
  commit: string;
  committedAt: string;
  stars: number;
  publisher: PublisherRef;
  /** the repository's own license (SPDX), when GitHub names one */
  license: string | null;
}

interface Entry {
  path: string;
  file: string;
  dir: string;
  meta: AssistantMeta;
  body: string;
  data: Uint8Array;
  text: string;
  warnings: string[];
  key: string;
  names: string[];
}

const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');

/**
 * Names in use under the publisher, each with the source key of the item
 * that holds it: those of these items themselves (an item keeps its name),
 * and those any of these names would clash with.
 */
async function namesInUse(db: D1Database, handle: string, keys: string[], names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT name, source_key FROM items WHERE source_key IN (${marks(chunk.length)})`)
      .bind(...chunk)
      .all<{ name: string; source_key: string }>();
    for (const r of results) out.set(r.name, r.source_key);
  }
  for (let i = 0; i < names.length; i += 90) {
    const chunk = names.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT i.name, i.source_key FROM items i JOIN publishers p ON p.id = i.publisher_id WHERE p.handle = ?1 AND i.name IN (${marks(chunk.length, 2)})`)
      .bind(handle, ...chunk)
      .all<{ name: string; source_key: string | null }>();
    for (const r of results) if (!out.has(r.name)) out.set(r.name, r.source_key ?? '');
  }
  return out;
}

/**
 * Make the versions of a repository's assistants. `files`: the candidates'
 * contents by path; `licenses`: license files read above them, by folder (the
 * nearest one above a definition is its license, else the repository's);
 * `plugins`: each candidate's plugin; `skills`: the names this import's
 * skills take, with their source keys.
 */
export async function assistantInputs(
  db: D1Database,
  repo: AssistantRepo,
  files: Map<string, Uint8Array>,
  licenses: Map<string, string>,
  plugins: Map<string, string | null>,
  skills: Map<string, string>,
  rules: { rules: Rule[]; hash: string },
): Promise<{ inputs: VersionInput[]; rejected: { path: string; errors: string[] }[] }> {
  const rejected: { path: string; errors: string[] }[] = [];
  const entries: Entry[] = [];
  for (const [path, data] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const text = asText(data);
    if (text === null) {
      rejected.push({ path, errors: ['not_utf8'] });
      continue;
    }
    const file = path.slice(path.lastIndexOf('/') + 1);
    const plugin = plugins.get(path) ?? null;
    const parsed = parseAssistant(text, file, plugin);
    if (parsed.skip) continue;
    if (!parsed.meta) {
      rejected.push({ path, errors: parsed.errors });
      continue;
    }
    entries.push({
      path,
      file,
      dir: path.slice(0, path.length - file.length).replace(/\/$/, ''),
      meta: parsed.meta,
      body: parsed.body,
      data,
      text,
      warnings: parsed.warnings,
      key: await sha256(bodyKey(parsed.body)),
      names: [],
    });
  }

  // Copies of one body: the one whose own name is its shortest (not a plugin's renamed copy) stands for
  // them, else the first by path; the rest are listed, and the one on the shelves names their plugins.
  // A plugin's prefix comes off the names of copies in several plugins only (each renamed for its
  // plugin): a definition of its own keeps its name, as do variants of one in the same plugin.
  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(e.key, [...(groups.get(e.key) ?? []), e]);
  for (const group of groups.values()) {
    const spread = new Set(group.map((e) => e.meta.plugin)).size > 1;
    for (const e of group) e.names = assistantNames(e.meta.name, e.file, spread ? e.meta.plugin : null);
  }
  const chosen = new Map<string, Entry>();
  for (const [key, group] of groups) chosen.set(key, group.find((e) => e.names[0] === e.meta.name) ?? group[0]);

  // Names in addresses. An item keeps the name it has; a new one takes its shortest name that is free,
  // the assistants with the most copies choosing first, else one with its plugin or "agent" added
  // (fallbackNames), else the last of these (numbered by the store). A copy keeps its own name:
  // the short one belongs to the copy on the shelves.
  const candidates = new Map(
    entries.map((e) => {
      const own = chosen.get(e.key) === e ? e.names : [e.names[e.names.length - 1]];
      return [e, [...own, ...fallbackNames(own[0], e.meta.plugin)]];
    }),
  );
  const sourceKey = (e: Entry) => `github:${repo.fullName.toLowerCase()}:${e.path}`;
  const taken = new Map([
    ...skills,
    ...(await namesInUse(db, repo.publisher.handle, entries.map(sourceKey), [...new Set([...candidates.values()].flat())])),
  ]);
  const holds = new Map(taken);
  const owner = new Map([...taken].map(([name, key]) => [key, name]));
  const nameOf = new Map<Entry, string>();
  const order = [...groups.values()]
    .sort((a, b) => b.length - a.length || (a[0].path < b[0].path ? -1 : 1))
    .flatMap((g) => {
      const first = chosen.get(g[0].key)!;
      return [first, ...g.filter((e) => e !== first)];
    });
  for (const e of order) {
    const key = sourceKey(e);
    const kept = owner.get(key);
    if (kept) {
      nameOf.set(e, kept);
      continue;
    }
    const names = candidates.get(e)!;
    const free = names.find((n) => !holds.has(n)) ?? names[names.length - 1];
    holds.set(free, key);
    nameOf.set(e, free);
  }

  // what the collection shares, left out of what search reads; and its names' namespace, out of titles
  const shared = sharedBlocks([...groups.values()].map((g) => g[0].body));
  const searchText = (body: string) => {
    // code and comments out once, by the body's own structure (what is left is not Markdown to read again)
    const text = prose(body);
    return shared.size
      ? text
          .split(/\n[ \t]*\n/)
          .filter((b) => !shared.has(b.replace(/\s+/g, ' ').trim()))
          .join('\n\n')
      : text;
  };
  const namespace = namespaceOf([...groups.values()].map((g) => chosen.get(g[0].key)!.names[0]));

  const tags = await loadTags(db);
  const licenseOf = (dir: string) => {
    for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
      const id = licenses.get(d);
      if (id) return id;
      if (!d) return repo.license;
    }
  };

  const inputs: VersionInput[] = [];
  for (const e of entries) {
    const holder = chosen.get(e.key)!;
    const isCopy = holder !== e;
    const secrets = scanSecrets(e.path, e.text);
    const clean = (s: string) => (secrets.length ? redactSecrets(s) : s);
    const licenseId = licenseOf(e.dir);
    const hosted = !!licenseId && REDISTRIBUTABLE.has(licenseId) && !secrets.length;
    const files: PackageFile[] = [{ path: e.file, data: e.data, executable: false }];
    const findings = [...scanStructure(files, { instructions: true }), ...applyRules(rules.rules, files), ...assistantFindings(e.meta)];
    const description = clean(e.meta.description);
    const shortName = holder.names[0];
    const title = localize(clean(assistantTitle(e.meta.name, e.body, shortName, namespace)));
    const itemTags = autoTags(tags, { name: shortName, title: title.en ?? title.zh, summary: description });
    const searched = hosted ? plainText(searchText(e.body)) : null;
    const alsoIn = isCopy ? [] : [...new Set(groups.get(e.key)!.filter((x) => x !== e && x.meta.plugin && x.meta.plugin !== e.meta.plugin).map((x) => x.meta.plugin!))].sort();
    const reasons = [...(isCopy ? ['duplicate'] : []), ...(needsPlugin(e.meta, e.body) ? ['needs_plugin'] : [])];
    const checks: Checks = {
      format: { errors: [], warnings: e.warnings, dropped: [] },
      secrets,
      findings,
      rules: rules.hash,
      quality: { reasons, score: descriptionQuality(description) },
      review: 'off',
      checkedAt: new Date().toISOString(),
    };
    const meta = secrets.length ? redactDeep(e.meta) : e.meta;
    inputs.push({
      sourceKey: sourceKey(e),
      source: 'github',
      publisher: repo.publisher,
      name: nameOf.get(e)!,
      kind: 'assistant',
      listing: listingOf(title, localize(description), itemTags),
      repositoryUrl: repo.htmlUrl,
      websiteUrl: null,
      license: licenseId,
      runtime: e.meta.hooks ? 'shell' : 'none',
      // copies inside the repository were told apart above; the one on the shelves holds the body
      // against other sources' copies
      dedupeKey: isCopy ? null : `assistant:${e.key}`,
      owns: true,
      version: null,
      // what the version is: the file, and what Harness reads from it to list it and to search it (which leaves out
      // what the rest of the collection shares, so it may change while the file does not)
      contentSha256: await sha256(`${await sha256(e.data)}\n${JSON.stringify({ title, tags: itemTags, description, searched })}`),
      sourceCommit: repo.commit,
      sourceUrl: `${repo.htmlUrl}/blob/${repo.commit}/${e.path}`,
      files,
      hosted,
      metadata: { assistant: meta, repository: repo.fullName, path: e.dir, file: e.file },
      permissions: assistantPermissions(files, meta),
      checks,
      packages: [],
      // the body is the package: kept (and searched) only when the file is
      readme: hosted ? e.body : null,
      excerpt: searched,
      versionAt: repo.committedAt,
      risk: riskOf(findings),
      repoStars: repo.stars,
      card: assistantCard(meta, alsoIn),
    });
  }
  return { inputs, rejected };
}
