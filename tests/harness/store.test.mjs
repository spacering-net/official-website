import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importRegistryPage } from '../../api/harness/importers/registry.ts';
import { rescan } from '../../api/harness/rescan.ts';
import { repairIndex, searchIds } from '../../api/harness/search.ts';
import { retireItems, saveVersions } from '../../api/harness/store.ts';
import { testEnv, versionInput } from './env.mjs';

const item = (env, name) => env.HARNESS_DB.rows('SELECT * FROM items WHERE name = ?', name)[0];
const indexed = (env) => env.HARNESS_DB.rows('SELECT rowid FROM item_search').map((r) => r.rowid).sort();
const found = async (env, q) => (await searchIds(env.HARNESS_DB, q, {})).map((h) => h.id);

test('a version is kept once; changed content makes the next revision; the index follows', async () => {
  const env = testEnv();
  const first = await saveVersions(env, [versionInput()]);
  assert.equal(first.created, 1);
  const a = item(env, 'pdf-forms');
  assert.equal(a.status, 'public');
  assert.deepEqual(await found(env, 'pdf'), [a.id]);
  assert.ok(env.HARNESS_FILES.objects.has(`readme/${a.latest_version_id}.html`));

  const again = await saveVersions(env, [versionInput()]);
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 1]);
  assert.equal(item(env, 'pdf-forms').latest_revision, 1);

  await saveVersions(env, [versionInput({ contentSha256: 'c2', listing: { ...versionInput().listing, summary: { en: 'Now fills invoices too.' } } })]);
  const b = item(env, 'pdf-forms');
  assert.equal(b.latest_revision, 2);
  assert.deepEqual(await found(env, 'invoices'), [b.id]);
  assert.deepEqual(await found(env, 'sign'), []);
  assert.equal(indexed(env).length, 1);
});

test('a package that may not be redistributed, or holds a credential, is not copied', async () => {
  const env = testEnv();
  await saveVersions(env, [
    versionInput({ name: 'closed', hosted: false }),
    versionInput({ name: 'leaky', hosted: false, checks: { ...versionInput().checks, secrets: [{ kind: 'assigned_secret', path: 'a.py', line: 3 }] } }),
  ]);
  assert.equal([...env.HARNESS_FILES.objects.keys()].length, 0);
  for (const name of ['closed', 'leaky']) {
    const v = env.HARNESS_DB.rows('SELECT v.readme, v.excerpt, v.archive_sha256, v.hosted FROM items i JOIN item_versions v ON v.id = i.latest_version_id WHERE i.name = ?', name)[0];
    assert.deepEqual({ ...v }, { readme: null, excerpt: null, archive_sha256: null, hosted: 0 });
  }
  assert.equal(item(env, 'closed').status, 'public');
  assert.equal(item(env, 'leaky').status, 'listed');
  assert.deepEqual(JSON.parse(item(env, 'leaky').listed_reasons), ['secrets']);
});

test('a copy published later under another name stays listed, even if it owns the package', async () => {
  const env = testEnv();
  await saveVersions(env, [versionInput({ name: 'first', dedupeKey: 'npm:pkg', owns: false })]);
  await saveVersions(env, [versionInput({ name: 'second', sourceKey: 'github:other/x:second', dedupeKey: 'npm:pkg', owns: true })]);
  assert.equal(item(env, 'first').status, 'public');
  assert.equal(item(env, 'second').status, 'listed');
  assert.deepEqual(JSON.parse(item(env, 'second').listed_reasons), ['duplicate']);
  // within one set, the owner wins over a copy
  const env2 = testEnv();
  await saveVersions(env2, [
    versionInput({ name: 'copy', sourceKey: 'k1', dedupeKey: 'npm:pkg', owns: false }),
    versionInput({ name: 'own', sourceKey: 'k2', dedupeKey: 'npm:pkg', owns: true }),
  ]);
  assert.equal(item(env2, 'copy').status, 'listed');
  assert.equal(item(env2, 'own').status, 'public');
});

