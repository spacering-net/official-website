import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem, getReleases, getVersion, getVersions, listItems, resolveInstalled } from '../../api/harness/catalog.ts';
import { importRepo, notesFromFiles } from '../../api/harness/importers/github.ts';
import { folderProblem, mcpPinned, pluginSpecs, readPlugin, within } from '../../api/harness/plugin.ts';
import { reconcile } from '../../api/harness/reconcile.ts';
import { rescan } from '../../api/harness/rescan.ts';
import { searchIds } from '../../api/harness/search.ts';
import { saveVersions } from '../../api/harness/store.ts';
import { runJob } from '../../api/harness/jobs.ts';
import { tarGz, testEnv, versionInput } from './env.mjs';

// Plugins (docs/harness-plugins.md): reading them, saving them staged, and the reconcile that alone moves
// a plugin and its members on and off the shelves.

const enc = new TextEncoder();
const file = (path, text, executable = false) => ({ path, data: enc.encode(text), executable });
const skill = (name, body = 'Do the thing.', extra = '') => `---\nname: ${name}\ndescription: ${name} does a careful thing for you when asked.${extra}\n---\n# ${name}\n${body}\n`;

const HOOKS = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start' }] }] } });

/** A superpowers-like repository: one plugin at the root, with a SessionStart hook and three skills. */
const superpowers = (over = {}) => ({
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'superpowers', version: '7.0.2', description: 'Core skills library: TDD, debugging, collaboration patterns.' }),
  '.claude-plugin/marketplace.json': JSON.stringify({ name: 'dev', plugins: [{ name: 'superpowers', source: './', version: '7.0.2' }] }),
  '.codex-plugin/plugin.json': JSON.stringify({ name: 'superpowers', version: '7.0.2', skills: './skills/', hooks: {}, interface: { displayName: 'Superpowers', shortDescription: 'Planning, TDD and debugging workflows' } }),
  'hooks/hooks.json': HOOKS,
  'hooks/run-hook.cmd': ': << CMDBLOCK\n@echo off\nCMDBLOCK\nexec bash "$(dirname "$0")/$1"\n',
  'hooks/session-start': '#!/usr/bin/env bash\necho "{}"\n',
  '.opencode/plugins/superpowers.js': 'export default { id: "superpowers", setup() {} };\n',
  'index.js': 'export { default } from "./.opencode/plugins/superpowers.js";\n',
  'package.json': JSON.stringify({ name: 'superpowers', version: '7.0.2', type: 'module' }),
  'LICENSE': 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy',
  'README.md': '# Superpowers\nAn agentic skills framework.\n',
  'RELEASE-NOTES.md': '# Release notes\n\n## v7.0.2 (2026-11-03)\n\n- Brainstorming asks fewer questions.\n\n## v7.0.1\n\n- Fixes.\n',
  'skills/brainstorming/SKILL.md': skill('brainstorming', 'Then use superpowers:writing-plans.'),
  'skills/writing-plans/SKILL.md': skill('writing-plans', 'Then use superpowers:executing-plans.'),
  'skills/executing-plans/SKILL.md': skill('executing-plans'),
  'tests/fixtures/SKILL.md': skill('fixture'),
  ...over,
});

/**
 * A repository on a fake GitHub: commits (each a set of files), releases and tags, served as the API,
 * the tree, raw files and the tarball. `repo.commit(files)` adds a commit on the default branch.
 */
