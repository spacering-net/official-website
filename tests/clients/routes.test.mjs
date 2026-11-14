import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { clientRoutes } from '../../api/clients/routes.ts';
import { challenge, hash, randomValue } from '../../api/clients/protocol.ts';
import { ACCOUNT_MIGRATIONS, D1 } from '../harness/env.mjs';

const ID = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const USER = { id: ID, number: 10000, name: 'Ada', image: null, createdAt: new Date().toISOString() };
const LOOPBACK = 'http://127.0.0.1:53682/auth/callback';
const sqlUser = `INSERT INTO users (id, number, name, email, created_at, updated_at) VALUES (?, ?, 'Ada', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;

/** Workers Rate Limiting stand-in: a fixed number of calls per key. */
const binding = limit => {
  const hits = new Map();
  return { hits, async limit({ key }) { hits.set(key, (hits.get(key) ?? 0) + 1); return { success: hits.get(key) <= limit }; } };
};

async function setup(DB = new D1(ACCOUNT_MIGRATIONS)) {
  await DB.prepare(sqlUser).bind(ID, 10000, 'ada@example.com').run();
  await DB.prepare(sqlUser).bind(OTHER, 10001, 'other@example.com').run();
  const env = { DB, SITE_URL: 'https://spacering.net', BETTER_AUTH_SECRET: 'test-secret', CLIENT_LIMIT: binding(300), CLIENT_FLOW_LIMIT: binding(20) };
  let user = USER;
  const app = new Hono().basePath('/api').route('/', clientRoutes(async () => user));
  const call = (path, init = {}) => app.fetch(new Request(`https://spacering.net${path}`, init), env);
  const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const make = async (over = {}, headers = {}) => {
    const verifier = randomValue();
    const body = { client_id: 'codeg-desktop', redirect_uri: LOOPBACK, response_type: 'code', scope: 'profile:read', state: randomValue(), code_challenge: await challenge(verifier), code_challenge_method: 'S256', installation_id: randomValue(), platform: 'macos', ...over };
    const response = await post('/api/client/v1/login-requests', body, headers);
    const data = await response.json();
    return { response, ...data, verifier, body };
  };
  const lookup = flow => post('/api/client/v1/login-requests/lookup', { request_id: flow.request_id });
  const decide = (flow, decision = 'approve', over = {}, headers = {}) => post('/api/client/v1/login-requests/decision', { request_id: flow.request_id, decision, expected_srn: 10000, ...over }, { origin: env.SITE_URL, cookie: 'website=test', ...headers });
  const approve = async flow => {
    const res = await decide(flow);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const callback = new URL((await res.json()).callback_url);
    return callback.searchParams.get('code');
  };
  const exchange = (flow, code, over = {}, headers = {}) => post('/api/client/v1/token', { grant_type: 'authorization_code', client_id: flow.body.client_id, redirect_uri: flow.body.redirect_uri, code, code_verifier: flow.verifier, ...over }, headers);
  const list = async () => (await (await call('/api/me/clients')).json()).clients;
  const revoke = (id, srn = 10000) => call(`/api/me/clients/${id}`, { method: 'DELETE', headers: { origin: env.SITE_URL, 'content-type': 'application/json' }, body: JSON.stringify({ expected_srn: srn }) });
  const web = async (owner = ID) => {
    const secret = randomValue();
    const clientId = `codeg-web-${randomValue()}`;
    const callback = 'https://codeg.example.com/auth/srn/callback';
    await DB.prepare(`INSERT INTO client_registrations (client_id,client_type,owner_user_id,name,redirect_uri,secret_hash,created_at,updated_at) VALUES (?,'web',?,'Codeg',?,?,?,?)`).bind(clientId, owner, callback, await hash(secret), new Date().toISOString(), new Date().toISOString()).run();
    return { clientId, secret, auth: { authorization: `Basic ${btoa(`${clientId}:${secret}`)}` }, over: { client_id: clientId, redirect_uri: callback } };
  };
  return { DB, env, call, post, make, lookup, decide, approve, exchange, list, revoke, web, setUser: next => { user = next; } };
}

