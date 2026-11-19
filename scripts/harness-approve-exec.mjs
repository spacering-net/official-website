#!/usr/bin/env node
// Approve a plugin revision for installing whole (docs/harness-plugins.md, section 6): a plugin that runs
// things on its own (hooks, code, MCP servers) is offered whole only at a package hash a maintainer has
// looked at. This prints what changed since the last approved revision, what runs on its own first, and
// on confirmation records the revision's package hash in exec_approvals.
//
//   pnpm harness:approve-exec <publisher>/<name> <revision> [--local] [--yes] [--note "…"]
//   pnpm harness:approve-exec <publisher>/<name> <revision> --revoke [--local] [--yes]
//
// --local works on the local D1 (wrangler's), otherwise on production's.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [ref, revisionText] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--note');
const revision = Number(revisionText);
if (!/^[a-z0-9][a-z0-9.-]{0,252}\/[a-z0-9-]{1,64}$/i.test(ref ?? '') || !Number.isInteger(revision) || revision < 1) {
  console.error('usage: pnpm harness:approve-exec <publisher>/<name> <revision> [--local] [--yes] [--revoke] [--note "…"]');
  process.exit(2);
}
const where = flag('--local') ? '--local' : '--remote';
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function d1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'HARNESS_DB', where, '--json', '-c', 'wrangler.jsonc', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const [handle, name] = ref.toLowerCase().split('/');
const [item] = d1(`SELECT i.id, i.kind, i.status FROM items i JOIN publishers p ON p.id = i.publisher_id WHERE p.handle = ${quote(handle)} AND i.name = ${quote(name)}`);
if (!item) throw new Error(`no item ${ref}`);
if (item.kind !== 'plugin') throw new Error(`${ref} is a ${item.kind}, not a plugin`);
const versions = d1(
  `SELECT v.id, v.revision, v.version, v.status, v.content_sha256, json_extract(v.metadata, '$.plugin.autorunFiles') AS autorun_files,
          json_extract(v.metadata, '$.plugin.mcpUnpinned') AS unpinned, a.content_sha256 IS NOT NULL AS approved
     FROM item_versions v LEFT JOIN exec_approvals a ON a.content_sha256 = v.content_sha256
    WHERE v.item_id = ${quote(item.id)} AND v.status != 'staged' ORDER BY v.revision`,
);
const target = versions.find((v) => v.revision === revision);
if (!target) throw new Error(`${ref} has no revision ${revision} (staged revisions are not shown until their reconcile)`);
console.log(`${ref} #${target.revision}${target.version ? ` (${target.version})` : ''}: ${target.status}, package ${target.content_sha256}`);
if (target.approved && !flag('--revoke')) {
  console.log('already approved');
  process.exit(0);
}
const unpinned = JSON.parse(target.unpinned ?? '[]');
if (unpinned.length) console.log(`note: MCP servers not pinned (${unpinned.join(', ')}): it is not offered whole while that is so, approved or not`);

const confirm = async (question) => {
  if (flag('--yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

if (flag('--revoke')) {
  if (!(await confirm(`Take back the approval of ${ref} #${revision}? Codeg turns its hooks off where it is installed whole.`))) process.exit(1);
  d1(`DELETE FROM exec_approvals WHERE content_sha256 = ${quote(target.content_sha256)}`);
  console.log('approval taken back');
  process.exit(0);
}

// what changed since the last approved revision before it (or everything, the first time)
const base = [...versions].reverse().find((v) => v.revision < revision && v.approved);
const filesOf = (id) => new Map(d1(`SELECT path, sha256, size, executable FROM version_files WHERE version_id = ${quote(id)}`).map((f) => [f.path, f]));
const now = filesOf(target.id);
const before = base ? filesOf(base.id) : new Map();
const autorun = new Set([...JSON.parse(target.autorun_files ?? '[]'), ...(base ? JSON.parse(base.autorun_files ?? '[]') : [])]);
// a file made executable is listed with what runs, wherever it is
const runnable = (c) => autorun.has(c.path) || /\+x/.test(c.what);
const changes = [];
for (const [path, f] of now) {
  const old = before.get(path);
  if (!old) changes.push({ path, what: f.executable ? 'added +x' : 'added', size: f.size });
  else if (old.sha256 !== f.sha256) changes.push({ path, what: old.executable !== f.executable ? `changed ${f.executable ? '+x' : '-x'}` : 'changed', size: f.size });
  // runnable now or no longer, the same bytes: a change to what runs as much as any
  else if (!!old.executable !== !!f.executable) changes.push({ path, what: f.executable ? 'now +x' : 'now -x', size: f.size });
}
for (const [path, f] of before) if (!now.has(path)) changes.push({ path, what: 'removed', size: f.size });
const show = (title, list) => {
  console.log(`\n${title} (${list.length})`);
  for (const c of list) console.log(`  ${c.what.padEnd(11)} ${c.path}  ${c.size} B`);
};
console.log(base ? `\ncompared with #${base.revision}${base.version ? ` (${base.version})` : ''}, the last approved` : '\nno revision approved before: every file');
show('runs on its own, is named by what does, or is executable', changes.filter(runnable));
show('everything else', changes.filter((c) => !runnable(c)));
console.log(`\nread the files at https://github.com/ (the revision's source commit) or GET /api/harness/v1/blobs/<sha256>`);

if (!(await confirm(`Approve ${ref} #${revision} for installing whole?`))) process.exit(1);
let by = process.env.USER ?? 'maintainer';
try {
  by = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || by;
} catch {}
d1(
  `INSERT INTO exec_approvals (content_sha256, approved_by, approved_at, note) VALUES (${quote(target.content_sha256)}, ${quote(by)}, ${quote(new Date().toISOString())}, ${quote(option('--note') ?? '')})
   ON CONFLICT (content_sha256) DO NOTHING`,
);
console.log('approved');