function fakeGithub(t, name = 'obra/superpowers') {
  const [owner] = name.split('/');
  const commits = [];
  const state = { releases: [], tags: [], stars: 1000 };
  const byRef = (ref) => commits.find((c) => c.sha === ref) ?? (ref === 'main' ? commits[commits.length - 1] : commits.find((c) => state.tags.some((t) => t.name === ref && t.sha === c.sha)));
  const repo = {
    state,
    commit(files) {
      const sha = (commits.length + 1).toString(16).padStart(40, 'a');
      commits.push({ sha, files, date: `2026-11-0${Math.min(9, commits.length + 1)}T00:00:00Z` });
      return sha;
    },
    release(tag, sha, body = null) {
      state.tags.push({ name: tag, sha });
      state.releases.unshift({ tag_name: tag, html_url: `https://github.com/${name}/releases/tag/${tag}`, body, published_at: '2026-11-03T00:00:00Z', draft: false, prerelease: false });
    },
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    const api = `https://api.github.com/repos/${name}`;
    if (u === api) return Response.json({ full_name: name, html_url: `https://github.com/${name}`, default_branch: 'main', stargazers_count: state.stars, archived: false, license: { spdx_id: 'MIT' }, owner: { id: 7, login: owner, type: 'User' } });
    if (u.startsWith(`${api}/commits/`)) {
      const c = byRef(decodeURIComponent(u.slice(`${api}/commits/`.length)));
      return c ? Response.json({ sha: c.sha, commit: { committer: { date: c.date } } }) : new Response('', { status: 404 });
    }
    if (u.startsWith(`${api}/git/trees/`)) {
      const c = byRef(u.slice(`${api}/git/trees/`.length).split('?')[0]);
      return Response.json({ truncated: false, tree: Object.entries(c.files).map(([path, text]) => ({ path, type: 'blob', size: text.length, mode: '100644' })) });
    }
    if (u === `${api}/releases/latest`) return state.releases.length ? Response.json(state.releases[0]) : new Response('', { status: 404 });
    if (u.startsWith(`${api}/releases?`)) return Response.json(state.releases);
    if (u.startsWith(`${api}/tags`)) return Response.json(state.tags.map((t) => ({ name: t.name, commit: { sha: t.sha } })));
    if (u.startsWith(`${api}/compare/`)) {
      const [a, b] = u.slice(`${api}/compare/`.length).split('...');
      const ia = commits.findIndex((c) => c.sha === a);
      const ib = commits.findIndex((c) => c.sha === b);
      return Response.json({ status: ia === ib ? 'identical' : ib > ia ? 'ahead' : 'behind' });
    }
    const raw = `https://raw.githubusercontent.com/${name}/`;
    if (u.startsWith(raw)) {
      const [sha, ...rest] = u.slice(raw.length).split('/');
      const text = byRef(sha)?.files[rest.map(decodeURIComponent).join('/')];
      return text === undefined ? new Response('', { status: 404 }) : new Response(text);
    }
    const tgz = `https://codeload.github.com/${name}/tar.gz/`;
    if (u.startsWith(tgz)) {
      const c = byRef(u.slice(tgz.length));
      return new Response(await tarGz(`${name.replace('/', '-')}-${c.sha.slice(0, 7)}`, c.files));
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return repo;
}

const SOURCE = 'github:obra/superpowers';
const KEY = `${SOURCE}:plugin:superpowers`;
const item = (env, key) => env.HARNESS_DB.rows('SELECT * FROM items WHERE source_key = ?', key)[0];
const member = (env, dir) => item(env, `${SOURCE}:${dir}`);
const found = async (env, q) => (await searchIds(env.HARNESS_DB, q, {})).map((h) => h.id);

/** Add the source, import it the way the job does (recording the run), then reconcile. */
async function sync(env, { force = false, config = {}, pin = false } = {}) {
  const db = env.HARNESS_DB;
  // the source is one of those the migrations add ({"paths":["skills"]})
  if (Object.keys(config).length) db.sqlite.prepare('UPDATE import_sources SET config = ? WHERE id = ?').run(JSON.stringify(config), SOURCE);
  env.sent.length = 0;
  await runJob(env, { type: 'github.repo', source: SOURCE, force, pin });
  for (const job of [...env.sent]) if (job.type === 'github.reconcile') await runJob(env, job);
}

const envWith = (flag) => ({ ...testEnv(), HARNESS_PLUGINS: flag });

// ---------------------------------------------------------------------------
// reading plugins

test('a marketplace names plugins in folders of the repository; others, and paths out of it, are not taken', () => {
  const paths = new Set(['plugins/a/x.md', 'plugins/b/.claude-plugin/plugin.json', 'skills/one/SKILL.md', 'skills/two/SKILL.md']);
  const market = JSON.stringify({
    plugins: [
      { name: 'a', source: './plugins/a' },
      { name: 'b', source: 'plugins/b' },
      { name: 'far', source: { source: 'git-subdir', url: 'https://github.com/x/y.git', path: 'p' } },
      { name: 'up', source: '../elsewhere' },
      { name: 'gone', source: './plugins/missing' },
      { name: 'docs', source: './', strict: false, skills: ['./skills/one'] },
    ],
  });
  const { specs, problems } = pluginSpecs(paths, new Map([['.claude-plugin/marketplace.json', market]]));
  assert.deepEqual(specs.map((s) => [s.name, s.root, s.skills]), [['a', 'plugins/a', null], ['b', 'plugins/b', null], ['docs', '', ['skills/one']]]);
  assert.deepEqual(problems, [{ plugin: 'up', reason: 'outside_repository' }, { plugin: 'gone', reason: 'missing_folder' }]);
  // Codex's marketplace adds what Claude Code's does not name
  const codex = JSON.stringify({ plugins: [{ name: 'a', source: { source: 'local', path: './plugins/b' } }, { name: 'c', source: { source: 'url', url: './' } }] });
  const both = pluginSpecs(paths, new Map([['.claude-plugin/marketplace.json', market], ['.agents/plugins/marketplace.json', codex]]));
  assert.deepEqual(both.specs.map((s) => [s.name, s.root]), [['a', 'plugins/a'], ['b', 'plugins/b'], ['docs', ''], ['c', '']]);
  // a repository that is one plugin, without a marketplace
  assert.deepEqual(pluginSpecs(new Set(['.codex-plugin/plugin.json', 'skills/x/SKILL.md']), new Map()).specs.map((s) => s.root), ['']);
  assert.deepEqual(pluginSpecs(new Set(['package.json']), new Map([['package.json', '{"pi":{"extensions":["./x.ts"]}}']])).specs.map((s) => s.root), ['']);
  assert.deepEqual(pluginSpecs(new Set(['package.json']), new Map([['package.json', '{"name":"lib"}']])).specs, []);
  assert.equal(within('a', '../b'), null);
  assert.equal(within('a', '/etc'), null);
  assert.equal(within('a', 'https://x'), null);
  assert.equal(within('a/b', './c/../d'), null);
});

test('a plugin too big for a package, or with a link in it, is not taken whole', () => {
  const tree = [{ path: 'p/a', type: 'blob', size: 10, mode: '100644' }];
  assert.equal(folderProblem('p', tree), null);
  assert.equal(folderProblem('p', [...tree, { path: 'p/l', type: 'blob', size: 1, mode: '120000' }]), 'link');
  assert.equal(folderProblem('p', Array.from({ length: 501 }, (_, i) => ({ path: `p/${i}`, type: 'blob', size: 1 }))), 'too_many_files');
  assert.equal(folderProblem('p', [{ path: 'p/big', type: 'blob', size: 31 * 1024 * 1024 }]), 'too_large');
});

test('what runs on its own: hooks per host, code entries, the files commands name; members, without tests', async () => {
  const files = Object.entries(superpowers()).map(([p, t]) => file(p, t, p.startsWith('hooks/') && p !== 'hooks/hooks.json'));
  const d = await readPlugin({ name: 'superpowers', root: '', order: 0, entry: { name: 'superpowers', source: './' }, skills: null }, files);
  assert.equal(d.name, 'superpowers');
  assert.equal(d.version, '7.0.2');
  assert.equal(d.title, 'Superpowers');
  assert.equal(d.description, 'Planning, TDD and debugging workflows');
  assert.equal(d.whole, true);
  assert.deepEqual(d.why, ['autorun', 'depends']);
  // Claude Code runs the hook; Codex's manifest says it has none; OpenCode loads code
  assert.deepEqual(d.hosts.map((h) => [h.host, h.hooks, h.code]), [['claude', 1, 0], ['codex', 0, 0], ['opencode', 0, 2]]);
  assert.deepEqual(d.autorun.filter((p) => p.type === 'hook').map((p) => [p.host, p.event]), [['claude', 'SessionStart']]);
  assert.deepEqual(d.autorunFiles, ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.opencode/plugins/superpowers.js', 'hooks/hooks.json', 'hooks/run-hook.cmd', 'hooks/session-start', 'index.js']);
  assert.deepEqual(d.components.map((c) => c.name), ['brainstorming', 'executing-plans', 'writing-plans']);
  assert.match(d.execSha256, /^[0-9a-f]{64}$/);
  // Markdown changing leaves what is executed alone; a script changing does not
  const again = async (over) => (await readPlugin({ name: 'superpowers', root: '', order: 0, entry: null, skills: null }, Object.entries(superpowers(over)).map(([p, t]) => file(p, t)))).execSha256;
  const base = await again({});
  assert.equal(await again({ 'README.md': '# Superpowers\nNew words.\n' }), base);
  assert.notEqual(await again({ 'hooks/session-start': '#!/usr/bin/env bash\necho "{ }"\n' }), base);
  // the source's word wins
  assert.equal((await readPlugin({ name: 'superpowers', root: '', order: 0, entry: null, skills: null }, files, 'split')).whole, false);
});

test('members that name one another make a plugin whole: in the body, in frontmatter, by the plugin root; else its skills stay apart', async () => {
  const spec = { name: 'agenthub', root: '', order: 0, entry: null, skills: null };
  // frontmatter only: an agent that loads the plugin's own skill by the plugin's name
  const agenthub = [
    file('.claude-plugin/plugin.json', '{"name":"agenthub"}'),
    file('skills/agenthub/SKILL.md', skill('agenthub')),
    file('agents/hub-coordinator.md', '---\nname: hub-coordinator\ndescription: Coordinates the hub.\nskills: [agenthub:agenthub]\n---\nYou coordinate.\n'),
  ];
  const a = await readPlugin(spec, agenthub);
  assert.deepEqual([a.whole, a.why], [true, ['depends']]);
  // naming itself is not depending on others
  const alone = await readPlugin(spec, [file('.claude-plugin/plugin.json', '{"name":"agenthub"}'), file('skills/one/SKILL.md', skill('one', 'Like agenthub:one says.')), file('skills/two/SKILL.md', skill('two'))]);
  assert.deepEqual([alone.whole, alone.why], [false, []]);
  const root = await readPlugin(spec, [file('.claude-plugin/plugin.json', '{"name":"x"}'), file('skills/one/SKILL.md', skill('one', 'Run ${CLAUDE_PLUGIN_ROOT}/bin/x.'))]);
  assert.equal(root.whole, true);
  // nothing to install on its own: not a plugin, whatever it says
  assert.equal((await readPlugin(spec, [file('.claude-plugin/plugin.json', '{"name":"x"}'), file('hooks/hooks.json', HOOKS)])).whole, false);
});

test('an MCP server is pinned when what it fetches has an exact version, or it is a public https address', () => {
  assert.equal(mcpPinned({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }), false);
  assert.equal(mcpPinned({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.41'] }), true);
  assert.equal(mcpPinned({ command: 'npx', args: ['some-server'] }), false);
  assert.equal(mcpPinned({ command: 'uvx', args: ['mcp-server-git==2025.1.14'] }), true);
  assert.equal(mcpPinned({ command: 'uvx', args: ['--from', 'git+https://x', 'tool'] }), false);
  assert.equal(mcpPinned({ command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/x/y:latest'] }), false);
  assert.equal(mcpPinned({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] }), true);
  assert.equal(mcpPinned({ type: 'http', url: 'https://mcp.example.com/sse' }), true);
  assert.equal(mcpPinned({ type: 'http', url: 'http://localhost:3000' }), false);
});

test('release notes from the repository: the section that names the version', () => {
  const files = [file('RELEASE-NOTES.md', superpowers()['RELEASE-NOTES.md'])];
  assert.equal(notesFromFiles(files, '7.0.2'), '- Brainstorming asks fewer questions.');
  assert.equal(notesFromFiles(files, '7.0.1'), '- Fixes.');
  assert.equal(notesFromFiles(files, '7.0'), null);
});

// ---------------------------------------------------------------------------
// importing and reconciling

test('with the switch off: the plugin is only listed, its members stay on the shelves, and members get its version', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const p = item(env, KEY);
  assert.equal(p.kind, 'plugin');
  assert.equal(p.status, 'listed');
  assert.deepEqual(JSON.parse(p.listed_reasons), ['plugins_off']);
  assert.equal(p.name, 'superpowers');
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
  const label = env.HARNESS_DB.rows('SELECT v.version FROM items i JOIN item_versions v ON v.id = i.latest_version_id WHERE i.source_key = ?', `${SOURCE}:skills/brainstorming`)[0];
  assert.equal(label.version, '7.0.2');
  // reachable by its address only
  const detail = await getItem(env.HARNESS_DB, 'obra', 'superpowers');
  assert.equal(detail.kind, 'plugin');
  assert.equal(detail.latest.version, '7.0.2');
  assert.deepEqual(detail.install.plugin.components.map((c) => c.name), ['brainstorming', 'executing-plans', 'writing-plans']);
  assert.equal(detail.install.plugin.full, null);
  assert.equal(detail.install.plugin.notFull, 'pending_review');
  assert.deepEqual(detail.permissions.detected.hooks, ['claude · SessionStart · "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start']);
  assert.deepEqual((await listItems(env.HARNESS_DB, { q: 'superpowers' })).items.map((i) => i.kind).filter((k) => k === 'plugin'), []);
  // its releases: from the repository's notes when GitHub has none
  const releases = await getReleases(env.HARNESS_DB, 'obra', 'superpowers');
  assert.deepEqual(releases.map((r) => [r.version, r.revision]), [['7.0.2', 1]]);
});

test('with the switch on: the plugin is out and its members are deleted, in one reconcile; off again, they are back as they were', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const p = item(env, KEY);
  assert.equal(p.status, 'public');
  for (const dir of ['skills/brainstorming', 'skills/writing-plans', 'skills/executing-plans']) {
    const m = member(env, dir);
    assert.equal(m.status, 'deleted', dir);
    assert.equal(m.covered_by, p.id);
  }
  // new ones are made deleted at saving, never shown first
  assert.equal(member(env, 'skills/brainstorming').covered_status, 'public');
  // a member's name finds the plugin; the member is no item to anyone
  assert.deepEqual(await found(env, 'brainstorming'), [p.id]);
  assert.equal(await getItem(env.HARNESS_DB, 'obra', 'brainstorming'), null);
  const b = member(env, 'skills/brainstorming');
  assert.deepEqual(await resolveInstalled(env.HARNESS_DB, [{ id: b.id, revision: 1 }]), [{ id: b.id, status: 'unavailable' }]);

  // the switch off: everything back, the same ids and revisions
  env.HARNESS_PLUGINS = 'off';
  await reconcile(env, SOURCE);
  assert.equal(item(env, KEY).status, 'listed');
  const back = member(env, 'skills/brainstorming');
  assert.deepEqual([back.id, back.status, back.latest_revision, back.covered_by, back.covered_status], [b.id, 'public', 1, null, null]);
  assert.ok((await found(env, 'brainstorming')).includes(b.id));
  assert.ok(!(await found(env, 'brainstorming')).includes(p.id));
});

test('items that were public before the switch: taken off at the reconcile, holding their copies off the shelves', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  // a copy of brainstorming elsewhere stays listed while the member holds the key, deleted or not
  const copy = versionInput({ name: 'brainstorming', sourceKey: 'github:copier/x:brainstorming', publisher: { kind: 'github', handle: 'copier', name: 'copier' }, dedupeKey: member(env, 'skills/brainstorming').dedupe_key, owns: false });
  await saveVersions(env, [copy]);
  assert.equal(item(env, copy.sourceKey).status, 'listed');
  env.HARNESS_PLUGINS = 'on';
  await reconcile(env, SOURCE);
  assert.equal(member(env, 'skills/brainstorming').status, 'deleted');
  await saveVersions(env, [{ ...copy, contentSha256: 'c9' }]);
  assert.equal(item(env, copy.sourceKey).status, 'listed');
  env.HARNESS_PLUGINS = 'off';
  await reconcile(env, SOURCE);
  env.HARNESS_PLUGINS = 'on';
  await reconcile(env, SOURCE);
  await saveVersions(env, [{ ...copy, contentSha256: 'c10' }]);
  assert.equal(item(env, copy.sourceKey).status, 'listed');
  assert.equal(member(env, 'skills/brainstorming').status, 'deleted');
});

test('a new version is staged: nobody sees it until the reconcile; an import cut short changes nothing', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const p = item(env, KEY);
  gh.commit(superpowers({ 'skills/brainstorming/SKILL.md': skill('brainstorming', 'Fewer questions. Then superpowers:writing-plans.') }));
  // saved, but no run recorded: the reconcile has nothing new
  env.sent.length = 0;
  const last = env.HARNESS_DB.rows('SELECT synced_ref FROM import_sources WHERE id = ?', SOURCE)[0].synced_ref;
  const result = await importRepo(env, 'obra/superpowers', {}, last, false, undefined, { plugins: true });
  assert.ok(result.run);
  const staged = env.HARNESS_DB.rows("SELECT revision FROM item_versions WHERE item_id = ? AND status = 'staged'", p.id);
  assert.deepEqual(staged.map((r) => r.revision), [2]);
  assert.equal(item(env, KEY).latest_revision, 1);
  assert.deepEqual((await getVersions(env.HARNESS_DB, 'obra', 'superpowers')).map((v) => v.revision), [1]);
  assert.equal(await getVersion(env.HARNESS_DB, 'obra', 'superpowers', 2), null);
  assert.equal((await resolveInstalled(env.HARNESS_DB, [{ id: p.id, revision: 2 }]))[0].installed, null);
  await reconcile(env, SOURCE);
  assert.equal(item(env, KEY).latest_revision, 1);
  // the job records the run and reconciles it
  await sync(env);
  assert.equal(item(env, KEY).latest_revision, 2);
  assert.deepEqual((await getVersions(env.HARNESS_DB, 'obra', 'superpowers')).map((v) => v.revision), [2, 1]);
  // the abandoned staged revision is not used again: revisions only grow
  gh.commit(superpowers({ 'skills/brainstorming/SKILL.md': skill('brainstorming', 'Third.') }));
  await sync(env);
  assert.equal(item(env, KEY).latest_revision, 3);
});

test('a reconcile overtaken by a newer import, or holding no lease, changes nothing', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  env.sent.length = 0;
  await runJob(env, { type: 'github.repo', source: SOURCE });
  const job = env.sent.find((j) => j.type === 'github.reconcile');
  // another reconcile holds the source
  env.HARNESS_DB.sqlite.prepare("UPDATE import_sources SET lease = 'other', lease_until = '2999-01-01' WHERE id = ?").run(SOURCE);
  assert.equal((await reconcile(env, SOURCE, job.run)).status, 'busy');
  env.HARNESS_DB.sqlite.prepare('UPDATE import_sources SET lease = NULL, lease_until = NULL WHERE id = ?').run(SOURCE);
  // a newer run took its place
  env.HARNESS_DB.sqlite.prepare("UPDATE import_sources SET staged_run = 'newer' WHERE id = ?").run(SOURCE);
  assert.equal((await reconcile(env, SOURCE, job.run)).status, 'stale');
  assert.equal(item(env, KEY).status, 'draft');
  assert.equal(member(env, 'skills/brainstorming').status, 'deleted'); // made so at saving, waiting for the reconcile
  // the run changes under a reconcile at work: its batch fails whole
  env.HARNESS_DB.sqlite.prepare('UPDATE import_sources SET staged_run = ? WHERE id = ?').run(job.run, SOURCE);
  env.HARNESS_DB.beforeBatch = () => {
    env.HARNESS_DB.sqlite.prepare("UPDATE import_sources SET staged_run = 'newer' WHERE id = ?").run(SOURCE);
    env.HARNESS_DB.beforeBatch = null;
  };
  assert.equal((await reconcile(env, SOURCE, job.run)).status, 'stale');
  assert.equal(item(env, KEY).status, 'draft');
});

test('a plugin gone from its repository is retired and its members come back; a member gone while held stays deleted', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const files = superpowers();
  delete files['skills/executing-plans/SKILL.md'];
  gh.commit(files);
  await sync(env);
  const gone = member(env, 'skills/executing-plans');
  assert.deepEqual([gone.status, JSON.parse(gone.listed_reasons), gone.covered_by], ['deleted', ['gone'], null]);
  // no plugin any more: the plugin is retired, the members back; the gone one is not
  const plain = { ...files };
  for (const k of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', 'package.json']) delete plain[k];
  gh.commit(plain);
  await sync(env);
  assert.equal(item(env, KEY).status, 'retired');
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
  assert.equal(member(env, 'skills/executing-plans').status, 'deleted');
  // and if it comes back on its own, it is an item again
  gh.commit({ ...plain, 'skills/executing-plans/SKILL.md': skill('executing-plans') });
  await sync(env);
  assert.equal(member(env, 'skills/executing-plans').status, 'public');
  assert.equal(member(env, 'skills/executing-plans').id, gone.id);
});

test('a plugin no longer used whole is deleted and gives its members back; one waiting for review takes none', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  await sync(env, { force: true, pin: true, config: { paths: ['skills'], plugins: { superpowers: 'split' } } });
  assert.equal(item(env, KEY).status, 'deleted');
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
});

test('a plugin waiting for review takes no members; rescans and approvals move only through the reconcile', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  // a rule that makes the hook's script high risk
  env.HARNESS_DB.sqlite
    .prepare("INSERT INTO rules (id, category, severity, scope, pattern, flags, message_en, message_zh, created_at, updated_at) VALUES ('t1', 'test', 'high', 'text', 'echo \"\\{\\}\"', '', 'x', 'x', 'x', 'x')")
    .run();
  await sync(env);
  assert.equal(item(env, KEY).status, 'pending');
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
  // the rule goes: the rescan checks the plugin again and has its source reconciled
  env.HARNESS_DB.sqlite.prepare("DELETE FROM rules WHERE id = 't1'").run();
  env.sent.length = 0;
  await rescan(env);
  assert.equal(item(env, KEY).status, 'pending');
  for (const job of [...env.sent]) if (job.type === 'github.reconcile') await runJob(env, job);
  assert.equal(item(env, KEY).status, 'public');
  assert.equal(member(env, 'skills/brainstorming').status, 'deleted');
});

test('installing whole needs an approved package; a newer revision waiting keeps the approved one', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const p = item(env, KEY);
  let info = await getVersion(env.HARNESS_DB, 'obra', 'superpowers', 1);
  assert.deepEqual([info.plugin.approved, info.plugin.full, info.plugin.notFull], [false, null, 'pending_review']);
  const [before] = await resolveInstalled(env.HARNESS_DB, [{ id: p.id, revision: 1 }]);
  const sha = env.HARNESS_DB.rows('SELECT content_sha256 FROM item_versions WHERE item_id = ? AND revision = 1', p.id)[0].content_sha256;
  env.HARNESS_DB.sqlite.prepare("INSERT INTO exec_approvals (content_sha256, approved_by, approved_at) VALUES (?, 'test', 'x')").run(sha);
  info = await getVersion(env.HARNESS_DB, 'obra', 'superpowers', 1);
  assert.deepEqual([info.plugin.approved, info.plugin.full, info.plugin.notFull], [true, { revision: 1, version: '7.0.2' }, null]);
  // the approval is part of what /resolve hashes
  const [after] = await resolveInstalled(env.HARNESS_DB, [{ id: p.id, revision: 1 }]);
  assert.notEqual(before.installed.stateSha256, after.installed.stateSha256);
  assert.deepEqual(after.installed.plugin, { approved: true, full: { revision: 1, version: '7.0.2' }, execSha256: info.plugin.execSha256 });
  // a new revision, not approved: installing whole stays at 1
  gh.commit(superpowers({ 'hooks/session-start': '#!/usr/bin/env bash\necho "{ }"\n' }));
  await sync(env);
  info = await getVersion(env.HARNESS_DB, 'obra', 'superpowers', 2);
  assert.deepEqual([info.plugin.approved, info.plugin.full, info.plugin.notFull], [false, { revision: 1, version: '7.0.2' }, 'pending_review']);
});