test('leaving the shelves takes an item out of search, in the same batch; a failed batch changes nothing', async () => {
  const env = testEnv();
  await saveVersions(env, [versionInput()]);
  const id = item(env, 'pdf-forms').id;
  // a failure while writing: neither the item nor its search row may move
  env.HARNESS_DB.beforeBatch = () => {
    throw new Error('injected');
  };
  await assert.rejects(saveVersions(env, [versionInput({ contentSha256: 'c2', checks: { ...versionInput().checks, quality: { reasons: ['no_repository'], score: 1 } } })]));
  env.HARNESS_DB.beforeBatch = null;
  assert.equal(item(env, 'pdf-forms').status, 'public');
  assert.deepEqual(await found(env, 'pdf'), [id]);
  // the retry does it all
  await saveVersions(env, [versionInput({ contentSha256: 'c2', checks: { ...versionInput().checks, quality: { reasons: ['no_repository'], score: 1 } } })]);
  assert.equal(item(env, 'pdf-forms').status, 'listed');
  assert.deepEqual(await found(env, 'pdf'), []);
  assert.deepEqual(indexed(env), []);

  await saveVersions(env, [versionInput({ name: 'other', sourceKey: 'k-other' })]);
  assert.equal(await retireItems(env.HARNESS_DB, ['k-other']), 1);
  assert.equal(item(env, 'other').status, 'retired');
  assert.deepEqual(indexed(env), []);
});

test('repairIndex adds missing rows and drops stray ones; search never shows a hidden item', async () => {
  const env = testEnv();
  await saveVersions(env, [versionInput(), versionInput({ name: 'hidden', sourceKey: 'k-h', checks: { ...versionInput().checks, quality: { reasons: ['no_repository'], score: 1 } } })]);
  const pub = item(env, 'pdf-forms');
  const hidden = item(env, 'hidden');
  env.HARNESS_DB.sqlite.exec(`DELETE FROM item_search WHERE rowid = ${pub.seq}`);
  env.HARNESS_DB.sqlite.exec(`INSERT INTO item_search (rowid, name, keywords, title, summary, body) VALUES (${hidden.seq}, 'pdf hidden', '', '', '', '')`);
  assert.deepEqual(await found(env, 'pdf'), []); // the stray row is never shown
  assert.equal(await repairIndex(env.HARNESS_DB), 2);
  assert.deepEqual(indexed(env), [pub.seq]);
  assert.deepEqual(await found(env, 'pdf'), [pub.id]);
});

// a registry page, as the registry serves it
function registryPage(names, next = null) {
  return {
    servers: names.map((n) => ({
      server: {
        name: `io.github.someone/${n}`,
        description: `A server called ${n} that answers questions.`,
        version: '1.0.0',
        repository: { url: `https://github.com/someone/${n}` },
        remotes: [{ type: 'streamable-http', url: `https://mcp.example.org/${n}` }],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true, publishedAt: '2026-09-01T00:00:00Z' } },
    })),
    metadata: { nextCursor: next },
  };
}

test('servers seen again do not count twice toward a bulk publisher; crossing the line takes the earlier ones off the shelves', async (t) => {
  const env = testEnv();
  let page = registryPage(Array.from({ length: 30 }, (_, i) => `s${i}`));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(page)));
  await importRegistryPage(env, null, null);
  await importRegistryPage(env, null, null); // the same page again
  assert.equal(env.HARNESS_DB.rows("SELECT bulk FROM publishers WHERE handle = 'someone'")[0].bulk, 0);
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) n FROM items WHERE status = 'public'")[0].n, 30);
  assert.equal(indexed(env).length, 30);

  page = registryPage(Array.from({ length: 25 }, (_, i) => `t${i}`));
  await importRegistryPage(env, null, null);
  assert.equal(env.HARNESS_DB.rows("SELECT bulk FROM publishers WHERE handle = 'someone'")[0].bulk, 1);
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) n FROM items WHERE status = 'public'")[0].n, 0);
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) n FROM items WHERE listed_reasons LIKE '%bulk_publisher%'")[0].n, 55);
  assert.deepEqual(indexed(env), []);
});

test('a rescan does not overwrite a newer version saved while it ran', async () => {
  const env = testEnv();
  await saveVersions(env, [versionInput()]);
  const v1 = item(env, 'pdf-forms').latest_version_id;
  // a rule set newer than the one the version was checked with
  env.HARNESS_DB.sqlite.exec(
    "INSERT INTO rules (id, category, severity, scope, pattern, message_en, message_zh, created_at, updated_at) VALUES ('t1', 'test', 'low', 'all', 'zzmarker', 'x', 'x', '2026', '2026')",
  );
  // while the rescan reads version 1's files, a riskier version 2 arrives
  env.HARNESS_FILES.onGet = async () => {
    env.HARNESS_FILES.onGet = null;
    await saveVersions(env, [versionInput({ contentSha256: 'c2', risk: 'high' })]);
  };
  const { count } = await rescan(env);
  assert.equal(count, 1);
  const now = item(env, 'pdf-forms');
  assert.notEqual(now.latest_version_id, v1);
  assert.deepEqual([now.status, now.risk], ['pending', 'high']);
  assert.deepEqual(await found(env, 'pdf'), []);
  // version 1's own checks were still brought up to date
  assert.notEqual(JSON.parse(env.HARNESS_DB.rows('SELECT checks FROM item_versions WHERE id = ?', v1)[0].checks).rules, null);
});

