#!/usr/bin/env node
// Turn Harness plugins on or off on production (docs/harness-plugins.md, section 11), after a deployment
// with HARNESS_PLUGINS set to the same value (wrangler.jsonc). It
//   1. checks the live Worker answers with that switch (/config's kinds),
//   2. queues a reconcile of every enabled GitHub source and of any source whose plugins still hold members,
//   3. waits for each to end under that switch (import_sources.stats.reconciled), queueing again those that do not,
//   4. checks what must hold after it,
//   5. recounts the facets (and mends the search index) and waits for it,
//   6. purges Harness's pages and answers from Cloudflare's cache (the `harness` cache tag, api/harness/cache.ts),
//   7. prints the counts before and after.
//
//   CF_PURGE_TOKEN=… pnpm harness:plugins on|off
//
// CF_PURGE_TOKEN: an API token with only Zone › Cache Purge on spacering.net, kept on this machine.
// Everything else goes through wrangler's login.
import { execFileSync } from 'node:child_process';

const SITE = 'https://spacering.net';
const ZONE = 'spacering.net';
const QUEUE = 'harness-jobs';
const POLL_MS = 15_000;
/** a source with no reconcile after this long is queued again, once */
const AGAIN_MS = 10 * 60_000;
const GIVE_UP_MS = 30 * 60_000;

