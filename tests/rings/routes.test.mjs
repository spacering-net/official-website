import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { keepAvatar } from '../../api/avatars.ts';
import { ringRoutes } from '../../api/rings/routes.ts';
import { ACCOUNT_MIGRATIONS, D1, R2 } from '../harness/env.mjs';

const PUBLIC = new URL('../../public/', import.meta.url);
const ID = '01900000-0000-7000-8000-000000000001';
const AVATAR = `/api/avatars/${ID}/0123456789abcdef.png`;
const SHARED = 'public, max-age=600, s-maxage=2592000';

/** The bindings the routes use: the accounts database, R2, the site's files, the render limit. */
function setup({ image = AVATAR, name = 'Ada Ring', limited = false } = {}) {
  const DB = new D1(ACCOUNT_MIGRATIONS);
  DB.sqlite
    .prepare('INSERT INTO users (id, number, name, email, image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ID, 10000, name, 'ada@example.com', image, '2026-10-07T03:12:00.000Z', '2026-10-07T03:12:00.000Z');
  const MEDIA = new R2();
  MEDIA.objects.set(`avatars/${ID}/0123456789abcdef.png`, new Uint8Array(readFileSync(new URL('apple-touch-icon.png', PUBLIC))));
  const renders = { count: 0 };
  const env = {
    DB,
    MEDIA,
    SITE_URL: 'https://spacering.net',
    BETTER_AUTH_SECRET: 'test secret',
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        // as under `astro dev`, where a query is part of the file asked for
        if (url.search) return new Response('Not found', { status: 404 });
        try {
          return new Response(readFileSync(new URL(`.${url.pathname}`, PUBLIC)));
        } catch {
          return new Response('Not found', { status: 404 });
        }
      },
    },
    RING_LIMIT: {
      async limit() {
        renders.count++;
        return { success: !limited };
      },
    },
  };
  const user = { id: ID, number: 10000, name, image, createdAt: '2026-10-07T03:12:00.000Z' };
  let signedIn = true;
  const app = new Hono().basePath('/api').route('/', ringRoutes(async () => (signedIn ? user : null)));
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const call = async (path, init = {}) => {
    const res = await app.fetch(new Request(`https://spacering.net${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    // the security log is written after the answer (later())
    await new Promise((r) => setTimeout(r, 5));
    return res;
  };
  const write = (method, body, headers = {}) =>
    call('/api/me/card', { method, headers: { origin: 'https://spacering.net', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const log = () => DB.rows('SELECT type, data FROM audit_events ORDER BY created_at, rowid').map((r) => r.type);
  return { env, call, write, log, renders, signOut: () => (signedIn = false) };
}

/** A JPEG's size, from its frame header. */
function jpegSize(bytes) {
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'not a JPEG');
  for (let i = 2; i + 9 < bytes.length; ) {
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { width: (bytes[i + 7] << 8) | bytes[i + 8], height: (bytes[i + 5] << 8) | bytes[i + 6] };
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

// This Cloudflare location's cache, as a map
let kept;
beforeEach(() => {
  kept = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => kept.get(req.url)?.clone(),
      put: async (req, res) => void kept.set(req.url, res),
    },
  };
});
afterEach(() => delete globalThis.caches);

test('signed out, there is no card to see or change', async () => {
  const t = setup();
  t.signOut();
  assert.equal((await t.call('/api/me/card')).status, 401);
  assert.equal((await t.call('/api/me/card.jpg')).status, 401);
  assert.equal((await t.write('PUT', { showName: true, showImage: false })).status, 401);
  assert.equal((await t.write('DELETE')).status, 401);
  assert.equal(t.renders.count, 0);
});

test('changes come only from the site itself, as JSON, with both choices', async () => {
  const t = setup();
  assert.equal((await t.write('PUT', { showName: true, showImage: false }, { origin: '' })).status, 403);
  assert.equal((await t.write('PUT', { showName: true, showImage: false }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await t.write('DELETE', undefined, { origin: 'https://spacering.net.example.com' })).status, 403);
  assert.equal((await t.write('PUT', { showName: true, showImage: false }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await t.write('PUT', { showName: 'yes', showImage: false })).status, 400);
  assert.equal((await t.write('PUT', { showName: true })).status, 400);
  assert.deepEqual(t.env.DB.rows('SELECT * FROM ring_cards'), []);
});

test('sharing, changing what the card shows, and stopping, each in the security log', async () => {
  const t = setup();
  const before = await (await t.call('/api/me/card')).json();
  assert.deepEqual(before.card, { number: 10000, name: 'Ada Ring', image: AVATAR, since: '2026-10-07T03:12:00.000Z', shared: false, showName: false, showImage: false });

  const shared = await (await t.write('PUT', { showName: true, showImage: true })).json();
  assert.deepEqual([shared.card.shared, shared.card.showName, shared.card.showImage], [true, true, true]);
  assert.deepEqual((await (await t.call('/api/me/card')).json()).card, shared.card);

  await t.write('PUT', { showName: false, showImage: true });
  const stopped = await (await t.write('DELETE')).json();
  assert.equal(stopped.card.shared, false);
  await t.write('DELETE');
  assert.deepEqual(t.log(), ['ring_card.shared', 'ring_card.changed', 'ring_card.unshared']);
});

/** Answers fetches from a sign-in provider's picture host with a picture; the addresses asked for go in `asked`. */
function providerPictures(asked) {
  const picture = readFileSync(new URL('apple-touch-icon.png', PUBLIC));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const res = new Response(picture, { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  };
  return () => (globalThis.fetch = real);
}

test("a picture still at the sign-in provider is copied here when the card is opened", async () => {
  const google = 'https://lh3.googleusercontent.com/a/abc=s96-c';
  const t = setup({ image: google });
  const asked = [];
  const restore = providerPictures(asked);
  try {
    const { card } = await (await t.call('/api/me/card')).json();
    assert.match(card.image, new RegExp(`^/api/avatars/${ID}/[0-9a-f]{16}\\.png$`));
    assert.deepEqual(asked, ['https://lh3.googleusercontent.com/a/abc=s256-c']);
    assert.equal(t.env.DB.rows('SELECT image FROM users')[0].image, card.image);
    assert.ok(t.env.MEDIA.objects.has(`avatars/${ID}/${card.image.split('/').pop()}`));
  } finally {
    restore();
  }

  // a provider that cannot be reached: the card opens, without a picture for now
  const offline = setup({ image: google });
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('offline');
  };
  try {
    const res = await offline.call('/api/me/card');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).card.image, null);
    assert.equal(offline.env.DB.rows('SELECT image FROM users')[0].image, google);
  } finally {
    globalThis.fetch = real;
  }
});

test('a sign-in copies a picture still at the provider, and leaves one of ours alone', async () => {
  const asked = [];
  const restore = providerPictures(asked);
  try {
    const t = setup({ image: 'https://avatars.githubusercontent.com/u/1?v=4' });
    await keepAvatar(t.env, ID);
    assert.deepEqual(asked, ['https://avatars.githubusercontent.com/u/1?v=4&s=256']);
    assert.match(t.env.DB.rows('SELECT image FROM users')[0].image, /^\/api\/avatars\//);
    // once ours, a sign-in fetches nothing
    await keepAvatar(t.env, ID);
    assert.equal(asked.length, 1);
    const own = setup();
    await keepAvatar(own.env, ID);
    assert.equal(asked.length, 1);
  } finally {
    restore();
  }
});

test('a picture can be shown only once there is a copy of it here', async () => {
  const t = setup({ image: 'https://avatars.githubusercontent.com/u/1?v=4' });
  const { card } = await (await t.write('PUT', { showName: false, showImage: true })).json();
  assert.equal(card.image, null);
  assert.equal(card.showImage, false);
});

test("a shared card's picture: found by its version, the card's size, kept at the edge", async () => {
  const t = setup();
  assert.equal((await t.call('/api/rings/10000/card-en-000000000000.jpg')).status, 404);
  await t.write('PUT', { showName: true, showImage: true });

  // an address from before the card changed leads to the one it has now
  const old = await t.call('/api/rings/10000/card-en-000000000000.jpg');
  assert.equal(old.status, 302);
  const where = old.headers.get('location');
  assert.match(where, /^\/api\/rings\/10000\/card-en-[0-9a-f]{12}\.jpg$/);

  const res = await t.call(where);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), SHARED);
  assert.deepEqual(jpegSize(new Uint8Array(await res.arrayBuffer())), { width: 1200, height: 630 });
  assert.equal(kept.size, 1);
  assert.equal(t.renders.count, 1);

  // again: from the cache, without rendering
  const again = await t.call(where);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('cache-control'), SHARED);
  assert.equal(t.renders.count, 1);

  // the other language is a picture of its own
  const zh = await t.call('/api/rings/10000/card-zh-000000000000.jpg');
  assert.match(zh.headers.get('location'), /card-zh-/);
  assert.notEqual(zh.headers.get('location'), where);

  // what the card shows changes: so does its address
  await t.write('PUT', { showName: false, showImage: false });
  const moved = await t.call(where);
  assert.equal(moved.status, 302);
  assert.notEqual(moved.headers.get('location'), where);

  // once sharing stops, nothing is served, not even what the edge kept
  await t.write('DELETE');
  assert.equal((await t.call(where)).status, 404);
  assert.equal((await t.call(moved.headers.get('location'))).status, 404);
});

test('addresses that are not a ring card are not found', async () => {
  const t = setup();
  await t.write('PUT', { showName: true, showImage: false });
  for (const path of ['/api/rings/1000/card-en-000000000000.jpg', '/api/rings/10001/card-en-000000000000.jpg', '/api/rings/10000/card-fr-000000000000.jpg', '/api/rings/10000/card-en-xyz.jpg', '/api/rings/10000/']) {
    assert.equal((await t.call(path)).status, 404, path);
  }
});

test('the holder can save their card as they set it up, shared or not', async () => {
  const t = setup();
  const res = await t.call('/api/me/card.jpg?name=1&image=1&lang=zh&download=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="spacering-srn-10000.jpg"');
  assert.deepEqual(jpegSize(new Uint8Array(await res.arrayBuffer())), { width: 1200, height: 630 });
  assert.deepEqual(t.env.DB.rows('SELECT * FROM ring_cards'), []);
  assert.equal(kept.size, 0);
});

test('rendering is limited per address', async () => {
  const t = setup({ limited: true });
  assert.equal((await t.call('/api/me/card.jpg')).status, 429);
  await t.write('PUT', { showName: false, showImage: false });
  const where = (await t.call('/api/rings/10000/card-en-000000000000.jpg')).headers.get('location');
  const res = await t.call(where);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
});

test('a name whose fonts cannot be had is drawn without them, and the picture is not kept', async () => {
  const t = setup({ name: '汤新德 Ada' });
  await t.write('PUT', { showName: true, showImage: false });
  const where = (await t.call('/api/rings/10000/card-en-000000000000.jpg')).headers.get('location');
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('offline');
  };
  try {
    const res = await t.call(where);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.ok(jpegSize(new Uint8Array(await res.arrayBuffer())));
    assert.equal(kept.size, 0);
  } finally {
    globalThis.fetch = real;
  }
});