test('a skill outside any plugin keeps its hash for /resolve when its version label is filled in', async () => {
  const env = envWith('off');
  await saveVersions(env, [versionInput({ version: null })]);
  const a = env.HARNESS_DB.rows("SELECT * FROM items WHERE name = 'pdf-forms'")[0];
  const [before] = await resolveInstalled(env.HARNESS_DB, [{ id: a.id, revision: 1 }]);
  env.HARNESS_DB.sqlite.prepare("UPDATE item_versions SET version = '1.2.0' WHERE item_id = ?").run(a.id);
  const [after] = await resolveInstalled(env.HARNESS_DB, [{ id: a.id, revision: 1 }]);
  assert.equal(after.installed.stateSha256, before.installed.stateSha256);
});

test('a release behind the last import is not followed back (planning-with-files: 3.28.2 imported, 3.28.1 released)', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  const files = (v) => superpowers({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'superpowers', version: v }), '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'superpowers', source: './', version: v }] }) });
  const v1 = gh.commit(files('3.28.1'));
  gh.release('v3.28.1', v1);
  const v2 = gh.commit(files('3.28.2'));
  // imported at the branch head first (as before this followed releases)
  const r = await importRepo(env, 'obra/superpowers', {}, v2, false, undefined, { lastTrack: 'head' });
  assert.deepEqual([r.commit, r.track, r.changed], [v2, 'head', false]);
  // a release after it is followed, and so on from there
  const v3 = gh.commit(files('3.29.0'));
  gh.release('v3.29.0', v3);
  gh.commit(files('3.30.0-dev'));
  const r2 = await importRepo(env, 'obra/superpowers', {}, v2, false, undefined, { lastTrack: 'head' });
  assert.deepEqual([r2.commit, r2.track], [v3, 'release']);
});

