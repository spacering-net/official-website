import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredIcons, MIN_PX, pngSize, refreshAvatars } from '../../api/harness/importers/avatars.ts';
import { testEnv } from './env.mjs';

const base = 'https://example.com/docs/';

test("a page's home-screen icon comes first, then icons declared big enough", () => {
  const html = `<html><head>
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
    <link rel='apple-touch-icon' href='apple.png?v=2&amp;x=1'>
    <link rel="stylesheet" href="/site.css">
  </head><body><link rel="icon" sizes="512x512" href="/late.png"></body></html>`;
  assert.deepEqual(declaredIcons(html, base), ['https://example.com/icon-192.png', 'https://example.com/docs/apple.png?v=2&x=1']);
});

test('drawings, .ico files, small icons and plain http are left out', () => {
  const html = `<head>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/favicon.ico" sizes="256x256">
    <link rel="shortcut icon" type="image/x-icon" href="/big" sizes="128x128">
    <link rel="apple-touch-icon" sizes="57x57" href="/small.png">
    <link rel="apple-touch-icon" href="http://example.com/insecure.png">
  </head>`;
  assert.deepEqual(declaredIcons(html, base), []);
});

test('a PNG tells its size; anything else is not a PNG', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 180);
  new DataView(png.buffer).setUint32(20, 96);
  assert.deepEqual(pngSize(png.buffer), { width: 180, height: 96 });
  assert.equal(pngSize(new TextEncoder().encode('GIF89a-not-a-png-at-all').buffer), null);
  assert.equal(pngSize(new ArrayBuffer(8)), null);
  assert.ok(MIN_PX >= 48);
});

// ---------------------------------------------------------------------------
// the job, with the network stood in for

const ID = '0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90';
const OLD = `/api/avatars/${ID}/aaaaaaaaaaaaaaaa.png`;

/** A PNG header this wide and tall, enough for the checks. */
function png(size) {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, size);
  new DataView(bytes.buffer).setUint32(20, size);
  return bytes;
}

/** A publisher with something on the shelves and a picture already kept. */
function withPublisher(kind) {
  const env = testEnv();
  const now = '2026-09-01T00:00:00.000Z';
  env.HARNESS_DB.sqlite
    .prepare(`INSERT INTO publishers (id, handle, kind, github_id, github_login, domain, name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ID, kind === 'github' ? 'someone' : 'example.com', kind, kind === 'github' ? 42 : null, kind === 'github' ? 'someone' : null, kind === 'domain' ? 'example.com' : null, 'Someone', OLD, now, now);
  env.HARNESS_DB.sqlite
    .prepare(`INSERT INTO items (id, publisher_id, name, kind, status, listed_reasons, runtime, risk, source, visibility, created_at, updated_at, version_at) VALUES ('item-1', ?, 'pdf', 'skill', 'public', '[]', 'none', 'low', 'github', 'public', ?, ?, ?)`)
    .run(ID, now, now, now);
  env.MEDIA.objects.set(OLD.slice('/api/'.length), new Uint8Array([1]));
  return env;
}

/** Answers by address; a function throws (a timeout), a number is a bare status. */
function network(answers) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const answer = answers[url] ?? 404;
    if (typeof answer === 'function') return answer();
    const res = typeof answer === 'number' ? new Response(null, { status: answer }) : answer;
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  return () => (globalThis.fetch = real);
}

const html = (head) => new Response(`<html><head>${head}</head><body></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const image = (bytes) => new Response(bytes, { headers: { 'content-type': 'image/png' } });
const timeout = () => {
  throw new DOMException('The operation timed out.', 'TimeoutError');
};
const row = (env) => env.HARNESS_DB.rows('SELECT avatar, avatar_checked_at FROM publishers WHERE id = ?', ID)[0];

test('a site that does not answer clearly keeps its picture, to be looked at again in days', async () => {
  for (const answers of [
    { 'https://example.com/': html('<link rel="apple-touch-icon" href="/touch.png">'), 'https://example.com/touch.png': 503, 'https://example.com/apple-touch-icon.png': timeout },
    { 'https://example.com/': html(''), 'https://example.com/apple-touch-icon.png': 429 },
    { 'https://example.com/': 503 },
    { 'https://example.com/': timeout },
  ]) {
    const env = withPublisher('domain');
    const restore = network(answers);
    try {
      await refreshAvatars(env, '');
    } finally {
      restore();
    }
    const after = row(env);
    assert.equal(after.avatar, OLD);
    assert.ok(env.MEDIA.objects.has(OLD.slice('/api/'.length)));
    const due = Date.parse(after.avatar_checked_at) + 30 * 24 * 60 * 60 * 1000 - Date.now();
    assert.ok(due > 2 * 24 * 60 * 60 * 1000 && due < 4 * 24 * 60 * 60 * 1000, `due again in ${due} ms`);
  }
});

test('a GitHub account that cannot be asked keeps its picture; one that is gone loses it', async () => {
  for (const [status, kept] of [
    [503, true],
    [429, true],
    [404, false],
  ]) {
    const env = withPublisher('github');
    const restore = network({ 'https://avatars.githubusercontent.com/u/42?s=160&v=4': status });
    try {
      await refreshAvatars(env, '');
    } finally {
      restore();
    }
    assert.equal(row(env).avatar, kept ? OLD : null);
    assert.equal(env.MEDIA.objects.has(OLD.slice('/api/'.length)), kept);
  }
});

test('a site that answers it has no icon loses the picture; a new icon replaces it', async () => {
  let env = withPublisher('domain');
  let restore = network({ 'https://example.com/': html('<link rel="icon" sizes="16x16" href="/tiny.png">'), 'https://example.com/apple-touch-icon.png': 404 });
  try {
    await refreshAvatars(env, '');
  } finally {
    restore();
  }
  assert.equal(row(env).avatar, null);
  assert.equal(env.MEDIA.objects.size, 0);

  env = withPublisher('domain');
  restore = network({ 'https://example.com/': html('<link rel="apple-touch-icon" href="/touch.png">'), 'https://example.com/touch.png': image(png(180)) });
  try {
    await refreshAvatars(env, '');
  } finally {
    restore();
  }
  const after = row(env);
  assert.match(after.avatar, new RegExp(`^/api/avatars/${ID}/[0-9a-f]{16}\\.png$`));
  assert.notEqual(after.avatar, OLD);
  assert.deepEqual([...env.MEDIA.objects.keys()], [after.avatar.slice('/api/'.length)]);
  assert.ok(Date.now() - Date.parse(after.avatar_checked_at) < 60_000);
});

test('a run with no clear answer leaves alone what an overlapping run has put in place', async () => {
  const env = withPublisher('domain');
  const real = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (first) {
      // the first run has read the old picture and is now asking the site; meanwhile
      // another run (the same job delivered twice) finds a new icon and puts it in place
      first = false;
      await refreshAvatars(env, '');
      return timeout();
    }
    const res = url === 'https://example.com/' ? html('<link rel="apple-touch-icon" href="/touch.png">') : url === 'https://example.com/touch.png' ? image(png(180)) : new Response(null, { status: 404 });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  try {
    await refreshAvatars(env, '');
  } finally {
    globalThis.fetch = real;
  }
  const after = row(env);
  assert.match(after.avatar, new RegExp(`^/api/avatars/${ID}/[0-9a-f]{16}\\.png$`));
  assert.notEqual(after.avatar, OLD);
  assert.deepEqual([...env.MEDIA.objects.keys()], [after.avatar.slice('/api/'.length)]);
});
