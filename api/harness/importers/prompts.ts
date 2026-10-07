import { sha256, type PackageFile } from '../files';
import { spdx } from '../limits';
import { isPublicHttps } from '../mcp';
import { listingOf, type Checks, type PromptMeta, type Showcase, type StoredPromptCard } from '../model';
import { cleanPrompt, postTime, promptExcerpt, promptFileOf, promptKey, promptLang, promptTitle } from '../prompt';
import { riskOf, scanStructure } from '../scan/content';
import { emptyPermissions } from '../scan/permissions';
import { applyRules, loadRules } from '../scan/rules';
import { redactSecrets, scanSecrets } from '../scan/secrets';
import { retireItems, saveVersions, type VersionInput } from '../store';
import { autoTags, loadTags } from '../tags';
import { clip, localize, toName, type Localized } from '../text';
import { gh, type Repo, type RepoResult } from './github';

/**
 * Prompts from GitHub repositories (docs: harness-prompts.md). A collection
 * keeps its prompts in one data file, and its source's config says which
 * field of an entry holds what, so another collection is data, not code.
 * Entries with the same prompt are one item, with each entry as one of its
 * results (a video someone made with it). Each item keeps its prompt as
 * PROMPT.md; the pictures of its results are copied here by the `media` job
 * (importers/media.ts), from the hosts the config allows.
 */

export interface PromptSourceConfig {
  kind: 'prompt';
  reader: 'json';
  /** the data file, in the repository */
  file: string;
  /** where its entries are: a JSON pointer, the top by default */
  at?: string;
  /** which field of an entry holds what; only `text` is needed */
  fields: Partial<Record<'id' | 'title' | 'partial' | 'by' | 'byUrl' | 'link' | 'cover' | 'category' | 'labels' | 'added', string>> & { text: string };
  /** an entry's moving preview, where the collection keeps one by entry: {id} is the entry's id */
  motion?: string;
  /** the model the prompts were written for */
  model?: string;
  /** 'creators': each prompt belongs to whoever shared it, and is shown credited; otherwise the SPDX id they all come under */
  rights: string;
  /** hosts pictures may be copied from */
  media?: string[];
  /** names for its categories */
  categories?: Record<string, Localized>;
  /** tags for its categories and labels */
  tags?: Record<string, string[]>;
}

/** the data file may not be bigger than this */
const MAX_FILE = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;
/** a prompt longer than this is not taken */
const MAX_TEXT = 50_000;
/** nor is anything shorter than this left on the shelves: it is a fragment ("Go all out.") */
const MIN_TEXT = 16;
/** how many pictures a card may choose from */
const FACES = 4;

/** One entry of a collection, checked. */
export interface Entry {
  id: string;
  text: string;
  title: string | null;
  partial: boolean;
  by: string | null;
  byUrl: string | null;
  link: string | null;
  cover: string | null;
  motion: string | null;
  category: string | null;
  labels: string[];
  at: string | null;
}

/** An https address on the public internet (and, if hosts are given, on one of them); null otherwise. */
function address(value: unknown, hosts?: string[]): string | null {
  if (typeof value !== 'string' || value.length > 1000 || !isPublicHttps(value)) return null;
  const url = new URL(value);
  if (hosts && !hosts.includes(url.hostname.toLowerCase())) return null;
  return url.href;
}

/** A handle as a source gives it ("@someone" or "someone"); never an email address. */
function handle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const h = value.trim().replace(/^@/, '');
  return h && h.length <= 64 && !/[\s@<>"'`]/.test(h) ? h : null;
}

const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? clip(value, max) : null);

/**
 * The entries of a collection's data file, each checked: a prompt (text) is
 * needed, the rest is taken where it is what it should be. Entries without a
 * usable id are known by their text's hash; a second entry with an id seen
 * already is skipped.
 */