test('desktop loopback roundtrip, fragment URL, public lookup, isolated credentials and revoke', async () => {
  const t = await setup();
  const flow = await t.make();
  assert.equal(flow.response.status, 200);
  const url = new URL(flow.authorization_url);
  assert.equal(url.search, '', 'The request ID never travels in a query');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('request_id'), flow.request_id);
  const detail = await t.lookup(flow);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  const presentation = await detail.json();
  assert.deepEqual(Object.keys(presentation).sort(), ['client', 'expires_at', 'scope', 'status']);
  assert.ok(!JSON.stringify(presentation).includes(flow.body.state));
  const decided = await t.decide(flow);
  const callback = new URL((await decided.json()).callback_url);
  assert.equal(`${callback.origin}${callback.pathname}`, LOOPBACK);
  assert.equal(callback.searchParams.get('state'), flow.body.state);
  const code = callback.searchParams.get('code');
  assert.equal((await t.decide(flow)).status, 409);
  // A wrong verifier or another loopback port neither succeeds nor consumes the code.
  assert.equal((await t.exchange(flow, code, { code_verifier: randomValue() })).status, 400);
  assert.equal((await t.exchange(flow, code, { redirect_uri: 'http://127.0.0.1:53683/auth/callback' })).status, 400);
  const response = await t.exchange(flow, code);
  assert.equal(response.status, 200);
  const token = await response.json();
  assert.deepEqual(token.user, { srn: 10000, name: 'Ada', image: null });
  assert.equal(token.scope, 'profile:read');
  const headers = { authorization: `Bearer ${token.access_token}` };
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 200);
  assert.equal((await t.call('/api/client/v1/me', { headers: { ...headers, cookie: 'website=test' } })).status, 401);
  assert.equal((await t.call('/api/me/clients', { headers })).status, 403);
  assert.equal((await t.call('/api/client/v1/me', { headers: { cookie: 'website=test' } })).status, 401);
  const listed = await (await t.call('/api/me/clients')).json();
  assert.equal(listed.clients.length, 1);
  assert.equal(listed.account_srn, 10000);
  assert.equal(listed.clients[0].status, 'active');
  assert.equal(listed.clients[0].client_origin, null);
  assert.ok(!JSON.stringify(listed).includes('hash'));
  assert.ok(!JSON.stringify(listed).includes('redirect_uri'));
  assert.equal((await t.call(`/api/me/clients/${token.connection_id}`, { method: 'DELETE' })).status, 403);
  t.setUser({ ...USER, id: OTHER, number: 10001 });
  assert.equal((await t.revoke(token.connection_id, 10001)).status, 404);
  assert.equal((await t.revoke(token.connection_id, 10000)).status, 409);
  t.setUser(USER);
  assert.equal((await t.revoke(token.connection_id)).status, 200);
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 401);
  assert.equal((await t.list())[0].status, 'revoked');
  assert.equal((await t.post('/api/client/v1/logout', {}, headers)).status, 200);
});

test('a reused code revokes its connection only for the verifier holder', async () => {
  const t = await setup();
  const flow = await t.make();
  const code = await t.approve(flow);
  const token = await (await t.exchange(flow, code)).json();
  const headers = { authorization: `Bearer ${token.access_token}` };
  // The code alone, without the verifier, cannot end the connection.
  assert.equal((await t.exchange(flow, code, { code_verifier: randomValue() })).status, 400);
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 200);
  assert.equal((await t.exchange(flow, code)).status, 400);
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 401);
  assert.equal((await t.list())[0].status, 'revoked');
  await new Promise(done => setTimeout(done, 20)); // the audit entry is written after the answer
  assert.equal(t.DB.rows("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'client.code_reused'")[0].n, 1);
});