test('a renamed plugin takes its members over in the same batch as the old one leaves', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const old = item(env, KEY);
  const renamed = (files) => ({
    ...files,
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'superpowers-next', version: '8.0.0' }),
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'superpowers-next', source: './' }] }),
    '.codex-plugin/plugin.json': JSON.stringify({ name: 'superpowers-next', version: '8.0.0', hooks: {} }),
  });
  gh.commit(renamed(superpowers()));
  // every batch: a member is never on the shelves with nothing holding it
  const seen = [];
  env.HARNESS_DB.beforeBatch = () => seen.push(member(env, 'skills/brainstorming').status);
  await sync(env);
  env.HARNESS_DB.beforeBatch = null;
  const next = item(env, `${SOURCE}:plugin:superpowers-next`);
  assert.equal(item(env, KEY).status, 'retired');
  assert.equal(next.status, 'public');
  assert.equal(member(env, 'skills/brainstorming').covered_by, next.id);
  assert.ok(seen.every((s) => s === 'deleted'));
  assert.ok(old.id !== next.id);
});

/** A repository with two plugins: `outer` at the root and `inner` in pack/, both with hooks; pack/'s skill is in both. */
const nested = (over = {}) => ({
  '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'outer', source: './' }, { name: 'inner', source: './pack' }] }),
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'outer', version: '1.0.0' }),
  'hooks/hooks.json': HOOKS,
  'hooks/run-hook.cmd': 'echo\n',
  'LICENSE': 'MIT License',
  'pack/.claude-plugin/plugin.json': JSON.stringify({ name: 'inner', version: '2.0.0' }),
  'pack/hooks/hooks.json': HOOKS,
  'pack/hooks/run-hook.cmd': 'echo inner\n',
  'pack/skills/shared/SKILL.md': skill('shared'),
  ...over,
});