export async function readEntries(data: unknown, config: PromptSourceConfig): Promise<{ entries: Entry[]; rejected: { path: string; errors: string[] }[] }> {
  let list: unknown = data;
  for (const part of (config.at ?? '').split('/').filter(Boolean)) list = (list as Record<string, unknown> | null)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (!Array.isArray(list)) throw new Error(`${config.file}: no list of entries at "${config.at ?? ''}"`);
  const f = config.fields;
  const entries: Entry[] = [];
  const rejected: { path: string; errors: string[] }[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.slice(0, MAX_ENTRIES).entries()) {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const body = typeof e[f.text] === 'string' ? cleanPrompt(e[f.text] as string) : '';
    if (!body || body.length > MAX_TEXT) {
      rejected.push({ path: `${config.file}#${i}`, errors: [body ? 'text_too_long' : 'text_missing'] });
      continue;
    }
    const given = f.id ? e[f.id] : undefined;
    const id = typeof given === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(given) ? given : `p${(await sha256(promptKey(body))).slice(0, 12)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const link = address(f.link ? e[f.link] : undefined);
    const added = f.added && typeof e[f.added] === 'string' && !Number.isNaN(Date.parse(e[f.added] as string)) ? new Date(Date.parse(e[f.added] as string)).toISOString() : null;
    const labels = f.labels && Array.isArray(e[f.labels]) ? (e[f.labels] as unknown[]).filter((l): l is string => typeof l === 'string' && /^[\w .+#-]{1,40}$/.test(l)).slice(0, 10) : [];
    entries.push({
      id,
      text: body,
      title: f.title ? text(e[f.title], 120) : null,
      partial: !!(f.partial && e[f.partial] === true),
      by: f.by ? handle(e[f.by]) : null,
      byUrl: address(f.byUrl ? e[f.byUrl] : undefined),
      link,
      cover: address(f.cover ? e[f.cover] : undefined, config.media ?? []),
      motion: config.motion ? address(config.motion.replace('{id}', encodeURIComponent(id)), config.media ?? []) : null,
      category: f.category ? text(e[f.category], 40) : null,
      labels,
      // a post on X tells when it was made; otherwise, when the collection took it in
      at: postTime(link) ?? added,
    });
  }
  return { entries, rejected };
}

/** The tags of a group of entries: those its config gives their categories and labels, then any its title earns; at most three. */
function tagsOf(group: Entry[], config: PromptSourceConfig, known: Set<string>, auto: string[]): string[] {
  const out: string[] = [];
  for (const e of group) {
    for (const key of [e.category, ...e.labels]) for (const t of (key && config.tags?.[key]) || []) if (known.has(t) && !out.includes(t)) out.push(t);
  }
  for (const t of auto) if (!out.includes(t)) out.push(t);
  return out.slice(0, 3);
}

/**
 * Import one prompt collection at its default branch's latest commit, as
 * importRepo does a skill repository (same result, `skills` counting
 * prompts): nothing is done when that commit was imported already, unless
 * `force`; saving stops at the deadline `until`, and items gone from the
 * collection are retired only once all are saved.
 */
export async function importPrompts(
  env: Env,
  fullName: string,
  config: PromptSourceConfig,
  lastCommit: string | null,
  force = false,
  until?: number,
): Promise<RepoResult> {
  if (config.reader !== 'json' || !config.file || !config.fields?.text) throw new Error(`${fullName}: not a prompt collection this importer reads`);
  const repo = await gh<Repo>(env, `/repos/${fullName}`);
  const commit = await gh<{ sha: string; commit: { committer?: { date?: string } } }>(env, `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`);
  const result: RepoResult = { commit: commit.sha, changed: false, skills: 0, created: 0, updated: 0, retired: 0, remaining: 0, rejected: [] };
  if (!force && commit.sha === lastCommit) return result;
  result.changed = true;

  const file = config.file.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${commit.sha}/${file}`, {
    headers: { 'User-Agent': 'spacering.net-harness' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${repo.full_name}: ${config.file} answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE) throw new Error(`${repo.full_name}: ${config.file} too large`);
  const raw = await res.text();
  if (raw.length > MAX_FILE) throw new Error(`${repo.full_name}: ${config.file} too large`);
  const { entries, rejected } = await readEntries(JSON.parse(raw), config);
  result.rejected = rejected;

  // one item per prompt: the same text (apart from case and spacing) is the same prompt, a part of one is not
  const byText = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = `${e.partial ? 'part' : 'full'}:${promptKey(e.text)}`;
    byText.set(key, [...(byText.get(key) ?? []), e]);
  }
  const earliest = (e: Entry) => e.at ?? '9999';
  const groups = [...byText.values()].map((g) => g.sort((a, b) => (earliest(a) < earliest(b) ? -1 : earliest(a) > earliest(b) ? 1 : a.id < b.id ? -1 : 1)));
  groups.sort((a, b) => (earliest(a[0]) < earliest(b[0]) ? -1 : earliest(a[0]) > earliest(b[0]) ? 1 : 0));

  // An item is known by one of its entries: the one it was known by before, if it has one still
  // (so an edited prompt, or one more result, keeps the item and its address), else its first.
  const db = env.HARNESS_DB;
  const prefix = `github:${repo.full_name.toLowerCase()}:${config.file}#`;
  const { results: before } = await db
    .prepare('SELECT source_key FROM items WHERE source_key >= ?1 AND source_key < ?2')
    .bind(prefix, `${prefix}\u{10FFFF}`)
    .all<{ source_key: string }>();
  const known = new Set(before.map((b) => b.source_key));
  const taken = new Set<string>();

  // pictures known to be kept already come first among a card's choices
  const pictures = [...new Set(groups.flatMap((g) => g.flatMap((e) => [e.cover, e.motion]).filter((u): u is string => !!u)))];
  const kept = new Set<string>();
  for (let i = 0; i < pictures.length; i += 90) {
    const chunk = pictures.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT url FROM media WHERE status = 'ok' AND url IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`)
      .bind(...chunk)
      .all<{ url: string }>();
    for (const r of results) kept.add(r.url);
  }

  const [{ rules, hash }, tags] = await Promise.all([loadRules(db), loadTags(db)]);
  const tagIds = new Set(tags.map((t) => t.id));
  const license = config.rights === 'creators' ? null : spdx(config.rights);
  const publisher = { kind: 'github' as const, handle: repo.owner.login.toLowerCase(), name: repo.owner.login, githubLogin: repo.owner.login, githubId: repo.owner.id };
  const inputs: VersionInput[] = [];
  for (const group of groups) {
    const first = group[0];
    const own = group.find((e) => known.has(prefix + e.id) && !taken.has(prefix + e.id)) ?? first;
    const sourceKey = prefix + own.id;
    taken.add(sourceKey);

    const secrets = scanSecrets('PROMPT.md', first.text);
    // a prompt with a credential in it is not copied here, and what is shown of it has it taken out
    const body = secrets.length ? redactSecrets(first.text) : first.text;
    const title = localize(first.title ?? promptTitle(body));
    const showcases: Showcase[] = group.map((e) => ({
      by: e.by ? { name: e.by, url: e.byUrl } : null,
      link: e.link,
      cover: e.cover,
      motion: e.motion,
      category: e.category,
      ...(e.category && config.categories?.[e.category] ? { categoryName: config.categories[e.category] } : {}),
      labels: e.labels,
      at: e.at,
    }));
    const meta: PromptMeta = {
      // named after the entry it is known by (a new item may get a suffix, when the name is taken)
      name: toName(own.id, 'prompt'),
      text: body,
      model: config.model ?? null,
      argumentHint: null,
      partial: first.partial,
      rights: config.rights === 'creators' ? 'creators' : 'license',
      lang: promptLang(body),
    };
    const content = promptFileOf(meta, showcases);
    const files: PackageFile[] = [{ path: 'PROMPT.md', data: new TextEncoder().encode(content), executable: false }];
    const findings = [...scanStructure(files), ...applyRules(rules, files)];
    const itemTags = tagsOf(group, config, tagIds, autoTags(tags, { name: '', title: title.en ?? title.zh, summary: promptExcerpt(body, 300) }));
    const reasons = [...(first.partial ? ['prompt_partial'] : []), ...(body.length < MIN_TEXT ? ['prompt_short'] : [])];
    const checks: Checks = {
      format: { errors: [], warnings: [], dropped: [] },
      secrets,
      findings,
      rules: hash,
      quality: { reasons, score: 1 },
      review: 'off',
      checkedAt: new Date().toISOString(),
    };
    // the results with pictures already kept first, then by time
    const faces = [...group]
      .sort((a, b) => Number(!!b.motion && kept.has(b.motion)) - Number(!!a.motion && kept.has(a.motion)) || Number(!!b.cover && kept.has(b.cover)) - Number(!!a.cover && kept.has(a.cover)))
      .filter((e) => e.cover)
      .slice(0, FACES)
      .map((e) => ({ cover: e.cover, motion: e.motion }));
    const card: StoredPromptCard = { excerpt: promptExcerpt(body), faces, model: meta.model, by: first.by, results: group.length, partial: first.partial };
    inputs.push({
      sourceKey,
      source: 'github',
      publisher,
      name: meta.name,
      kind: 'prompt',
      listing: listingOf(title, {}, itemTags),
      repositoryUrl: repo.html_url,
      websiteUrl: null,
      license,
      runtime: 'none',
      // a part of a prompt is not a copy of the whole one
      dedupeKey: `prompt:${first.partial ? 'part:' : ''}${await sha256(promptKey(first.text))}`,
      owns: false,
      version: null,
      // what the version is: its file, its results and its listing (not the order its card picks pictures in)
      contentSha256: await sha256(`${content}\n${JSON.stringify({ showcases, tags: itemTags, title })}`),
      sourceCommit: commit.sha,
      sourceUrl: `${repo.html_url}/blob/${commit.sha}/${config.file}`,
      files,
      hosted: !secrets.length,
      metadata: { prompt: meta, showcases, repository: repo.full_name, path: config.file, entries: group.map((e) => e.id) },
      permissions: { declared: {}, detected: emptyPermissions() },
      checks,
      packages: [],
      readme: null,
      excerpt: secrets.length ? null : promptExcerpt(body, 2000),
      versionAt: group.reduce<string | null>((latest, e) => (e.at && (!latest || e.at > latest) ? e.at : latest), null) ?? commit.commit.committer?.date ?? new Date().toISOString(),
      risk: riskOf(findings),
      repoStars: repo.stargazers_count,
      card,
      // each result made with it lifts it a little: 36 results, about as much as six times the stars
      boost: group.length > 1 ? Math.round(0.5 * Math.log10(group.length) * 1000) / 1000 : 0,
    });
  }
  result.skills = inputs.length;

  // the pictures, for the media job to copy (each address once)
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < pictures.length; i += 45) {
    const chunk = pictures.slice(i, i + 45);
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO media (url, created_at) VALUES ${chunk.map((_, j) => `(?${j + 2}, ?1)`).join(', ')}`).bind(now, ...chunk),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));

  // the collection's items are one per prompt already: those saved before hold no prompt against it (they may be
  // changing or leaving now), while another source's copy of a prompt still makes this one a copy
  const saved = await saveVersions(env, inputs, until, prefix);
  result.created = saved.created;
  result.updated = saved.updated;
  result.remaining = saved.remaining;
  if (result.remaining) return result;

  // prompts that were in this collection before and are gone now
  const { results: shown } = await db
    .prepare("SELECT source_key FROM items WHERE source_key >= ?1 AND source_key < ?2 AND status NOT IN ('retired', 'removed')")
    .bind(prefix, `${prefix}\u{10FFFF}`)
    .all<{ source_key: string }>();
  result.retired = await retireItems(db, shown.map((s) => s.source_key).filter((k) => !taken.has(k)));
  return result;
}
