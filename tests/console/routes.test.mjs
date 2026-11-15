import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { consoleRoutes } from '../../api/console/routes.ts';
import { keyedHash } from '../../api/audit.ts';
import { avatarKey, copyAvatar, imageInfo } from '../../api/avatars.ts';
import { ACCOUNT_MIGRATIONS, D1, R2 } from '../harness/env.mjs';

const ID = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const CURRENT = '01900000-0000-7000-8000-0000000000a1';
const LAPTOP = '01900000-0000-7000-8000-0000000000a2';
const PHONE = '01900000-0000-7000-8000-0000000000a3';
const STALE = '01900000-0000-7000-8000-0000000000a4';
const THEIRS = '01900000-0000-7000-8000-0000000000b1';
const SECRET = 'test-secret';
const SITE = 'https://spacering.net';
const iso = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
const USER = { id: ID, number: 10000, name: 'Ada', image: null, createdAt: '2026-10-07T03:12:00.000Z', sessionId: CURRENT };

/** Workers Rate Limiting stand-in: a fixed number of calls per key. */
const binding = (limit) => {
  const hits = new Map();
  return { hits, async limit({ key }) { hits.set(key, (hits.get(key) ?? 0) + 1); return { success: hits.get(key) <= limit }; } };
};

async function setup({ limit = 300 } = {}) {
  const DB = new D1(ACCOUNT_MIGRATIONS);
  const user = DB.sqlite.prepare("INSERT INTO users (id, number, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-10-07T03:12:00.000Z', '2026-10-07T03:12:00.000Z')");
  user.run(ID, 10000, 'Ada', 'ada@example.com');
  user.run(OTHER, 10001, 'Bo', 'bo@example.com');
  const account = DB.sqlite.prepare("INSERT INTO accounts (id, user_id, provider_id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  account.run('01900000-0000-7000-8000-0000000000c1', ID, 'github', '1', '2026-10-07T03:12:00.000Z', '2026-10-07T03:12:00.000Z');
  account.run('01900000-0000-7000-8000-0000000000c2', OTHER, 'google', '2', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
  const session = DB.sqlite.prepare('INSERT INTO sessions (id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  session.run(CURRENT, ID, 'token-current', iso(24 * 30), '203.0.113.7', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36', iso(-2), iso(-1));
  session.run(LAPTOP, ID, 'token-laptop', iso(24 * 10), '198.51.100.2', 'Mozilla/5.0 (Windows NT 10.0) Firefox/140.0', iso(-48), iso(-30));
  session.run(PHONE, ID, 'token-phone', iso(24 * 20), null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1', iso(-72), iso(-3));
  session.run(STALE, ID, 'token-stale', iso(-1), null, null, iso(-800), iso(-790));
  session.run(THEIRS, OTHER, 'token-theirs', iso(24), null, null, iso(-5), iso(-5));
  const env = { DB, MEDIA: new R2(), SITE_URL: SITE, BETTER_AUTH_SECRET: SECRET, CLIENT_LIMIT: binding(limit) };
  let signedIn = USER;
  const app = new Hono().basePath('/api').route('/', consoleRoutes(async () => signedIn));
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const call = async (path, init = {}) => {
    const res = await app.fetch(new Request(`${SITE}${path}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    // the security log is written after the answer (later())
    await new Promise((r) => setTimeout(r, 5));
    return res;
  };
  const change = (path, method, body = { expected_srn: 10000 }, headers = {}) =>
    call(path, { method, headers: { origin: SITE, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { DB, env, call, change, signIn: (next) => { signedIn = next; } };
}

test('the account: who, how they sign in, and what is connected', async () => {
  const t = await setup();
  const now = new Date().toISOString();
  // one connection in use, one disconnected, one of someone else's
  const connection = t.DB.sqlite.prepare(`INSERT INTO client_sessions (id, user_id, client_id, grant_kind, scope, installation_id, platform, token_hash, source_request_id, created_at, last_used_at, renewed_at, expires_at, revoked_at)
    VALUES (?, ?, 'codeg-desktop', 'srn-desktop-code-v1', 'profile:read', 'i', 'macos', ?, ?, ?, ?, ?, ?, ?)`);
  connection.run('01900000-0000-7000-8000-0000000000d1', ID, 'h1', 'r1', now, now, now, iso(24), null);
  connection.run('01900000-0000-7000-8000-0000000000d2', ID, 'h2', 'r2', now, now, now, iso(24), now);
  connection.run('01900000-0000-7000-8000-0000000000d3', OTHER, 'h3', 'r3', now, now, now, iso(24), null);
  const log = t.DB.sqlite.prepare('INSERT INTO audit_events (id, user_id, type, data, ip_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  log.run('01900000-0000-7000-8000-0000000000e1', ID, 'session.created', '{"provider":"github"}', null, 'Agent A', '2026-11-01T00:00:00.000Z');
  log.run('01900000-0000-7000-8000-0000000000e2', ID, 'session.created', null, null, 'Agent B', '2026-11-02T00:00:00.000Z');
  log.run('01900000-0000-7000-8000-0000000000e3', OTHER, 'session.created', null, null, 'Agent C', '2026-11-03T00:00:00.000Z');

  const res = await t.call('/api/me/account');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.account_srn, 10000);
  assert.deepEqual(data.user, { number: 10000, name: 'Ada', image: null, email: 'ada@example.com', since: '2026-10-07T03:12:00.000Z' });
  assert.deepEqual(data.providers, [{ provider: 'github', linked_at: '2026-10-07T03:12:00.000Z' }]);
  assert.equal(data.sessions, 3, 'unexpired browser sessions only, this one included');
  assert.equal(data.clients, 1, 'connections in use only');
  assert.deepEqual(data.last_sign_in, { at: '2026-11-02T00:00:00.000Z', user_agent: 'Agent B', provider: null });

  t.signIn(null);
  assert.equal((await t.call('/api/me/account')).status, 401);
  t.signIn(USER);
  assert.equal((await t.call('/api/me/account', { headers: { authorization: 'Bearer x' } })).status, 403, 'a client token is never accepted');
});

test('the browsers signed in: their own, unexpired, never with a token', async () => {
  const t = await setup();
  const res = await t.call('/api/me/sessions');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.account_srn, 10000);
  assert.deepEqual(data.sessions.map((s) => s.id), [CURRENT, PHONE, LAPTOP], 'most recently active first; expired and other people’s left out');
  assert.deepEqual(data.sessions.map((s) => s.current), [true, false, false]);
  for (const s of data.sessions) assert.deepEqual(Object.keys(s).sort(), ['created_at', 'current', 'expires_at', 'id', 'ip_address', 'updated_at', 'user_agent']);
  assert.ok(!JSON.stringify(data).includes('token-'), 'no session token leaves the server');
});

test('signing one other browser out', async () => {
  const t = await setup();
  const gone = () => !t.DB.rows('SELECT id FROM sessions WHERE id = ?', LAPTOP).length;
  assert.equal((await t.change(`/api/me/sessions/${LAPTOP}`, 'DELETE', { expected_srn: 10000 }, { origin: 'https://example.com' })).status, 403, 'only from the site');
  assert.equal((await t.call(`/api/me/sessions/${LAPTOP}`, { method: 'DELETE', headers: { origin: SITE } })).status, 400, 'a JSON body with the ring number shown');
  assert.equal((await t.change(`/api/me/sessions/${LAPTOP}`, 'DELETE', { expected_srn: 10001 })).status, 409, 'for the account the page shows');
  assert.equal((await t.change('/api/me/sessions/not-an-id', 'DELETE')).status, 400);
  assert.equal((await t.change(`/api/me/sessions/${CURRENT}`, 'DELETE')).status, 400, 'this browser signs out the usual way');
  assert.equal((await t.change(`/api/me/sessions/${THEIRS}`, 'DELETE')).status, 404, 'someone else’s is not found');
  assert.equal(t.DB.rows('SELECT id FROM sessions WHERE id = ?', THEIRS).length, 1);
  assert.equal(gone(), false);

  const res = await t.change(`/api/me/sessions/${LAPTOP}`, 'DELETE');
  assert.equal(res.status, 200);
  assert.equal(gone(), true, 'deleting the row signs the browser out at once');
  assert.equal((await t.change(`/api/me/sessions/${LAPTOP}`, 'DELETE')).status, 404);
  const [event] = t.DB.rows("SELECT user_id, data FROM audit_events WHERE type = 'session.revoked'");
  assert.deepEqual({ ...event }, { user_id: ID, data: '{"count":1}' });

  t.signIn(null);
  assert.equal((await t.change(`/api/me/sessions/${PHONE}`, 'DELETE')).status, 401);
});

test('signing every other browser out leaves this one and other people’s', async () => {
  const t = await setup();
  assert.equal((await t.change('/api/me/sessions/revoke-others', 'POST', { expected_srn: 10000 }, { origin: 'null' })).status, 403);
  assert.equal((await t.change('/api/me/sessions/revoke-others', 'POST', { expected_srn: 10001 })).status, 409);
  const res = await t.change('/api/me/sessions/revoke-others', 'POST');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signed_out: 3 });
  assert.deepEqual(t.DB.rows('SELECT id FROM sessions ORDER BY id').map((r) => r.id), [CURRENT, THEIRS]);
  assert.equal(t.DB.rows("SELECT data FROM audit_events WHERE type = 'session.revoked'")[0].data, '{"count":3}');
  // nothing left to sign out: nothing logged
  assert.deepEqual(await (await t.change('/api/me/sessions/revoke-others', 'POST')).json(), { ok: true, signed_out: 0 });
  assert.equal(t.DB.rows("SELECT id FROM audit_events WHERE type = 'session.revoked'").length, 1);
});

test('the security log: newest first, a page at a time, the visitor’s network marked', async () => {
  const t = await setup();
  const here = await keyedHash('203.0.113.7', SECRET);
  const log = t.DB.sqlite.prepare('INSERT INTO audit_events (id, user_id, type, data, ip_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const id = (n) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  for (let n = 1; n <= 55; n++) log.run(id(n), ID, 'ring_card.changed', '{"showName":true}', n % 2 ? here : 'elsewhere', 'Agent', `2026-11-01T00:00:${String(n).padStart(2, '0')}.000Z`);
  log.run(id(60), ID, 'session.created', '{"provider":"google"}', here, 'Agent', '2026-11-02T00:00:00.000Z');
  log.run(id(61), ID, 'client.connected', '{"connection_id":"x","client_id":"codeg-desktop"}', null, 'codeg/0.9', '2026-11-03T00:00:00.000Z');
  log.run(id(62), ID, 'session.revoked', '{"count":2}', null, null, '2026-11-04T00:00:00.000Z');
  log.run(id(63), OTHER, 'session.created', null, here, 'Agent', '2026-11-05T00:00:00.000Z');

  const first = await (await t.call('/api/me/activity', { headers: { 'cf-connecting-ip': '203.0.113.7' } })).json();
  assert.equal(first.account_srn, 10000);
  assert.equal(first.events.length, 50);
  assert.deepEqual(first.events.slice(0, 3).map((e) => [e.type, e.provider, e.client_name, e.count]), [
    ['session.revoked', null, null, 2],
    ['client.connected', null, 'Codeg', null],
    ['session.created', 'google', null, null],
  ]);
  assert.equal(first.events[2].this_network, true);
  assert.equal(first.events[1].this_network, false, 'no address kept: not marked');
  assert.ok(!first.events.some((e) => e.id === id(63)), 'only the account’s own events');
  assert.ok(!JSON.stringify(first).includes('elsewhere') && !JSON.stringify(first).includes(here), 'hashes stay on the server');
  assert.ok(!JSON.stringify(first).includes('showName'), 'event data is not passed on wholesale');
  assert.equal(first.next_cursor, first.events[49].id);

  const second = await (await t.call(`/api/me/activity?cursor=${first.next_cursor}`)).json();
  assert.equal(second.events.length, 8);
  assert.equal(second.next_cursor, null);
  assert.ok(second.events.every((e) => e.this_network === false), 'without an address, nothing is marked');
  assert.equal((await t.call('/api/me/activity?cursor=1')).status, 400);
});

test('every route is limited per address before it reads anything', async () => {
  const t = await setup({ limit: 2 });
  assert.equal((await t.call('/api/me/account')).status, 200);
  assert.equal((await t.call('/api/me/sessions')).status, 200);
  const limited = await t.call('/api/me/activity');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

// ------------------------------------------------------------- the profile

/** A picture's first bytes, as each format begins: all the API reads of it. */
const png = (width, height, size = 96) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
};
const riff = (chunk, body) => {
  const b = new Uint8Array(20 + body.length);
  b.set([...'RIFF'].map((ch) => ch.charCodeAt(0)), 0);
  new DataView(b.buffer).setUint32(4, b.length - 8, true);
  b.set([...`WEBP${chunk}`].map((ch) => ch.charCodeAt(0)), 8);
  new DataView(b.buffer).setUint32(16, body.length, true);
  b.set(body, 20);
  return b;
};
/** extended (VP8X): the canvas, less one, in 24 bits each */
const webpX = (width, height) => riff('VP8X', [0x10, 0, 0, 0, (width - 1) & 0xff, ((width - 1) >> 8) & 0xff, (width - 1) >> 16, (height - 1) & 0xff, ((height - 1) >> 8) & 0xff, (height - 1) >> 16, 0, 0]);
/** lossless (VP8L): 14 bits each, less one, after the signature byte */
const webpL = (width, height) => {
  const v = (width - 1) | ((height - 1) << 14);
  return riff('VP8L', [0x2f, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff, 0, 0, 0, 0, 0]);
};
/** lossy (VP8): a key frame's tag, its start code, then 14 bits each */
const webpLossy = (width, height) => riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8]);
/** JPEG: an APP0 segment, padding, then the frame header */
const jpeg = (width, height) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 6, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xff, 0xc2, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 0, 0, 0, 0, 0, 0]);

test('a picture is what its own bytes say, and how large', () => {
  assert.deepEqual(imageInfo(png(384, 384)), { type: 'image/png', width: 384, height: 384 });
  assert.deepEqual(imageInfo(png(3_000_000_000, 1)), { type: 'image/png', width: 3_000_000_000, height: 1 }, 'read unsigned');
  assert.deepEqual(imageInfo(webpX(384, 200)), { type: 'image/webp', width: 384, height: 200 });
  assert.deepEqual(imageInfo(webpL(384, 1024)), { type: 'image/webp', width: 384, height: 1024 });
  assert.deepEqual(imageInfo(webpLossy(640, 480)), { type: 'image/webp', width: 640, height: 480 });
  assert.deepEqual(imageInfo(jpeg(800, 600)), { type: 'image/jpeg', width: 800, height: 600 });
  const text = new TextEncoder();
  assert.equal(imageInfo(text.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'nothing else');
  assert.equal(imageInfo(text.encode('GIF89a\x01\x00\x01\x00')), null, 'not a GIF either');
  assert.equal(imageInfo(png(10, 10).slice(0, 20)), null, 'a header cut short');
  assert.equal(imageInfo(jpeg(800, 600).slice(0, 14)), null, 'a JPEG without its frame header');
  assert.equal(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0])), null, 'image data before any frame header');
});

/** PATCH /api/me/profile with these fields, as the console's form sends them. */
async function profile(t, fields, headers = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ expected_srn: '10000', ...fields })) {
    for (const one of [value].flat()) {
      if (one === undefined) continue;
      if (one instanceof Uint8Array) form.append(key, new Blob([one]), 'avatar');
      else form.append(key, one);
    }
  }
  const body = new Response(form);
  return t.call('/api/me/profile', { method: 'PATCH', headers: { origin: SITE, 'content-type': body.headers.get('content-type'), ...headers }, body: await body.arrayBuffer() });
}

const events = (t, type) => t.DB.rows('SELECT user_id FROM audit_events WHERE type = ?', type);
const userRow = (t, id = ID) => t.DB.rows('SELECT name, image FROM users WHERE id = ?', id)[0];

test('changing the name: cleaned, checked, logged once it really changes', async () => {
  const t = await setup();
  const res = await profile(t, { name: '  Ada \u202e  King\n' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { account_srn: 10000, user: { number: 10000, name: 'Ada King', image: null } });
  assert.equal(userRow(t).name, 'Ada King');
  assert.equal(userRow(t, OTHER).name, 'Bo', 'no one else’s');
  assert.equal(events(t, 'profile.name_changed').length, 1);

  assert.equal((await profile(t, { name: 'Ada King' })).status, 200);
  assert.equal(events(t, 'profile.name_changed').length, 1, 'the same name again changes nothing');

  const empty = await profile(t, { name: ' \u200b ' });
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: 'invalid_name', reason: 'empty' });
  assert.deepEqual(await (await profile(t, { name: 'x'.repeat(33) })).json(), { error: 'invalid_name', reason: 'long' });
  assert.equal((await profile(t, { name: '字'.repeat(32) })).status, 200, 'characters, not bytes');
});

test('a profile change: from the site, for the account shown, in the form it expects', async () => {
  const t = await setup();
  assert.equal((await profile(t, { name: 'X' }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await profile(t, { name: 'X' }, { authorization: 'Bearer x' })).status, 403, 'never a client token');
  assert.equal((await profile(t, { name: 'X', expected_srn: '10001' })).status, 409);
  assert.equal((await profile(t, { name: 'X', expected_srn: 'ten' })).status, 400);
  assert.equal((await profile(t, { name: 'X', nickname: 'Y' })).status, 400, 'nothing it does not know');
  assert.equal((await profile(t, { name: ['X', 'Y'] })).status, 400, 'each once');
  assert.equal((await profile(t, {})).status, 400, 'something to change');
  assert.equal((await profile(t, { avatar: png(64, 64), remove_avatar: '1' })).status, 400, 'a picture or its removal, not both');
  assert.equal((await profile(t, { avatar: 'not a file' })).status, 400);
  assert.equal((await profile(t, { remove_avatar: 'yes' })).status, 400);
  assert.equal((await t.change('/api/me/profile', 'PATCH', { expected_srn: 10000, name: 'X' })).status, 400, 'a form, not JSON');
  t.signIn(null);
  assert.equal((await profile(t, { name: 'X' })).status, 401);
  assert.equal(userRow(t).name, 'Ada', 'none of them changed anything');
  assert.equal(events(t, 'profile.name_changed').length, 0);
});

test('a new picture: checked by its bytes, kept under a name of its own, the old one deleted', async () => {
  const t = await setup();
  const old = `/api/avatars/${ID}/aaaaaaaaaaaaaaaa.png`;
  t.DB.sqlite.prepare('UPDATE users SET image = ? WHERE id = ?').run(old, ID);
  await t.env.MEDIA.put(`avatars/${ID}/aaaaaaaaaaaaaaaa.png`, png(256, 256));
  await t.env.MEDIA.put(`avatars/${OTHER}/bbbbbbbbbbbbbbbb.png`, png(256, 256));

  const picture = png(384, 384);
  const res = await profile(t, { avatar: picture, name: 'Ada' });
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.match(user.image, new RegExp(`^/api/avatars/${ID}/[0-9a-f]{16}\\.png$`));
  assert.equal(userRow(t).image, user.image);
  assert.deepEqual(t.env.MEDIA.objects.get(avatarKey(user.image)), picture);
  assert.ok(!t.env.MEDIA.objects.has(`avatars/${ID}/aaaaaaaaaaaaaaaa.png`), 'the one it replaced is gone');
  assert.ok(t.env.MEDIA.objects.has(`avatars/${OTHER}/bbbbbbbbbbbbbbbb.png`), 'no one else’s is touched');
  assert.equal(events(t, 'profile.avatar_changed').length, 1);
  assert.equal(events(t, 'profile.name_changed').length, 0, 'the name sent along was the same');

  const again = (await (await profile(t, { avatar: picture })).json()).user.image;
  assert.notEqual(again, user.image, 'the same picture again is a file of its own');
  assert.ok(t.env.MEDIA.objects.has(avatarKey(again)) && !t.env.MEDIA.objects.has(avatarKey(user.image)));

  const photo = await profile(t, { avatar: jpeg(384, 384) });
  assert.equal(photo.status, 200);
  assert.match((await photo.json()).user.image, /\.jpg$/);
  assert.equal([...t.env.MEDIA.objects.keys()].filter((key) => key.startsWith(`avatars/${ID}/`)).length, 1, 'one picture kept at a time');

  const kept = userRow(t).image;
  for (const [why, bytes] of [
    ['WebP, which the ring card cannot draw', webpX(384, 384)],
    ['lossless WebP neither', webpL(300, 300)],
    ['not a picture', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['too wide', png(2048, 64)],
    ['too tall', jpeg(64, 1025)],
    ['no pixels', png(0, 64)],
    ['too large a file', png(64, 64, 1_000_001)],
  ]) {
    const bad = await profile(t, { avatar: bytes });
    assert.equal(bad.status, 400, why);
    assert.deepEqual(await bad.json(), { error: 'invalid_image' }, why);
  }
  assert.equal((await profile(t, { avatar: png(64, 64, 1_100_000) })).status, 413, 'a body past the limit is not read');
  assert.equal(userRow(t).image, kept, 'nothing it refused was kept');
  assert.equal([...t.env.MEDIA.objects.keys()].filter((key) => key.startsWith(`avatars/${ID}/`)).length, 1);
});

test('removing the picture deletes it, and only the account’s own', async () => {
  const t = await setup();
  t.DB.sqlite.prepare('UPDATE users SET image = ? WHERE id = ?').run(`/api/avatars/${ID}/aaaaaaaaaaaaaaaa.webp`, ID);
  await t.env.MEDIA.put(`avatars/${ID}/aaaaaaaaaaaaaaaa.webp`, webpX(64, 64));
  const res = await profile(t, { remove_avatar: '1' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.image, null);
  assert.equal(userRow(t).image, null);
  assert.equal(t.env.MEDIA.objects.size, 0);
  assert.equal(events(t, 'profile.avatar_removed').length, 1);
  assert.equal((await profile(t, { remove_avatar: '1' })).status, 200);
  assert.equal(events(t, 'profile.avatar_removed').length, 1, 'nothing left to remove: nothing logged');

  // a picture at someone else's address (never set by this site) is let go, not deleted
  t.DB.sqlite.prepare('UPDATE users SET image = ? WHERE id = ?').run(`/api/avatars/${OTHER}/bbbbbbbbbbbbbbbb.png`, ID);
  await t.env.MEDIA.put(`avatars/${OTHER}/bbbbbbbbbbbbbbbb.png`, png(64, 64));
  assert.equal((await profile(t, { remove_avatar: '1' })).status, 200);
  assert.ok(t.env.MEDIA.objects.has(`avatars/${OTHER}/bbbbbbbbbbbbbbbb.png`));
});

test('profile changes are limited per account, a few a minute', async () => {
  const t = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await profile(t, { name: `Ada ${i}` })).status, 200);
  const limited = await profile(t, { name: 'Ada again' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(userRow(t).name, 'Ada 9');
});

test('pictures replaced from two tabs at once: the one in use is never deleted', async () => {
  const t = await setup();
  // deletions held back until every request is done, as a slow waitUntil would be
  const held = [];
  const deleteNow = t.env.MEDIA.delete.bind(t.env.MEDIA);
  t.env.MEDIA.delete = async (key) => void held.push(key);
  const a = png(64, 64);
  const first = (await (await profile(t, { avatar: a })).json()).user.image;
  // one tab replaces A with B, the other puts A back
  assert.equal((await profile(t, { avatar: png(96, 96) })).status, 200);
  const last = (await (await profile(t, { avatar: a })).json()).user.image;
  for (const key of held) await deleteNow(key);
  assert.equal(userRow(t).image, last);
  assert.notEqual(last, first);
  assert.ok(t.env.MEDIA.objects.has(avatarKey(last)), 'the picture in use is still there');
  assert.deepEqual([...t.env.MEDIA.objects.keys()], [avatarKey(last)], 'and nothing else is kept');
});

test('a provider picture copied late does not replace one set meanwhile', async () => {
  const t = await setup();
  const provider = 'https://avatars.githubusercontent.com/u/1?v=4';
  t.DB.sqlite.prepare('UPDATE users SET image = ? WHERE id = ?').run(provider, ID);
  t.signIn({ ...USER, image: provider });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    await gate;
    const res = new Response(png(256, 256), { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  };
  try {
    // the copy a sign-in started, still fetching while the console saves a picture
    const copying = copyAvatar(t.env, { id: ID, image: provider });
    const saved = (await (await profile(t, { avatar: jpeg(384, 384) })).json()).user.image;
    release();
    assert.equal(await copying, null, 'too late: not used');
    assert.equal(userRow(t).image, saved, 'the picture set in the console stays');
    assert.deepEqual([...t.env.MEDIA.objects.keys()], [avatarKey(saved)], 'and the late copy is not kept');
  } finally {
    globalThis.fetch = realFetch;
  }
  // with nothing set meanwhile, the copy is used
  t.DB.sqlite.prepare('UPDATE users SET image = ? WHERE id = ?').run(provider, ID);
  globalThis.fetch = async (url) => {
    const res = new Response(png(256, 256), { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  };
  try {
    const copy = await copyAvatar(t.env, { id: ID, image: provider });
    assert.match(copy, new RegExp(`^/api/avatars/${ID}/[0-9a-f]{16}\\.png$`));
    assert.equal(userRow(t).image, copy);
  } finally {
    globalThis.fetch = realFetch;
  }
});