test('two plugins sharing a member: the first that can hold it does; if it may not, the next one', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(nested());
  await sync(env, { config: { paths: ['pack'] } });
  const outer = item(env, `${SOURCE}:plugin:outer`);
  const inner = item(env, `${SOURCE}:plugin:inner`);
  assert.deepEqual([outer.status, inner.status], ['public', 'public']);
  assert.equal(member(env, 'pack/skills/shared').covered_by, outer.id);
  // the first waits for review: the second holds it, in the same batch
  env.HARNESS_DB.sqlite
    .prepare("INSERT INTO rules (id, category, severity, scope, pattern, flags, message_en, message_zh, created_at, updated_at) VALUES ('t2', 'test', 'high', 'all', '^echo$', '', 'x', 'x', 'x', 'x')")
    .run();
  gh.commit(nested({ 'hooks/run-hook.cmd': 'echo\n\n' }));
  await sync(env, { config: { paths: ['pack'] } });
  assert.equal(item(env, `${SOURCE}:plugin:outer`).status, 'pending');
  assert.equal(member(env, 'pack/skills/shared').status, 'deleted');
  assert.equal(member(env, 'pack/skills/shared').covered_by, inner.id);
});

test('two plugins with the same package: the older holds it, and a replay decides the same', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit({
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'one', source: './' }, { name: 'two', source: './' }] }),
    'hooks/hooks.json': HOOKS,
    'hooks/run-hook.cmd': 'echo\n',
    'LICENSE': 'MIT License',
    'skills/brainstorming/SKILL.md': skill('brainstorming'),
  });
  await sync(env);
  const states = () => [item(env, `${SOURCE}:plugin:one`).status, item(env, `${SOURCE}:plugin:two`).status, member(env, 'skills/brainstorming').status];
  assert.deepEqual(states(), ['public', 'listed', 'deleted']);
  await reconcile(env, SOURCE);
  assert.deepEqual(states(), ['public', 'listed', 'deleted']);
  await reconcile(env, SOURCE);
  assert.deepEqual(states(), ['public', 'listed', 'deleted']);
});

test('a save that read a member before the reconcile moved it does not undo the move', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  env.HARNESS_PLUGINS = 'off';
  await sync(env);
  env.HARNESS_PLUGINS = 'on';
  // a save of brainstorming, paused at its file writes, while the reconcile takes it off the shelves
  let paused;
  const gate = new Promise((r) => (paused = r));
  let hit = false;
  const put = env.HARNESS_FILES.put.bind(env.HARNESS_FILES);
  env.HARNESS_FILES.put = async (key, data) => {
    if (!hit) {
      hit = true;
      await reconcile(env, SOURCE);
      paused();
    }
    return put(key, data);
  };
  const m = member(env, 'skills/brainstorming');
  await saveVersions(env, [versionInput({ name: 'brainstorming', sourceKey: m.source_key, publisher: { kind: 'github', handle: 'obra', name: 'obra' }, contentSha256: 'new' })]);
  await gate;
  const after = member(env, 'skills/brainstorming');
  assert.equal(after.status, 'deleted');
  assert.equal(after.covered_by, item(env, KEY).id);
  assert.equal(after.latest_revision, m.latest_revision + 1);
});

test('a member gone and back while the switch is on is a member again; a reconcile let go of it meanwhile', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const files = superpowers();
  delete files['skills/executing-plans/SKILL.md'];
  gh.commit(files);
  await sync(env);
  const gone = member(env, 'skills/executing-plans');
  assert.deepEqual([gone.status, gone.covered_by, gone.covered_status], ['deleted', null, null]);
  gh.commit(superpowers());
  await sync(env);
  const back = member(env, 'skills/executing-plans');
  assert.deepEqual([back.id, back.status, back.covered_by], [gone.id, 'deleted', item(env, KEY).id]);
  env.HARNESS_PLUGINS = 'off';
  await reconcile(env, SOURCE);
  assert.equal(member(env, 'skills/executing-plans').status, 'public');
});

test('a reconcile that was never queued is caught up by the next import that finds nothing new; an expired lease is not held', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  // the send after the run is recorded fails; the job is retried
  const send = env.HARNESS_JOBS.send;
  env.HARNESS_JOBS.send = async (body) => {
    if (body.type === 'github.reconcile') throw new Error('queue down');
    return send(body);
  };
  await assert.rejects(runJob(env, { type: 'github.repo', source: SOURCE }));
  env.HARNESS_JOBS.send = send;
  assert.equal(item(env, KEY).status, 'draft');
  await sync(env);
  assert.equal(item(env, KEY).status, 'public');
  // a lease past its time is taken over; one a batch finds expired fails the batch
  env.HARNESS_DB.sqlite.prepare("UPDATE import_sources SET lease = 'old', lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(SOURCE);
  assert.equal((await reconcile(env, SOURCE)).status, 'done');
});

test('staged versions are not downloadable; one that is out is', async (t) => {
  const env = { ...envWith('on'), HARNESS_LIMIT: { limit: async () => ({ success: true }) } };
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const { harnessApi } = await import('../../api/harness/routes.ts');
  const ok = env.HARNESS_DB.rows("SELECT archive_sha256 FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.source_key = ? AND v.status = 'ok'", `${SOURCE}:skills/brainstorming`)[0].archive_sha256;
  assert.equal((await harnessApi.request(`/archives/${ok}.zip`, {}, env)).status, 200);
  gh.commit(superpowers({ 'hooks/session-start': '#!/usr/bin/env bash\necho "{  }"\n' }));
  const last = env.HARNESS_DB.rows('SELECT synced_ref FROM import_sources WHERE id = ?', SOURCE)[0].synced_ref;
  await importRepo(env, 'obra/superpowers', { paths: ['skills'] }, last, false, undefined, { plugins: true });
  const staged = env.HARNESS_DB.rows("SELECT archive_sha256, id FROM item_versions WHERE status = 'staged'")[0];
  assert.equal((await harnessApi.request(`/archives/${staged.archive_sha256}.zip`, {}, env)).status, 404);
  const hook = env.HARNESS_DB.rows("SELECT sha256 FROM version_files WHERE version_id = ? AND path = 'hooks/session-start'", staged.id)[0].sha256;
  assert.equal((await harnessApi.request(`/blobs/${hook}`, {}, env)).status, 404);
});

test('installing whole: npm exec unpinned, a folder entry for OpenCode, and a path out of the plugin', async () => {
  const spec = { name: 'p', root: '', order: 0, entry: null, skills: null };
  const base = [file('.claude-plugin/plugin.json', '{"name":"p"}'), file('skills/a/SKILL.md', skill('a', 'Then p:b.')), file('skills/b/SKILL.md', skill('b'))];
  const mcp = await readPlugin(spec, [...base, file('.mcp.json', JSON.stringify({ mcpServers: { x: { command: 'npm', args: ['exec', '--yes', 'some-server'] } } }))]);
  assert.deepEqual(mcp.mcpUnpinned, ['x']);
  assert.deepEqual(mcp.packages, [{ registryType: 'npm', identifier: 'some-server', version: null }]);
  const oc = await readPlugin(spec, [...base, file('package.json', '{"name":"p","keywords":["opencode-plugin"]}'), file('index.js', 'export default {}')]);
  assert.deepEqual(oc.autorun.map((p) => [p.host, p.type, p.path]), [['opencode', 'code', 'index.js']]);
  const out = await readPlugin(spec, [file('.claude-plugin/plugin.json', '{"name":"p","hooks":"../hooks.json"}'), ...base.slice(1)]);
  assert.deepEqual(out.problems, ['outside_plugin']);
  const bad = await readPlugin(spec, [file('.claude-plugin/plugin.json', '{"name":'), ...base.slice(1)]);
  assert.deepEqual(bad.problems, ['unreadable_manifest']);
});