test('strict bindings, loopback rules, duplicate JSON, account changes and origin protection', async () => {
  const t = await setup();
  for (const over of [
    { scope: '' }, { scope: 'profile:read files:read' }, { code_challenge_method: 'plain' }, { user_id: ID }, { state: '' }, { installation_id: '\nhello' },
    { redirect_uri: 'codeg://auth/callback' }, { redirect_uri: 'http://127.0.0.1/auth/callback' }, { redirect_uri: 'http://127.0.0.1:80/auth/callback' },
    { redirect_uri: 'http://localhost:53682/auth/callback' }, { redirect_uri: 'http://127.0.0.1:53682/auth/callback/' }, { redirect_uri: 'http://127.0.0.1:53682/other' },
    { redirect_uri: 'https://127.0.0.1:53682/auth/callback' }, { redirect_uri: 'http://127.0.0.1:053682/auth/callback' },
  ]) {
    assert.ok([400, 401].includes((await t.make(over)).response.status), JSON.stringify(over));
  }
  const flow = await t.make();
  const duplicate = JSON.stringify(flow.body).replace('"client_id":"codeg-desktop"', '"client_id":"codeg-desktop","client_id":"codeg-desktop"');
  assert.equal((await t.call('/api/client/v1/login-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: duplicate })).status, 400);
  assert.equal((await t.decide(flow, 'approve', {}, { origin: '' })).status, 403);
  assert.equal((await t.decide(flow, 'approve', {}, { origin: 'https://spacering.net.example.invalid' })).status, 403);
  assert.equal((await t.post('/api/client/v1/login-requests/decision', { decision: 'approve', expected_srn: 10000 }, { origin: t.env.SITE_URL })).status, 400);
  t.setUser({ ...USER, id: OTHER, number: 10001 });
  assert.equal((await t.decide(flow)).status, 409);
  t.setUser(USER);
  const denied = await t.decide(flow, 'deny');
  assert.equal(denied.status, 200);
  assert.equal(new URL((await denied.json()).callback_url).searchParams.get('error'), 'access_denied');
  assert.equal((await t.decide(flow)).status, 409);
});

test('client kinds cannot pass for each other; development desktop builds register separately', async () => {
  const t = await setup();
  const w = await t.web();
  // A public ID with credentials, or a confidential ID without, is refused before any lookup.
  assert.equal((await t.make({}, { authorization: `Basic ${btoa('codeg-desktop:x')}` })).response.status, 401);
  assert.equal((await t.make(w.over)).response.status, 401);
  assert.equal((await t.make({ client_id: 'codeg-desktop-dev' })).response.status, 401);
  await t.DB.prepare("INSERT INTO client_registrations (client_id,client_type,name,redirect_uri,created_at,updated_at) VALUES ('codeg-desktop-dev','desktop','Codeg Dev','http://127.0.0.1/auth/callback','x','x')").run();
  const dev = await t.make({ client_id: 'codeg-desktop-dev' });
  assert.equal(dev.response.status, 200);
  assert.equal((await (await t.lookup(dev)).json()).client.name, 'Codeg Dev');
  const code = await t.approve(dev);
  assert.equal((await t.exchange(dev, code, { client_id: 'codeg-desktop' })).status, 400);
  assert.equal((await t.exchange(dev, code)).status, 200);
  // The schema keeps each kind to its own IDs and addresses, and a new Web
  // registration to an existing maintainer.
  const insert = (id, type, uri, secret, owner) => t.DB.prepare('INSERT INTO client_registrations (client_id,client_type,owner_user_id,name,redirect_uri,secret_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, type, owner, 'X', uri, secret, 'x', 'x').run();
  await assert.rejects(insert('codeg-desktop-x', 'desktop', 'https://codeg.example.com/auth/callback', null, null));
  await assert.rejects(insert(`codeg-desktop-${'y'}`, 'web', 'https://codeg.example.com/auth/srn/callback', 'h', ID));
  await assert.rejects(insert(`codeg-web-${randomValue()}`, 'web', 'http://codeg.example.com/auth/srn/callback', 'h', ID));
  await assert.rejects(insert(`codeg-web-${randomValue()}`, 'web', 'https://codeg.example.com/auth/srn/callback', 'h', null));
});

test('confidential registration, rotation invalidates pending; disable and owner deletion block existing profiles', async () => {
  const t = await setup();
  const w = await t.web();
  const flow = await t.make(w.over, w.auth);
  assert.equal(flow.response.status, 200);
  assert.equal((await (await t.lookup(flow)).json()).client.origin, 'https://codeg.example.com');
  const code = await t.approve(flow);
  assert.equal((await t.exchange(flow, code)).status, 401);
  const response = await t.exchange(flow, code, {}, w.auth);
  assert.equal(response.status, 200);
  const token = await response.json();
  const listedWeb = (await t.list())[0];
  assert.equal(listedWeb.client_origin, 'https://codeg.example.com');
  const pending = await t.make(w.over, w.auth);
  await t.DB.prepare('UPDATE client_registrations SET secret_hash = ?, secret_version = secret_version + 1 WHERE client_id = ?').bind(await hash(randomValue()), w.clientId).run();
  assert.equal((await t.decide(pending)).status, 409);
  assert.equal((await t.make(w.over, w.auth)).response.status, 401);
  const headers = { authorization: `Bearer ${token.access_token}` };
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 200);
  await t.DB.prepare('UPDATE client_registrations SET enabled = 0 WHERE client_id = ?').bind(w.clientId).run();
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 401);
  // A disabled registration is not a revoked connection. Users can revoke
  // it before the operator enables the registration again.
  assert.equal((await t.list())[0].status, 'disabled');
  assert.equal((await t.revoke(token.connection_id)).status, 200);
  await t.DB.prepare('UPDATE client_registrations SET enabled = 1 WHERE client_id = ?').bind(w.clientId).run();
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 401);

  // Deleting the maintainer's account succeeds and leaves the instance inactive.
  const owned = await t.web(OTHER);
  const ownedFlow = await t.make(owned.over, owned.auth);
  const ownedToken = await (await t.exchange(ownedFlow, await t.approve(ownedFlow), {}, owned.auth)).json();
  const ownedHeaders = { authorization: `Bearer ${ownedToken.access_token}` };
  assert.equal((await t.call('/api/client/v1/me', { headers: ownedHeaders })).status, 200);
  await t.DB.prepare('DELETE FROM users WHERE id = ?').bind(OTHER).run();
  assert.equal(t.DB.rows('SELECT owner_user_id FROM client_registrations WHERE client_id = ?', owned.clientId)[0].owner_user_id, null);
  assert.equal((await t.call('/api/client/v1/me', { headers: ownedHeaders })).status, 401);
  assert.equal((await t.make(owned.over, owned.auth)).response.status, 401);
  assert.equal((await t.list())[0].status, 'disabled');
});

test('expiry, conditional renewal and DB write failure never yield a credential', async () => {
  const t = await setup();
  const expired = await t.make();
  await t.DB.prepare("UPDATE client_login_requests SET expires_at = '2000-01-01T00:00:00.000Z' WHERE request_id = ?").bind(expired.request_id).run();
  assert.equal((await t.decide(expired)).status, 409);
  assert.equal((await t.lookup(expired)).status, 410);
  const flow = await t.make();
  const code = await t.approve(flow);
  t.DB.beforeBatch = () => { throw new Error('synthetic failure'); };
  assert.equal((await t.exchange(flow, code)).status, 500);
  t.DB.beforeBatch = null;
  const result = await (await t.exchange(flow, code)).json();
  const headers = { authorization: `Bearer ${result.access_token}` };
  // Recent use: a read only, nothing renewed.
  const before = t.DB.rows('SELECT last_used_at, expires_at FROM client_sessions WHERE id = ?', result.connection_id)[0];
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 200);
  assert.deepEqual(t.DB.rows('SELECT last_used_at, expires_at FROM client_sessions WHERE id = ?', result.connection_id)[0], before);
  // Used over an hour ago: recorded, expiry unchanged until a day has passed.
  await t.DB.prepare("UPDATE client_sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id = ?").bind(result.connection_id).run();
  const stale = t.DB.rows('SELECT last_used_at FROM client_sessions WHERE id = ?', result.connection_id)[0].last_used_at;
  await t.call('/api/client/v1/me', { headers });
  const used = t.DB.rows('SELECT last_used_at, expires_at FROM client_sessions WHERE id = ?', result.connection_id)[0];
  assert.ok(used.last_used_at > stale);
  assert.equal(used.expires_at, before.expires_at);
  await t.DB.prepare("UPDATE client_sessions SET renewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE id = ?").bind(result.connection_id).run();
  const renewed = await (await t.call('/api/client/v1/me', { headers })).json();
  assert.ok(Date.parse(renewed.expires_at) > Date.now() + 29 * 86400000);
  await t.DB.prepare("UPDATE client_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(result.connection_id).run();
  assert.equal((await t.call('/api/client/v1/me', { headers })).status, 401);
  assert.equal((await t.list())[0].status, 'expired');
});

test('anonymous traffic is limited without database writes; Web clients per client', async () => {
  const t = await setup();
  for (let i = 0; i < 20; i++) assert.equal((await t.make()).response.status, 200);
  const limitedFlow = await t.make();
  assert.equal(limitedFlow.response.status, 429);
  assert.equal(limitedFlow.response.headers.get('retry-after'), '60');
  assert.equal(t.DB.rows('SELECT COUNT(*) AS n FROM client_rate_limits')[0].n, 0, 'Anonymous steps never write counters');
  // The Web instance's users share one address: its steps count per client instead.
  const w = await t.web();
  for (let i = 0; i < 25; i++) assert.equal((await t.make(w.over, w.auth)).response.status, 200);
  assert.equal(t.DB.rows('SELECT COUNT(*) AS n FROM client_rate_limits')[0].n, 1);
  const fresh = await setup();
  assert.equal((await fresh.call('/api/client/v1/login-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' + ' '.repeat(5000) })).status, 400);
  fresh.env.CLIENT_LIMIT = binding(0);
  assert.equal((await fresh.call('/api/client/v1/me')).status, 429);
});