test('a credential inside a registry description is redacted everywhere it is kept', async (t) => {
  const env = testEnv();
  const value = ['q8Wz3', 'Lk5Pm', '2Xv7N', 'b9Rt4', 'Hc6Ys'].join('');
  const page = registryPage(['leaky']);
  page.servers[0].server.description = `Set API_KEY="${value}" before you start; it answers questions.`;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(page)));
  await importRegistryPage(env, null, null);
  const row = env.HARNESS_DB.rows("SELECT i.status, i.summary_en, i.listed_reasons, v.metadata FROM items i JOIN item_versions v ON v.id = i.latest_version_id WHERE i.name = 'leaky'")[0];
  assert.equal(row.status, 'listed');
  assert.deepEqual(JSON.parse(row.listed_reasons), ['secrets']);
  for (const kept of [row.summary_en, row.metadata]) {
    assert.ok(!kept.includes(value), kept);
    assert.ok(kept.includes('[redacted]'));
  }
});

test('a rescan that loses a race to a same-version change leaves the search row matching the item', async () => {
  const env = testEnv();
  const listed = { ...versionInput().checks, quality: { reasons: ['no_repository'], score: 1 } };
  await saveVersions(env, [versionInput({ checks: listed })]);
  assert.equal(item(env, 'pdf-forms').status, 'listed');
  env.HARNESS_DB.sqlite.exec(
    "INSERT INTO rules (id, category, severity, scope, pattern, message_en, message_zh, created_at, updated_at) VALUES ('t1', 'test', 'low', 'all', 'zzmarker', 'x', 'x', '2026', '2026')",
  );
  // while the rescan reads the files, the same version goes public (as a package recheck would)
  env.HARNESS_FILES.onGet = async () => {
    env.HARNESS_FILES.onGet = null;
    await saveVersions(env, [versionInput()]);
  };
  await rescan(env);
  const now = item(env, 'pdf-forms');
  assert.equal(now.status, 'public');
  assert.deepEqual(await found(env, 'pdf'), [now.id]);
});

test('retired servers that come back count toward a bulk publisher again', async (t) => {
  const env = testEnv();
  let page = registryPage(Array.from({ length: 25 }, (_, i) => `a${i}`));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(page)));
  await importRegistryPage(env, null, null);
  await retireItems(env.HARNESS_DB, page.servers.map((s) => `registry:${s.server.name}`));
  page = registryPage(Array.from({ length: 30 }, (_, i) => `b${i}`));
  await importRegistryPage(env, null, null);
  assert.equal(env.HARNESS_DB.rows("SELECT bulk FROM publishers WHERE handle = 'someone'")[0].bulk, 0);
  page = registryPage(Array.from({ length: 25 }, (_, i) => `a${i}`));
  await importRegistryPage(env, null, null);
  assert.equal(env.HARNESS_DB.rows("SELECT bulk FROM publishers WHERE handle = 'someone'")[0].bulk, 1);
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) n FROM items WHERE status = 'public'")[0].n, 0);
  assert.deepEqual(indexed(env), []);
});