test('a credential in a hook command is not shown, in the permissions or the manifest kept', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  const token = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  gh.commit(superpowers({ 'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `curl -H "token: ${token}" https://x.example` }] }] } }) }));
  await sync(env);
  const detail = await getItem(env.HARNESS_DB, 'obra', 'superpowers');
  assert.ok(!JSON.stringify(detail).includes(token));
  assert.ok(!env.HARNESS_DB.rows('SELECT metadata, permissions FROM item_versions').some((r) => r.metadata.includes(token) || r.permissions.includes(token)));
});

test('search shows only what is out, whatever the index still holds', async () => {
  const env = envWith('off');
  await saveVersions(env, [versionInput()]);
  const a = env.HARNESS_DB.rows("SELECT * FROM items WHERE name = 'pdf-forms'")[0];
  // deleted without its row leaving the index (a reconcile under way, a repair not yet run)
  env.HARNESS_DB.sqlite.prepare("UPDATE items SET status = 'deleted' WHERE id = ?").run(a.id);
  assert.deepEqual(await found(env, 'pdf'), []);
  assert.deepEqual((await listItems(env.HARNESS_DB, { q: 'pdf-forms' })).items, []);
  assert.equal(await getItem(env.HARNESS_DB, 'someone', 'pdf-forms'), null);
  assert.deepEqual(await resolveInstalled(env.HARNESS_DB, [{ id: a.id, revision: 1 }]), [{ id: a.id, status: 'unavailable' }]);
});

test('the backfill labels old versions from their commit\'s plugin, and dates them by it, changing nothing else', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  const sha = gh.commit(superpowers({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'superpowers', version: '6.4.2' }) }));
  const old = versionInput({
    name: 'brainstorming',
    sourceKey: `${SOURCE}:skills/brainstorming`,
    publisher: { kind: 'github', handle: 'obra', name: 'obra' },
    version: null,
    sourceCommit: sha,
    metadata: { skill: { name: 'brainstorming', description: 'x' }, repository: 'obra/superpowers', path: 'skills/brainstorming' },
  });
  await saveVersions(env, [old]);
  env.HARNESS_DB.sqlite.prepare('UPDATE item_versions SET committed_at = NULL').run();
  const before = env.HARNESS_DB.rows('SELECT id, revision, content_sha256, status, archive_sha256 FROM item_versions');
  const { backfillVersions } = await import('../../api/harness/importers/backfill.ts');
  assert.equal(await backfillVersions(env, SOURCE), null);
  const [v] = env.HARNESS_DB.rows('SELECT version, committed_at FROM item_versions');
  assert.deepEqual({ ...v }, { version: '6.4.2', committed_at: '2026-11-01T00:00:00Z' });
  assert.deepEqual(env.HARNESS_DB.rows('SELECT id, revision, content_sha256, status, archive_sha256 FROM item_versions'), before);
});

test('migration 0008 keeps every row, id and seq, dates latest versions, and leaves foreign keys working', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../../db/harness/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations.filter((f) => f < '0008')) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.exec(`INSERT INTO publishers (id, handle, kind, name, created_at, updated_at) VALUES ('p', 'someone', 'github', 'someone', 'x', 'x')`);
  for (let n = 1; n <= 3; n++) {
    db.exec(`INSERT INTO items (id, publisher_id, name, kind, status, source, latest_version_id, latest_revision, created_at, updated_at, version_at)
             VALUES ('i${n}', 'p', 'n${n}', 'skill', 'public', 'github', 'v${n}b', 2, 'x', 'x', '2026-10-0${n}T00:00:00Z')`);
    for (const r of ['a', 'b']) {
      db.exec(`INSERT INTO item_versions (id, item_id, revision, content_sha256, metadata, permissions, checks, listing, created_at)
               VALUES ('v${n}${r}', 'i${n}', ${r === 'a' ? 1 : 2}, 'c', '{}', '{}', '{}', '{}', '2026-11-01')`);
      db.exec(`INSERT INTO version_files (version_id, path, sha256, size) VALUES ('v${n}${r}', 'SKILL.md', 's', 1)`);
    }
    db.exec(`INSERT INTO item_tags (item_id, tag_id) SELECT 'i${n}', id FROM tags LIMIT 1`);
    db.exec(`INSERT INTO item_search (rowid, name, keywords, title, summary, body) SELECT seq, name, '', '', '', '' FROM items WHERE id = 'i${n}'`);
  }
  const snap = () => ({
    items: db.prepare('SELECT seq, id, name, status, latest_version_id FROM items ORDER BY seq').all(),
    versions: db.prepare('SELECT id, item_id, revision, status FROM item_versions ORDER BY id').all(),
    files: db.prepare('SELECT * FROM version_files ORDER BY version_id').all(),
    tags: db.prepare('SELECT * FROM item_tags ORDER BY item_id').all(),
  });
  const before = snap();
  db.exec('BEGIN');
  db.exec(readFileSync(new URL('0008_plugins.sql', dir), 'utf8'));
  db.exec('COMMIT');
  assert.deepEqual(snap(), before);
  assert.deepEqual(db.prepare('SELECT id, committed_at FROM item_versions ORDER BY id').all().map((r) => [r.id, r.committed_at]), [
    ['v1a', null], ['v1b', '2026-10-01T00:00:00Z'], ['v2a', null], ['v2b', '2026-10-02T00:00:00Z'], ['v3a', null], ['v3b', '2026-10-03T00:00:00Z'],
  ]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.prepare("SELECT i.id FROM item_search s JOIN items i ON i.seq = s.rowid WHERE item_search MATCH 'n2'").all().map((r) => r.id), ['i2']);
  assert.throws(() => db.exec("INSERT INTO item_versions (id, item_id, revision, content_sha256, metadata, permissions, checks, listing, created_at) VALUES ('x', 'nobody', 1, 'c', '{}', '{}', '{}', '{}', 'x')"), /FOREIGN KEY/);
  db.exec("INSERT INTO items (id, publisher_id, name, kind, status, source, created_at, updated_at, version_at) VALUES ('pl', 'p', 'pl', 'plugin', 'draft', 'github', 'x', 'x', 'x')");
  db.exec("INSERT INTO item_versions (id, item_id, revision, status, content_sha256, metadata, permissions, checks, listing, created_at) VALUES ('plv', 'pl', 1, 'staged', 'c', '{}', '{}', '{}', '{}', 'x')");
  db.exec("UPDATE items SET status = 'deleted', covered_by = 'pl', covered_status = 'public' WHERE id = 'i1'");
  assert.throws(() => db.exec("UPDATE items SET covered_status = 'pending' WHERE id = 'i1'"), /CHECK/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('items_new', 'item_versions_new', 'latest_dates')").get().n, 0);
});

test('a plugin renamed with its package unchanged: the new name takes it over in one reconcile', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(nested());
  await sync(env, { config: { paths: ['pack'] } });
  const market = (inner) => JSON.stringify({ plugins: [{ name: 'outer', source: './' }, { name: inner, source: './pack' }] });
  // the outer plugin holds the member; with it waiting for review, the inner one does
  env.HARNESS_DB.sqlite.prepare("INSERT INTO rules (id, category, severity, scope, pattern, flags, message_en, message_zh, created_at, updated_at) VALUES ('t3', 'test', 'high', 'all', '^echo$', '', 'x', 'x', 'x', 'x')").run();
  gh.commit(nested({ 'hooks/run-hook.cmd': 'echo\n\n' }));
  await sync(env, { config: { paths: ['pack'] } });
  const inner = item(env, `${SOURCE}:plugin:inner`);
  assert.equal(member(env, 'pack/skills/shared').covered_by, inner.id);
  gh.commit(nested({ 'hooks/run-hook.cmd': 'echo\n\n', '.claude-plugin/marketplace.json': market('inner-next') }));
  await sync(env, { config: { paths: ['pack'] } });
  const next = item(env, `${SOURCE}:plugin:inner-next`);
  assert.equal(item(env, `${SOURCE}:plugin:inner`).status, 'retired');
  assert.equal(next.status, 'public');
  assert.equal(member(env, 'pack/skills/shared').covered_by, next.id);
});

