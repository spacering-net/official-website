// A stand-in for the Worker's bindings, for tests: D1 on Node's built-in SQLite (FTS5 and JSON
// included) with the Harness migrations applied (or the accounts', given their folder), R2 as a
// map, the queue as a list.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../db/harness/', import.meta.url);
export const ACCOUNT_MIGRATIONS = new URL('../../db/migrations/', import.meta.url);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  #stmt() {
    return this.db.sqlite.prepare(this.sql);
  }
  async first() {
    return this.#stmt().get(...this.params) ?? null;
  }
  async all() {
    return { results: this.#stmt().all(...this.params), meta: {} };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const info = this.#stmt().run(...this.params);
    return { results: [], meta: { changes: Number(info.changes) } };
  }
}

export class D1 {
  constructor(migrations = MIGRATIONS) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(f, migrations), 'utf8'));
    /** called before each batch runs; a test can fail one on purpose */
    this.beforeBatch = null;
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  /** all or nothing, like D1 */
  async batch(statements) {
    this.beforeBatch?.(statements);
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.runSync());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }
  rows(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params);
  }
}

export class R2 {
  constructor() {
    this.objects = new Map();
    /** called on every get; a test can make something happen meanwhile */
    this.onGet = null;
  }
  async head(key) {
    return this.objects.has(key) ? { key } : null;
  }
  async put(key, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.objects.set(key, bytes);
  }
  async delete(keys) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }
  async get(key) {
    await this.onGet?.(key);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer, httpEtag: '"x"' };
  }
}

export function testEnv() {
  const sent = [];
  return {
    HARNESS_DB: new D1(),
    HARNESS_FILES: new R2(),
    MEDIA: new R2(),
    HARNESS_JOBS: { send: async (body) => sent.push(body), sendBatch: async (msgs) => sent.push(...msgs.map((m) => m.body)) },
    GITHUB_TOKEN: '',
    sent,
  };
}

const enc = new TextEncoder();

/** A checked version as the importers make them, with the parts a test cares about overridable. */
export function versionInput(over = {}) {
  const name = over.name ?? 'pdf-forms';
  return {
    sourceKey: `github:someone/skills:skills/${name}`,
    source: 'github',
    publisher: { kind: 'github', handle: 'someone', name: 'someone', githubLogin: 'someone' },
    name,
    kind: 'skill',
    listing: { title: { en: 'PDF forms' }, summary: { en: 'Fill and sign PDF forms from a chat.' }, sources: { title: {}, summary: {} }, tags: ['documents'] },
    repositoryUrl: 'https://github.com/someone/skills',
    license: 'MIT',
    runtime: 'python',
    dedupeKey: `skill:${name}`,
    owns: true,
    version: '1.0.0',
    contentSha256: 'c1',
    sourceCommit: 'abc123',
    sourceUrl: 'https://github.com/someone/skills/tree/abc123/skills/pdf-forms',
    files: [{ path: 'SKILL.md', data: enc.encode('---\nname: pdf-forms\ndescription: Fill and sign PDF forms.\n---\n# PDF forms\n'), executable: false }],
    hosted: true,
    metadata: { skill: { name, description: 'Fill and sign PDF forms.' }, repository: 'someone/skills', path: `skills/${name}` },
    permissions: { declared: {}, detected: { runsCode: [], installs: [], installScripts: [], network: [], secrets: [], paths: [], tools: [] } },
    checks: {
      format: { errors: [], warnings: [], dropped: [] },
      secrets: [],
      findings: [],
      rules: null,
      quality: { reasons: [], score: 1 },
      review: 'off',
      checkedAt: '2026-10-07T00:00:00.000Z',
    },
    packages: [],
    readme: '# PDF forms\nFill in forms.',
    excerpt: 'PDF forms Fill in forms.',
    versionAt: '2026-10-01T00:00:00.000Z',
    risk: 'low',
    repoStars: 10,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// tarballs, as GitHub's codeload serves them

/** A ustar header, as git archive writes them. */
function header(name, size, type = '0', mode = 0o644) {
  const h = new Uint8Array(512);
  const put = (s, at, len) => h.set(enc.encode(s).subarray(0, len), at);
  put(name, 0, 100);
  put(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

const pad = (data) => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
};
export const entry = (name, text, type = '0', mode = 0o644) => {
  const data = enc.encode(text);
  return [header(name, data.length, type, mode), pad(data)];
};
export const paxRecord = (key, value) => {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
};

export function tarball(parts) {
  const all = [...parts.flat(), new Uint8Array(1024)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}


/** A gzipped tarball of these files ({ path: text }), all under one top folder. */
export async function tarGz(top, files) {
  const bytes = tarball(Object.entries(files).map(([path, text]) => entry(`${top}/${path}`, text)));
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