const want = process.argv[2];
if (want !== 'on' && want !== 'off') {
  console.error('usage: CF_PURGE_TOKEN=… pnpm harness:plugins on|off');
  process.exit(2);
}
const purgeToken = process.env.CF_PURGE_TOKEN;
if (!purgeToken) {
  console.error('CF_PURGE_TOKEN is not set (an API token with Zone › Cache Purge on spacering.net)');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'HARNESS_DB', '--remote', '--json', '-c', 'wrangler.jsonc', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const wranglerToken = (() => {
  const out = execFileSync('npx', ['wrangler', 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.slice(out.indexOf('{'))).token;
})();

async function cf(path, { token = wranglerToken, method = 'GET', body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const o = await res.json();
  if (!o.success) throw new Error(`${method} ${path}: ${JSON.stringify(o.errors)}`);
  return o.result;
}

// 1. the live Worker's switch
const config = await (await fetch(`${SITE}/api/harness/v1/config?switch=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } })).json();
const live = config.kinds.includes('plugin') ? 'on' : 'off';
if (live !== want) {
  console.error(`the live Worker has plugins ${live}: deploy HARNESS_PLUGINS="${want}" first`);
  process.exit(1);
}
console.log(`live Worker: plugins ${live}`);

const [account] = await cf('/accounts');
const queue = (await cf(`/accounts/${account.id}/queues`)).find((q) => q.queue_name === QUEUE);
if (!queue) throw new Error(`no queue ${QUEUE}`);
const [zone] = await cf(`/zones?name=${ZONE}`);
if (!zone) throw new Error(`no zone ${ZONE}`);
const send = (job) => cf(`/accounts/${account.id}/queues/${queue.queue_id}/messages`, { method: 'POST', body: { body: job } });

function counts() {
  const [row] = d1(`SELECT
      (SELECT COUNT(*) FROM items WHERE kind = 'plugin' AND status = 'public' AND visibility = 'public') AS plugins,
      (SELECT COUNT(*) FROM items WHERE kind = 'plugin' AND status = 'listed') AS listedPlugins,
      (SELECT COUNT(*) FROM items WHERE covered_by IS NOT NULL) AS held,
      (SELECT COUNT(*) FROM items WHERE status = 'deleted') AS deleted`);
  const facets = Object.fromEntries(d1("SELECT key, count FROM facets WHERE key = 'all' OR key LIKE 'kind:%' ORDER BY key").map((f) => [f.key, f.count]));
  return { ...row, ...facets };
}
const before = counts();

// 2. what to reconcile: enabled GitHub sources, and any source whose plugins still hold members
const sources = d1(
  `SELECT id FROM import_sources WHERE kind = 'github' AND enabled = 1
   UNION
   SELECT DISTINCT s.id FROM import_sources s JOIN items p ON p.source_key >= s.id || ':' AND p.source_key < s.id || ':' || char(1114111)
    WHERE p.kind = 'plugin' AND EXISTS (SELECT 1 FROM items m WHERE m.covered_by = p.id)
   ORDER BY id`,
).map((r) => r.id);
// times as Cloudflare's clock has them (the jobs stamp theirs with it), not this machine's
const cloudNow = () => d1("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now")[0].now;
const startedAt = cloudNow();
console.log(`reconciling ${sources.length} sources`);
for (const id of sources) await send({ type: 'github.reconcile', source: id });

// 3. wait until each has a reconcile that ended after this began, under this switch
const queuedAgain = new Set();
const t0 = Date.now();
let marks;
for (;;) {
  await sleep(POLL_MS);
  const rows = d1(`SELECT id, json_extract(stats, '$.reconciled') AS mark FROM import_sources WHERE id IN (${sources.map(quote).join(', ')})`);
  marks = new Map(rows.map((r) => [r.id, r.mark ? JSON.parse(r.mark) : null]));
  const pending = sources.filter((id) => !(marks.get(id)?.at > startedAt && marks.get(id)?.plugins === want));
  process.stdout.write(`\r${sources.length - pending.length}/${sources.length} reconciled `);
  if (!pending.length) break;
  if (Date.now() - t0 > GIVE_UP_MS) {
    console.error(`\nstill not reconciled after ${GIVE_UP_MS / 60_000} minutes: ${pending.join(', ')}; run this again`);
    process.exit(1);
  }
  if (Date.now() - t0 > AGAIN_MS) {
    for (const id of pending.filter((id) => !queuedAgain.has(id))) {
      queuedAgain.add(id);
      await send({ type: 'github.reconcile', source: id });
      console.log(`\nqueued ${id} again`);
    }
  }
}
console.log('');
const skipped = [...marks].filter(([, m]) => m.skipped?.length).map(([id, m]) => `${id}: ${m.skipped.join(', ')}`);
if (skipped.length) console.warn(`groups left as they were (too big):\n  ${skipped.join('\n  ')}`);

// 4. what must hold
const problems = [];
const check = (what, sql) => {
  const rows = d1(sql);
  if (rows.length) problems.push(`${what}:\n  ${rows.map((r) => Object.values(r).join(' ')).join('\n  ')}`);
};
check(
  'plugins holding members that are not public',
  "SELECT p.source_key, p.status FROM items p WHERE p.kind = 'plugin' AND (p.status != 'public' OR p.visibility != 'public') AND EXISTS (SELECT 1 FROM items m WHERE m.covered_by = p.id) LIMIT 20",
);
check('held members that are not deleted', "SELECT source_key, status FROM items WHERE covered_by IS NOT NULL AND status != 'deleted' LIMIT 20");
if (want === 'off') check('members still held with plugins off', 'SELECT source_key, status FROM items WHERE covered_by IS NOT NULL LIMIT 20');
else {
  // public plugins' members still on the shelves: the runs' plugin lists are read here and the items asked
  // for in chunks (one query joining them all runs past D1's CPU limit on production)
  const runs = d1(
    `SELECT r.plugins FROM import_sources s JOIN import_runs r ON r.run_id = s.staged_run WHERE r.plugins IS NOT NULL AND s.id IN (${sources.map(quote).join(', ')})`,
  );
  const pairs = runs.flatMap((r) => (JSON.parse(r.plugins).plugins ?? []).flatMap((p) => (p.members ?? []).map((m) => [p.key, m])));
  const chunks = (list) => Array.from({ length: Math.ceil(list.length / 80) }, (_, i) => list.slice(i * 80, i * 80 + 80).map(quote).join(', '));
  const pub = new Set();
  for (const keys of chunks([...new Set(pairs.map(([p]) => p))]))
    for (const r of d1(`SELECT source_key FROM items WHERE kind = 'plugin' AND status = 'public' AND visibility = 'public' AND source_key IN (${keys})`)) pub.add(r.source_key);
  const stillPublic = [];
  for (const keys of chunks([...new Set(pairs.filter(([p]) => pub.has(p)).map(([, m]) => m))]))
    stillPublic.push(...d1(`SELECT source_key, status FROM items WHERE status = 'public' AND source_key IN (${keys})`));
  if (stillPublic.length) problems.push(`public plugins' members still on the shelves:\n  ${stillPublic.slice(0, 20).map((r) => r.source_key).join('\n  ')}`);
}
if (problems.length) {
  console.error(`not as it should be (nothing purged; look, then run this again):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('checked: plugins and their members are where the switch says');

// 5. recount (the facets job also mends the search index) and wait for it
const facetsFrom = cloudNow();
await send({ type: 'facets' });
for (const t1 = Date.now(); ; ) {
  await sleep(POLL_MS);
  const [{ at }] = d1('SELECT MAX(updated_at) AS at FROM facets');
  if (at > facetsFrom) break;
  if (Date.now() - t1 > GIVE_UP_MS) {
    console.error('the facets were not recounted; nothing purged; run this again');
    process.exit(1);
  }
}
const stray = d1("SELECT COUNT(*) AS n FROM item_search s JOIN items i ON i.seq = s.rowid WHERE i.status != 'public' OR i.visibility != 'public'")[0].n;
if (stray) {
  console.error(`${stray} rows in the search index are not public items; nothing purged; run this again`);
  process.exit(1);
}
console.log('facets recounted, search index clean');

// 6. purge Harness's cached pages, answers and sitemap everywhere
await cf(`/zones/${zone.id}/purge_cache`, { token: purgeToken, method: 'POST', body: { tags: ['harness'] } });
console.log('cache purged (tag harness)');

// 7. before and after
const after = counts();
const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
console.log('\n' + keys.map((k) => `${k.padEnd(16)} ${String(before[k] ?? 0).padStart(7)} → ${after[k] ?? 0}`).join('\n'));