test('credential-named fields are redacted in both importers, and the API does not return them', async (t) => {
  const { getItem } = await import('../../api/harness/catalog.ts');
  const { importRepo } = await import('../../api/harness/importers/github.ts');
  const { tarGz } = await import('./env.mjs');
  const value = ['m4Tq8', 'Zx2Wv', '7Kp3R', 'n6Yb9', 'Jd5Hs'].join('');

  // the registry: a field in server.json's _meta
  const env = testEnv();
  const page = registryPage(['meta']);
  page.servers[0].server._meta = { 'com.example/extra': { API_KEY: value } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(page)));
  await importRegistryPage(env, null, null);
  const reg = await getItem(env.HARNESS_DB, 'someone', 'meta');
  assert.equal(reg.status, 'listed');
  assert.ok(!JSON.stringify(reg).includes(value));
  assert.ok(!env.HARNESS_DB.rows('SELECT metadata FROM item_versions')[0].metadata.includes(value));

  // GitHub: a field in SKILL.md's metadata, and an assignment in its description
  const env2 = testEnv();
  const sha = 'abc1234def';
  const skill = `---\nname: leaky\ndescription: 'Reads notes. Set API_KEY="${value}" first.'\nmetadata:\n  api_key: ${value}\n---\n# Leaky\nBody.\n`;
  const tgz = await tarGz('someone-skills-abc1234', { 'skills/leaky/SKILL.md': skill, 'LICENSE': 'Permission is hereby granted, free of charge, to any person obtaining a copy' });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/someone/skills') {
      return Response.json({ full_name: 'someone/skills', html_url: 'https://github.com/someone/skills', default_branch: 'main', stargazers_count: 3, archived: false, license: { spdx_id: 'MIT' }, owner: { id: 42, login: 'someone', type: 'User' } });
    }
    if (u === 'https://api.github.com/repos/someone/skills/commits/main') return Response.json({ sha, commit: { committer: { date: '2026-10-01T00:00:00Z' } } });
    if (u.startsWith(`https://api.github.com/repos/someone/skills/git/trees/${sha}`)) {
      return Response.json({ truncated: false, tree: [{ path: 'skills/leaky/SKILL.md', type: 'blob', size: skill.length }, { path: 'LICENSE', type: 'blob', size: 80 }] });
    }
    if (u === `https://codeload.github.com/someone/skills/tar.gz/${sha}`) return new Response(tgz);
    throw new Error(`unexpected fetch ${u}`);
  });
  const result = await importRepo(env2, 'someone/skills', { paths: ['skills'] }, null);
  assert.equal(result.skills, 1);
  const gh = await getItem(env2.HARNESS_DB, 'someone', 'leaky');
  assert.equal(gh.status, 'listed');
  assert.equal(gh.install.archive, null);
  assert.equal(gh.readme, null);
  assert.ok(!JSON.stringify(gh).includes(value));
  assert.equal(env2.HARNESS_FILES.objects.size, 0);
  assert.ok(!env2.HARNESS_DB.rows('SELECT metadata, listing FROM item_versions').some((r) => r.metadata.includes(value) || r.listing.includes(value)));
});

test('long tokens and tokens with text after them are redacted whole, in fields and in text', async (t) => {
  const { redactDeep, redactSecrets, scanJsonSecrets } = await import('../../api/harness/scan/secrets.ts');
  const { getItem } = await import('../../api/harness/catalog.ts');
  const unit = ['m4Tq8', 'Zx2Wv', '7Kp3R', 'n6Yb9', 'Jd5Hs'].join('');
  const long = unit.repeat(9); // 225 characters
  const doc = { API_KEY: long, client_secret: `${unit} (rotate monthly)`, note: `export API_KEY=${long}` };
  assert.equal(scanJsonSecrets('x.json', doc).length, 3);
  const clean = JSON.stringify(redactDeep(doc));
  assert.ok(!clean.includes(unit), clean);
  assert.ok(!redactSecrets(`API_KEY=${long} next`).includes(unit.slice(0, 10)));

  const env = testEnv();
  const page = registryPage(['long']);
  page.servers[0].server._meta = { 'com.example/extra': { API_KEY: long } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(page)));
  await importRegistryPage(env, null, null);
  const reg = await getItem(env.HARNESS_DB, 'someone', 'long');
  assert.equal(reg.status, 'listed');
  assert.ok(!JSON.stringify(reg).includes(unit));
});