test('a package another source has out first stays with it; one this plugin holds, older, stays here', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const p = item(env, KEY);
  const db = env.HARNESS_DB.sqlite;
  db.prepare("INSERT INTO publishers (id, handle, kind, name, created_at, updated_at) VALUES ('px', 'forker', 'github', 'forker', 'x', 'x')").run();
  const copy = (seq, id) =>
    db
      .prepare("INSERT INTO items (seq, id, publisher_id, name, kind, status, source, source_key, dedupe_key, created_at, updated_at, version_at) VALUES (?, ?, 'px', ?, 'plugin', 'public', 'github', ?, ?, 'x', 'x', 'x')")
      .run(seq, id, id, `github:forker/${id}:plugin:superpowers`, p.dedupe_key);
  // a newer copy elsewhere: this one, older and holding, stays out
  copy(p.seq + 1000, 'newer');
  await reconcile(env, SOURCE);
  assert.equal(item(env, KEY).status, 'public');
  // an older one out elsewhere: this one is the copy, and lets its members go
  copy(-1, 'older');
  await reconcile(env, SOURCE);
  assert.equal(item(env, KEY).status, 'listed');
  assert.ok(JSON.parse(item(env, KEY).listed_reasons).includes('duplicate'));
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
});

test('an import and a reconcile of one source never run at once', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  // an import holds the source: the reconcile comes again later, and the other way round
  env.HARNESS_DB.sqlite.prepare("UPDATE import_sources SET lease = 'import', lease_until = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(SOURCE);
  env.sent.length = 0;
  await runJob(env, { type: 'github.reconcile', source: SOURCE });
  assert.deepEqual(env.sent.map((j) => [j.type, j.attempt]), [['github.reconcile', 1]]);
  env.sent.length = 0;
  await runJob(env, { type: 'github.repo', source: SOURCE, force: true });
  assert.deepEqual(env.sent.map((j) => [j.type, j.attempt]), [['github.repo', 1]]);
  env.HARNESS_DB.sqlite.prepare('UPDATE import_sources SET lease = NULL, lease_until = NULL WHERE id = ?').run(SOURCE);
  env.sent.length = 0;
  await runJob(env, { type: 'github.repo', source: SOURCE, force: true });
  assert.equal(env.HARNESS_DB.rows('SELECT lease FROM import_sources WHERE id = ?', SOURCE)[0].lease, null);
  assert.ok(env.sent.some((j) => j.type === 'github.reconcile'));
});

test('every package a launch fetches must be pinned, however it is named', () => {
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', '--package=@a/b@1.2.3', '--', 'b'] }), true);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', '--package=@a/b@1.2.3', '--package', 'c', '--', 'b'] }), false);
  assert.equal(mcpPinned({ command: 'npx', args: ['-y', '-p', 'x@1.0.0', '-p', 'y@2.0.0', 'cmd'] }), true);
  assert.equal(mcpPinned({ command: 'uvx', args: ['--with', 'extra', 'pkg==1.0'] }), false);
  assert.equal(mcpPinned({ command: 'uvx', args: ['--with', 'extra==2', 'pkg==1.0'] }), true);
});

test('hooks a marketplace entry declares are checked for credentials as the folder is', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  const token = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const files = superpowers({
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'superpowers', source: './', strict: false, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `curl -H "token: ${token}" https://x.example` }] }] } }] }),
  });
  delete files['.claude-plugin/plugin.json'];
  gh.commit(files);
  await sync(env);
  const detail = await getItem(env.HARNESS_DB, 'obra', 'superpowers');
  assert.ok(detail.permissions.detected.hooks.length > 0);
  assert.ok(!JSON.stringify(detail).includes(token));
  assert.ok(JSON.parse(item(env, KEY).listed_reasons).includes('secrets'));
});

test('a source following releases waits while GitHub shows none', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  const v1 = gh.commit(superpowers());
  gh.commit(superpowers({ 'README.md': '# dev\n' }));
  const r = await importRepo(env, 'obra/superpowers', {}, v1, false, undefined, { lastTrack: 'release' });
  assert.deepEqual([r.commit, r.track, r.changed], [v1, 'release', false]);
});

test('a package put out by another source while this reconcile was deciding fails the batch; run again, it is a copy', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  env.HARNESS_PLUGINS = 'off';
  await sync(env);
  env.HARNESS_PLUGINS = 'on';
  const p = item(env, KEY);
  const hash = env.HARNESS_DB.rows('SELECT content_sha256 FROM item_versions WHERE id = ?', p.latest_version_id)[0].content_sha256;
  const db = env.HARNESS_DB.sqlite;
  db.prepare("INSERT INTO publishers (id, handle, kind, name, created_at, updated_at) VALUES ('px', 'forker', 'github', 'forker', 'x', 'x')").run();
  env.HARNESS_DB.beforeBatch = () => {
    env.HARNESS_DB.beforeBatch = null;
    db.prepare("INSERT INTO items (seq, id, publisher_id, name, kind, status, source, source_key, dedupe_key, created_at, updated_at, version_at) VALUES (-1, 'fork', 'px', 'superpowers', 'plugin', 'public', 'github', 'github:forker/x:plugin:superpowers', ?, 'x', 'x', 'x')").run(`plugin:${hash}`);
  };
  await assert.rejects(reconcile(env, SOURCE), /JSON|json/);
  assert.equal(item(env, KEY).status, 'listed');
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
  await reconcile(env, SOURCE);
  assert.ok(JSON.parse(item(env, KEY).listed_reasons).includes('duplicate'));
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
});