// Actual workerd/Miniflare D1, not the Node SQLite harness. A small test-only
// Worker bridge avoids Miniflare 5's Node getD1Database RPC dependency.
let mf;
let realDB;
/** Statements of a migration file; a trigger's body keeps its own semicolons. */
const statements = sql => {
  const out = [];
  let pending = '';
  for (const part of sql.replace(/--[^\n]*/g, '').split(';')) {
    pending = pending ? `${pending};${part}` : part;
    if (/\bCREATE\s+TRIGGER\b/i.test(pending) && !/\bEND\s*$/i.test(pending.trim())) continue;
    if (pending.trim()) out.push(pending.trim());
    pending = '';
  }
  return out;
};
before(async () => {
  const require = createRequire(import.meta.resolve('wrangler'));
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-06', unsafeRegisterWorker: false, d1Databases: { DB: 'srn-atomic-test' }, script: `
    export default { async fetch(request, env) {
      try {
        const b = await request.json();
        const statements = b.statements.map(s => env.DB.prepare(s.sql).bind(...s.params));
        const result = b.op === 'batch' ? await env.DB.batch(statements)
          : await statements[0][b.op]();
        return Response.json(result);
      } catch { return Response.json({failed:true}, {status:500}); }
    } }` }));
  await mf.ready;
  const bridge = async (op, list) => {
    const response = await mf.dispatchFetch('http://localhost/sql', { method: 'POST', body: JSON.stringify({ op, statements: list }) });
    if (!response.ok) throw new Error('D1 failed');
    return response.json();
  };
  const statement = (sql, params = []) => ({ sql, params, bind(...args) { return statement(sql, args); }, first() { return bridge('first', [this]); }, run() { return bridge('run', [this]); }, all() { return bridge('all', [this]); } });
  realDB = { prepare: statement, batch: list => bridge('batch', list) };
  for (const file of readdirSync(ACCOUNT_MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    for (const part of statements(readFileSync(new URL(file, ACCOUNT_MIGRATIONS), 'utf8'))) await realDB.prepare(part).run();
  }
});
after(async () => { await mf?.dispose(); });

test('real D1: batch rollback, no-op, concurrent decisions, one-time code claim and reuse revocation', { timeout: 30000 }, async () => {
  const t = await setup(realDB);
  // The registration trigger is installed like the rest of the migration.
  await assert.rejects(realDB.prepare(`INSERT INTO client_registrations (client_id,client_type,name,redirect_uri,secret_hash,created_at,updated_at) VALUES ('codeg-web-${'z'.repeat(16)}','web','X','https://codeg.example.com/auth/srn/callback','h','x','x')`).run());
  // A constraint error after a successful write rolls back the whole batch.
  await assert.rejects(realDB.batch([
    realDB.prepare("UPDATE users SET name = 'Changed' WHERE id = ?").bind(ID),
    realDB.prepare("INSERT INTO users (id,number,name,email,created_at,updated_at) VALUES (?,10000,'dup','dup@example.com','x','x')").bind('duplicate'),
  ]));
  assert.equal((await realDB.prepare('SELECT name FROM users WHERE id = ?').bind(ID).first()).name, 'Ada');
  const rollbackFlow = await t.make();
  const rollbackCode = await t.approve(rollbackFlow);
  await realDB.prepare("CREATE TRIGGER synthetic_session_failure BEFORE INSERT ON client_sessions BEGIN SELECT RAISE(ABORT, 'synthetic'); END").run();
  assert.equal((await t.exchange(rollbackFlow, rollbackCode)).status, 500);
  assert.equal((await realDB.prepare('SELECT status FROM client_login_requests WHERE request_id = ?').bind(rollbackFlow.request_id).first()).status, 'authorized');
  assert.equal((await realDB.prepare('SELECT COUNT(*) AS n FROM client_sessions').first()).n, 0);
  await realDB.prepare('DROP TRIGGER synthetic_session_failure').run();
  const flow = await t.make();
  const decisions = await Promise.all([t.decide(flow), t.decide(flow, 'deny')]);
  assert.deepEqual(decisions.map(x => x.status).sort(), [200, 409]);
  const decided = await (await decisions.find(x => x.status === 200)).json();
  const decisionUrl = new URL(decided.callback_url);
  // Whichever decision wins, it cannot be changed.
  assert.equal((await t.decide(flow)).status, 409);
  const another = await t.make();
  const code = await t.approve(another);
  assert.equal((await t.exchange(another, code, { code_verifier: randomValue() })).status, 400);
  assert.equal((await realDB.prepare('SELECT status FROM client_login_requests WHERE request_id = ?').bind(another.request_id).first()).status, 'authorized');
  const results = await Promise.all(Array.from({ length: 6 }, () => t.exchange(another, code)));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.filter(r => r.status !== 200).every(r => r.status === 400));
  assert.equal((await realDB.prepare('SELECT COUNT(*) AS n FROM client_sessions').first()).n, 1);
  assert.equal((await realDB.prepare('SELECT status FROM client_login_requests WHERE request_id = ?').bind(another.request_id).first()).status, 'consumed');
  // Every losing exchange ran after the winner committed, so the code was
  // presented again: the one connection it issued is revoked.
  assert.notEqual((await realDB.prepare('SELECT revoked_at FROM client_sessions').first()).revoked_at, null);
  assert.ok(decisionUrl.searchParams.has('code') || decisionUrl.searchParams.has('error'));
});