test('a long token is still a token when part of it reads like a placeholder', async (t) => {
  const { redactDeep, redactSecrets, scanSecrets } = await import('../../api/harness/scan/secrets.ts');
  const { getItem } = await import('../../api/harness/catalog.ts');
  const unit = ['m4Tq8', 'Zx2Wv', '7Kp3R', 'n6Yb9', 'Jd5Hs'].join('');
  const token = `${unit.repeat(8)}your${unit.slice(0, 21)}`;
  for (const word of ['your', 'example', 'sample', 'fake']) {
    const t2 = `${unit.repeat(8)}${word}${unit.slice(0, 21)}`;
    assert.equal(scanSecrets('a.env', `API_KEY=${t2}`).length, 1, word);
    assert.ok(!redactSecrets(`API_KEY=${t2}`).includes(unit), word);
    assert.ok(!JSON.stringify(redactDeep({ API_KEY: t2 })).includes(unit), word);
  }
  // a known format with "example" inside is a token; documentation's made-up ones are not
  const gh = ['gh', 'p_', 'a1B2c3D4e5example6g7H8i9J0k1L2m3N4o5P6'].join('');
  assert.equal(scanSecrets('a.md', `token ${gh}`).length, 1);
  assert.deepEqual(scanSecrets('a.md', ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('')), []);
  // two on one line: neither hides the other
  const ex = `${unit.repeat(8)}example${unit.slice(0, 21)}`;
  assert.equal(scanSecrets('a.md', `Set API_KEY=${ex} or CLIENT_SECRET=${ex} first.`).length, 1);
  assert.ok(!redactSecrets(`Set API_KEY=${ex} or CLIENT_SECRET=${ex} first.`).includes(unit));
  // a variable's own name does not make its line an example
  assert.equal(scanSecrets('a.env', `SAMPLE_SERVICE_TOKEN=${unit}`).length, 1);
  // short placeholders, and lines that say they are an example, stay quiet
  assert.deepEqual(scanSecrets('a.env', 'API_KEY=your-api-key-goes-here-123456'), []);
  assert.deepEqual(scanSecrets('a.md', `Example: API_KEY=${unit}`), []);

  const env = testEnv();
  const page = registryPage(['placeholderish']);
  const both = token.replace('your', 'example');
  page.servers[0].server.description = `Answers questions. Set API_KEY=${both} or CLIENT_SECRET=${both} first.`;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(page)));
  await importRegistryPage(env, null, null);
  const reg = await getItem(env.HARNESS_DB, 'someone', 'placeholderish');
  assert.equal(reg.status, 'listed');
  assert.ok(!JSON.stringify(reg).includes(unit));
});

test('a repository too big for one run is saved over several, and nothing is retired before the last', async (t) => {
  const { importRepo } = await import('../../api/harness/importers/github.ts');
  const { tarGz } = await import('./env.mjs');
  const env = testEnv();
  const sha = 'abc1234def';
  const files = { LICENSE: 'Permission is hereby granted, free of charge, to any person obtaining a copy' };
  for (let i = 1; i <= 45; i++) {
    const name = `task-${String(i).padStart(2, '0')}`;
    files[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: Carries out task number ${i}, step by step.\n---\n# Task ${i}\nBody ${i}.\n`;
  }
  const tgz = await tarGz('someone-skills-abc1234', files);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/someone/skills') {
      return Response.json({ full_name: 'someone/skills', html_url: 'https://github.com/someone/skills', default_branch: 'main', stargazers_count: 3, archived: false, license: { spdx_id: 'MIT' }, owner: { id: 42, login: 'someone', type: 'User' } });
    }
    if (u === 'https://api.github.com/repos/someone/skills/commits/main') return Response.json({ sha, commit: { committer: { date: '2026-10-01T00:00:00Z' } } });
    if (u.startsWith(`https://api.github.com/repos/someone/skills/git/trees/${sha}`)) {
      return Response.json({ truncated: false, tree: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', size: text.length })) });
    }
    if (u === `https://codeload.github.com/someone/skills/tar.gz/${sha}`) return new Response(tgz);
    throw new Error(`unexpected fetch ${u}`);
  });
  // a skill an earlier commit had, gone from this one
  await saveVersions(env, [versionInput({ name: 'gone', sourceKey: 'github:someone/skills:skills/gone' })]);

  // the clock passes the deadline while the first chunk of 40 is written
  let now = 1_000;
  const clock = t.mock.method(Date, 'now', () => now);
  env.HARNESS_DB.beforeBatch = () => (now = 10_000);
  const first = await importRepo(env, 'someone/skills', { paths: ['skills'] }, null, false, 5_000);
  assert.deepEqual([first.skills, first.created, first.remaining, first.retired], [45, 40, 5, 0]);
  assert.equal(item(env, 'gone').status, 'public');
  // the first chunk's files are stored: a SKILL.md, a zip and a readme each (and the earlier skill's three)
  assert.equal(env.HARNESS_FILES.objects.size, 40 * 3 + 3);
  clock.mock.restore();
  env.HARNESS_DB.beforeBatch = null;

  // the next run finds the 40 unchanged and saves the rest, then retires what is gone
  const second = await importRepo(env, 'someone/skills', { paths: ['skills'] }, null);
  assert.deepEqual([second.created, second.remaining, second.retired], [5, 0, 1]);
  assert.equal(item(env, 'gone').status, 'retired');
  assert.equal(env.HARNESS_DB.rows("SELECT COUNT(*) AS n FROM items WHERE status = 'public' AND source_key LIKE 'github:someone/skills:skills/task-%'")[0].n, 45);
});