test('a plugin renamed and moved with its package unchanged hands it over in one batch', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  const moved = (dir, name) => ({
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name, source: `./${dir}` }] }),
    [`${dir}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'inner', version: '2.0.0' }),
    [`${dir}/hooks/hooks.json`]: HOOKS,
    [`${dir}/hooks/run-hook.cmd`]: 'echo inner\n',
    [`${dir}/LICENSE`]: 'MIT License',
    [`${dir}/skills/shared/SKILL.md`]: skill('shared'),
  });
  gh.commit(moved('pack', 'inner'));
  await sync(env, { config: { paths: ['pack', 'pack2'] } });
  const old = item(env, `${SOURCE}:plugin:inner`);
  assert.equal(old.status, 'public');
  gh.commit(moved('pack2', 'inner-next'));
  // every batch: never both out at once
  const both = [];
  env.HARNESS_DB.beforeBatch = () => both.push(env.HARNESS_DB.rows("SELECT count(*) AS n FROM items WHERE kind = 'plugin' AND status = 'public'")[0].n);
  await sync(env, { config: { paths: ['pack', 'pack2'] } });
  env.HARNESS_DB.beforeBatch = null;
  assert.ok(both.every((n) => n <= 1));
  assert.equal(item(env, `${SOURCE}:plugin:inner`).status, 'retired');
  assert.equal(item(env, `${SOURCE}:plugin:inner-next`).status, 'public');
  assert.equal(member(env, 'pack/skills/shared').status, 'deleted'); // gone from the repository
  assert.equal(member(env, 'pack2/skills/shared').status, 'deleted');
});

test('npm exec reads its own options up to --; a credential split over lines in an entry is still one', () => {
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'cmd', '--package=x'] }), false);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', '--package=x@1.0.0', '--', 'cmd', '--package=y'] }), true);
});

test('an assigned credential in a marketplace entry is found as written, not as JSON escapes it', async (t) => {
  const env = envWith('off');
  const gh = fakeGithub(t);
  const value = ['x9Kq2', 'Lm7Zr', '4Tn8W', 'p3Vb6', 'Yc1Hs'].join('');
  const files = superpowers({
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'superpowers', source: './', strict: false, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `set -e\nAPI_TOKEN=${value} run` }] }] } }] }),
  });
  delete files['.claude-plugin/plugin.json'];
  gh.commit(files);
  await sync(env);
  const detail = await getItem(env.HARNESS_DB, 'obra', 'superpowers');
  assert.ok(!JSON.stringify(detail).includes(value));
  assert.ok(JSON.parse(item(env, KEY).listed_reasons).includes('secrets'));
});

test('a copy waiting for review holds nothing and blocks nothing; npm exec -p after the command is not a package', async (t) => {
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'tool', '-p', 'tool@1.0.0'] }), false);
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  env.HARNESS_PLUGINS = 'off';
  await sync(env);
  env.HARNESS_PLUGINS = 'on';
  const p = item(env, KEY);
  const hash = env.HARNESS_DB.rows('SELECT content_sha256 FROM item_versions WHERE id = ?', p.latest_version_id)[0].content_sha256;
  const db = env.HARNESS_DB.sqlite;
  db.prepare("INSERT INTO publishers (id, handle, kind, name, created_at, updated_at) VALUES ('px', 'forker', 'github', 'forker', 'x', 'x')").run();
  // an older copy elsewhere, waiting for review as a copy: this one is out all the same
  db.prepare("INSERT INTO items (seq, id, publisher_id, name, kind, status, listed_reasons, source, source_key, dedupe_key, created_at, updated_at, version_at) VALUES (-1, 'fork', 'px', 'superpowers', 'plugin', 'pending', '[\"duplicate\"]', 'github', 'github:forker/x:plugin:superpowers', ?, 'x', 'x', 'x')").run(`plugin:${hash}`);
  await reconcile(env, SOURCE);
  assert.equal(item(env, KEY).status, 'public');
  // a high-risk copy here, of a package out elsewhere: pending, and the batch goes through
  db.prepare("UPDATE items SET status = 'public', listed_reasons = '[]' WHERE id = 'fork'").run();
  db.prepare("INSERT INTO rules (id, category, severity, scope, pattern, flags, message_en, message_zh, created_at, updated_at) VALUES ('t4', 'test', 'high', 'all', 'session-start', '', 'x', 'x', 'x', 'x')").run();
  env.sent.length = 0;
  const { rescan } = await import('../../api/harness/rescan.ts');
  await rescan(env);
  await reconcile(env, SOURCE);
  const now = item(env, KEY);
  assert.equal(now.status, 'pending');
  assert.ok(JSON.parse(now.listed_reasons).includes('duplicate'));
  assert.equal(member(env, 'skills/brainstorming').status, 'public');
  // the rule goes: the copy here is still a copy, not the holder it was waiting to be
  db.prepare("DELETE FROM rules WHERE id = 't4'").run();
  await rescan(env);
  await reconcile(env, SOURCE);
  await reconcile(env, SOURCE);
  assert.equal(item(env, KEY).status, 'listed');
  assert.ok(JSON.parse(item(env, KEY).listed_reasons).includes('duplicate'));
  assert.equal(env.HARNESS_DB.rows("SELECT status FROM items WHERE id = 'fork'")[0].status, 'public');
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'tool', '-p=other'] }), false);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'tool', '-p=other@1.0.0'] }), false);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'tool@1.0.0', '-p=other@1.0.0'] }), false);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', '--package=x@1.2.3', '--', 'x'] }), true);
  // an option after the word: npm's reading of it is not imitated here; unclear, so not pinned (fail closed)
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'semver', '--package=semver@7.7.2'] }), false);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'semver', '-p=--', '--package=semver@7.7.2'] }), false);
  assert.equal(mcpPinned({ command: 'npx', args: ['--cache', '/x', 'a@1.0.0'] }), false);
  assert.equal(mcpPinned({ command: 'docker', args: ['run', '--foo', `img@sha256:${'a'.repeat(64)}`] }), false);
  assert.equal(mcpPinned({ command: 'bunx', args: ['--package=x@1.0.0', '--', '--package=x', 'x'] }), false);
  assert.equal(mcpPinned({ command: 'bun', args: ['x', '-p', 'x@1.0.0', '--', 'x'] }), false);
  assert.equal(mcpPinned({ command: 'npm', args: ['exec', 'semver', '--package', 'semver'] }), false);
});

test('on the shelves: a plugin card says what it has, a member\'s name finds it, its publisher lists it first, its page has its description', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const db = env.HARNESS_DB;
  const p = item(env, KEY);

  // its card, from the reconcile (a staged version leaves the item's card to it)
  const shelf = await listItems(db, { kind: 'plugin' });
  assert.deepEqual(shelf.items.map((i) => i.ref), ['obra/superpowers']);
  assert.deepEqual(shelf.items[0].plugin, { skills: 3, assistants: 0, hosts: shelf.items[0].plugin.hosts, autorun: true, has: null });
  assert.ok(shelf.items[0].plugin.hosts.includes('claude'));

  // a member's name: the plugin first, saying which member; its own name says none
  const byMember = await listItems(db, { q: 'brainstorming' });
  assert.equal(byMember.items[0].ref, 'obra/superpowers');
  assert.equal(byMember.items[0].plugin.has, 'brainstorming');
  assert.equal((await listItems(db, { q: 'superpowers' })).items[0].plugin.has, null);

  // the publisher's page: its plugins first, a more popular skill after them, across pages
  await saveVersions(env, [
    versionInput({ name: 'other-skill', sourceKey: 'github:obra/other:skills/other-skill', publisher: { kind: 'github', handle: 'obra', name: 'obra', githubLogin: 'obra' } }),
  ]);
  db.sqlite.prepare("UPDATE items SET status = 'public', popularity = 99 WHERE name = 'other-skill'").run();
  const first = await listItems(db, { publisher: 'obra', limit: 1 });
  assert.deepEqual(first.items.map((i) => i.ref), ['obra/superpowers']);
  const second = await listItems(db, { publisher: 'obra', limit: 1, cursor: first.next });
  assert.deepEqual(second.items.map((i) => i.ref), ['obra/other-skill']);
  assert.equal(second.next, null);

  // its description, kept with the staged version and served once it is current
  const detail = await getItem(db, 'obra', 'superpowers');
  assert.ok(detail.readme);
  const key = db.rows('SELECT readme FROM item_versions WHERE id = ?', p.latest_version_id)[0].readme;
  assert.match(await (await env.HARNESS_FILES.get(key)).text(), /agentic skills framework/);
  // and how Claude Code installs it from the repository's own marketplace
  const run = JSON.parse(db.rows("SELECT plugins FROM import_runs WHERE source = ? ORDER BY completed_at DESC LIMIT 1", SOURCE)[0].plugins);
  assert.equal(run.plugins[0].claude, 'superpowers@dev');
});

test('a plugin saved without its description gets it at the next reconcile; /config lists plugins only with the switch on', async (t) => {
  const env = envWith('on');
  const gh = fakeGithub(t);
  gh.commit(superpowers());
  await sync(env);
  const db = env.HARNESS_DB;
  const p = item(env, KEY);
  db.sqlite.prepare('UPDATE item_versions SET readme = NULL, excerpt = NULL WHERE id = ?').run(p.latest_version_id);
  await reconcile(env, SOURCE);
  const v = db.rows('SELECT readme, excerpt FROM item_versions WHERE id = ?', p.latest_version_id)[0];
  assert.equal(v.readme, `readme/${p.latest_version_id}.html`);
  assert.match(v.excerpt, /agentic skills framework/);
  assert.ok((await found(env, 'agentic')).includes(p.id));

  const { harnessApi } = await import('../../api/harness/routes.ts');
  const kinds = async (flag) => (await (await harnessApi.request('/config', {}, { ...env, HARNESS_PLUGINS: flag, HARNESS_LIMIT: { limit: async () => ({ success: true }) } })).json()).kinds;
  assert.ok((await kinds('on')).includes('plugin'));
  assert.ok(!(await kinds('off')).includes('plugin'));
  // and the kind it lists is one the list takes
  const res = await harnessApi.request('/items?kind=plugin', {}, { ...env, HARNESS_LIMIT: { limit: async () => ({ success: true }) } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).items.map((i) => i.ref), ['obra/superpowers']);
});
