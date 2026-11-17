import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harnessApi } from '../../api/harness/routes.ts';
import { saveVersions } from '../../api/harness/store.ts';
import { testEnv, versionInput } from './env.mjs';

// What a client has installed, asked about by id (POST /resolve): what each kind of item tells,
// what the state's hash follows, and what the request must look like.

const env = () => ({ ...testEnv(), HARNESS_LIMIT: { limit: async () => ({ success: true }) } });
const item = (e, name) => e.HARNESS_DB.rows('SELECT * FROM items WHERE name = ?', name)[0];
const sql = (e, text, ...params) => e.HARNESS_DB.sqlite.prepare(text).run(...params);
const post = (e, body, headers = { 'content-type': 'application/json' }) =>
  harnessApi.request('/resolve', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }, e);
const resolve = async (e, installed) => {
  const res = await post(e, { installed });
  assert.equal(res.status, 200);
  return (await res.json()).items;
};
const NOBODY = '00000000-0000-7000-8000-000000000000';

const pinned = (over = {}) => ({ registryType: 'npm', identifier: '@someone/server', version: '1.2.3', verified: 'ok', integrity: 'sha512-x', ...over });

test('an item that is out tells its address, its latest version and the installed revision as it stands', async () => {
  const e = env();
  await saveVersions(e, [versionInput({ packages: [pinned({ hasInstallScript: true })] })]);
  const a = item(e, 'pdf-forms');
  const res = await post(e, { installed: [{ id: a.id, revision: 1 }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const [got] = (await res.json()).items;
  assert.match(got.installed.stateSha256, /^[0-9a-f]{64}$/);
  delete got.installed.stateSha256;
  assert.deepEqual(got, {
    id: a.id,
    status: 'public',
    ref: 'someone/pdf-forms',
    kind: 'skill',
    latest: { revision: 1, version: '1.0.0', publishedAt: a.version_at },
    advisories: [],
    installed: {
      revision: 1,
      status: 'ok',
      risk: 'low',
      reviewed: false,
      permissions: versionInput().permissions,
      checks: { findings: { low: 0, medium: 0, high: 0 }, secrets: 0, review: 'off' },
      // what was pinned, without the hashes: those belong to the version, which never changes
      packages: [{ registryType: 'npm', identifier: '@someone/server', version: '1.2.3', verified: 'ok', hasInstallScript: true }],
    },
  });
});

test('answers come in the order asked; a later version shows as the latest, the installed one stays told', async () => {
  const e = env();
  await saveVersions(e, [versionInput(), versionInput({ name: 'other', sourceKey: 'github:someone/skills:skills/other' })]);
  await saveVersions(e, [versionInput({ contentSha256: 'c2', version: '1.1.0' })]);
  const [a, b] = [item(e, 'pdf-forms'), item(e, 'other')];
  const got = await resolve(e, [
    { id: b.id, revision: 1 },
    { id: NOBODY, revision: 1 },
    { id: a.id, revision: 1 },
    { id: a.id, revision: 7 },
  ]);
  assert.deepEqual(got.map((g) => [g.id, g.status]), [[b.id, 'public'], [NOBODY, 'unavailable'], [a.id, 'public'], [a.id, 'public']]);
  assert.deepEqual(got[2].latest, { revision: 2, version: '1.1.0', publishedAt: a.version_at });
  assert.equal(got[2].installed.revision, 1);
  // a revision the item never had
  assert.equal(got[3].installed, null);
  assert.deepEqual(await resolve(e, []), []);
});

test('an item is found by its id, whatever it is called now', async () => {
  const e = env();
  await saveVersions(e, [versionInput()]);
  const a = item(e, 'pdf-forms');
  sql(e, "UPDATE items SET name = 'forms' WHERE id = ?", a.id);
  const [got] = await resolve(e, [{ id: a.id, revision: 1 }]);
  assert.equal(got.ref, 'someone/forms');
});

test('what is not out, private or unknown tells nothing but that', async () => {
  const e = env();
  await saveVersions(e, [versionInput()]);
  const a = item(e, 'pdf-forms');
  const ask = async () => resolve(e, [{ id: a.id, revision: 1 }, { id: NOBODY, revision: 1 }]);
  const nothing = [{ id: a.id, status: 'unavailable' }, { id: NOBODY, status: 'unavailable' }];
  for (const status of ['draft', 'pending']) {
    sql(e, 'UPDATE items SET status = ? WHERE id = ?', status, a.id);
    assert.deepEqual(await ask(), nothing);
  }
  for (const status of ['public', 'listed', 'retired', 'removed']) {
    sql(e, "UPDATE items SET status = ?, visibility = 'private' WHERE id = ?", status, a.id);
    assert.deepEqual(await ask(), nothing);
  }
});

test('a retired or removed item tells only the status of the revision asked about', async () => {
  const e = env();
  await saveVersions(e, [versionInput()]);
  const a = item(e, 'pdf-forms');
  for (const status of ['retired', 'removed']) {
    sql(e, 'UPDATE items SET status = ? WHERE id = ?', status, a.id);
    assert.deepEqual(await resolve(e, [{ id: a.id, revision: 1 }, { id: a.id, revision: 2 }]), [
      { id: a.id, status, installed: { revision: 1, status: 'ok' } },
      { id: a.id, status, installed: null },
    ]);
  }
  sql(e, "UPDATE item_versions SET status = 'blocked' WHERE item_id = ?", a.id);
  assert.deepEqual(await resolve(e, [{ id: a.id, revision: 1 }]), [{ id: a.id, status: 'removed', installed: { revision: 1, status: 'blocked' } }]);
});

test("the state's hash changes with anything a person agreed to, and with nothing else", async () => {
  const e = env();
  const base = versionInput({ packages: [pinned({ verified: 'pending' })] });
  await saveVersions(e, [base]);
  const a = item(e, 'pdf-forms');
  const state = async () => (await resolve(e, [{ id: a.id, revision: 1 }]))[0].installed;
  const first = await state();
  const set = (column, value) => sql(e, `UPDATE item_versions SET ${column} = ? WHERE item_id = ?`, typeof value === 'string' ? value : JSON.stringify(value), a.id);

  // the same state, written another way or checked again, reads the same
  set('permissions', { detected: Object.fromEntries(Object.entries(base.permissions.detected).reverse()), declared: {} });
  set('checks', { ...base.checks, checkedAt: '2026-11-15T00:00:00.000Z', rules: 'another-rule-set' });
  set('packages', [{ verified: 'pending', version: '1.2.3', identifier: '@someone/server', registryType: 'npm', integrity: 'sha512-y' }]);
  assert.equal((await state()).stateSha256, first.stateSha256);

  const seen = new Set([first.stateSha256]);
  const changed = async (what) => {
    const next = await state();
    assert.ok(!seen.has(next.stateSha256), `${what} changes the hash`);
    seen.add(next.stateSha256);
    return next;
  };
  set('packages', [pinned({ verified: 'missing' })]);
  assert.equal((await changed('a package that is gone')).packages[0].verified, 'missing');
  set('packages', [pinned({ verified: 'pending', hasInstallScript: true })]);
  assert.equal((await changed('an install script')).packages[0].hasInstallScript, true);
  set('packages', [pinned({ verified: 'pending', version: null })]);
  assert.equal((await changed('a version no longer pinned')).packages[0].version, null);
  set('permissions', { declared: {}, detected: { ...base.permissions.detected, network: ['example.com'] } });
  assert.deepEqual((await changed('a permission')).permissions.detected.network, ['example.com']);
  set('checks', { ...base.checks, findings: [{ check: 'rule', severity: 'medium', rule: 'r1' }, { check: 'long_line', severity: 'low' }] });
  assert.deepEqual((await changed('a finding')).checks.findings, { low: 1, medium: 1, high: 0 });
  set('checks', { ...base.checks, review: 'done' });
  assert.equal((await changed('the review')).checks.review, 'done');
  set('risk', 'medium');
  assert.equal((await changed('the risk')).risk, 'medium');
  set('status', 'yanked');
  assert.equal((await changed('a yanked version')).status, 'yanked');
  set('status', 'blocked');
  assert.equal((await changed('a blocked version')).status, 'blocked');
  sql(e, 'UPDATE items SET reviewed = 1 WHERE id = ?', a.id);
  assert.equal((await changed('a review by a person')).reviewed, true);
});

test('only a short, well-formed list is taken', async () => {
  const e = env();
  const one = { id: NOBODY, revision: 1 };
  const refused = async (body, headers, status = 400) => {
    const res = await post(e, body, headers);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
    // refused as the rest of the API refuses, and never kept
    assert.deepEqual(await res.json(), { error: 'invalid_request' });
    assert.equal(res.headers.get('cache-control'), null);
  };
  assert.equal((await post(e, { installed: Array.from({ length: 100 }, () => one) })).status, 200);
  await refused({ installed: Array.from({ length: 101 }, () => one) });
  await refused({ installed: [{ id: 'someone/pdf-forms', revision: 1 }] });
  await refused({ installed: [{ id: NOBODY, revision: 0 }] });
  await refused({ installed: [{ id: NOBODY, revision: '1' }] });
  await refused({ installed: [{ id: NOBODY }] });
  await refused({ installed: 'all' });
  await refused({});
  await refused('{"installed": [', undefined);
  await refused({ installed: [one] }, { 'content-type': 'text/plain' }, 415);
  await refused({ installed: [one] }, {}, 415);
  assert.equal((await post(e, { installed: [one] }, { 'content-type': 'application/json; charset=utf-8' })).status, 200);
  await refused({ installed: Array.from({ length: 100 }, () => one), padding: 'x'.repeat(20_000) }, undefined, 413);
});

test('each id is looked up by an index: no table is read through', async () => {
  const e = env();
  const plan = e.HARNESS_DB.rows(
    `EXPLAIN QUERY PLAN SELECT i.id, v.revision FROM json_each(?1) j
       LEFT JOIN items i ON i.id = json_extract(j.value, '$.id')
       LEFT JOIN publishers p ON p.id = i.publisher_id
       LEFT JOIN item_versions v ON v.item_id = i.id AND v.revision = json_extract(j.value, '$.revision')
      ORDER BY j.key`,
    '[]',
  ).map((r) => r.detail);
  assert.ok(plan.some((d) => /SEARCH i USING .*INDEX/.test(d)), plan.join('\n'));
  assert.ok(plan.some((d) => /SEARCH v USING .*INDEX/.test(d)), plan.join('\n'));
  assert.ok(!plan.some((d) => /^SCAN (i|v|p)\b/.test(d)), plan.join('\n'));
});

test('a version is kept no longer than the rest: what is derived from it can change', async () => {
  const e = env();
  await saveVersions(e, [versionInput()]);
  const res = await harnessApi.request('/items/someone/pdf-forms/versions/1', {}, e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60, s-maxage=300');
});

test('the API document describes it', async () => {
  const doc = await (await harnessApi.request('/openapi.json', {}, env())).json();
  const op = doc.paths['/resolve'].post;
  assert.ok(op.requestBody.required);
  assert.ok(doc.components.schemas.ResolveRequest && doc.components.schemas.VersionState && doc.components.schemas.Resolved);
});
