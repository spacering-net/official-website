import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { audit } from '../audit';
import { later } from '../context';
import { uuidv7 } from '../ids';
import type { SessionUser } from '../rings/routes';
import { allowed, challenge, DESKTOP_ID, displayText, grantFor, hash, limited, NOW, objectBody, opaque, randomValue, redirectAllowed, SCOPE, WEB_ID } from './protocol';

type C = Context<{ Bindings: Env }>;
interface Registration {
  client_id: string;
  client_type: 'desktop' | 'web';
  name: string;
  redirect_uri: string;
  revision: number;
  secret_version: number;
  secret_hash: string | null;
}
interface ProfileRow { number: number; name: string; image: string | null; }
interface ConnectionRow extends ProfileRow { connection_id: string; user_id: string; expires_at: string; }

const fromSite = (c: C) => c.req.header('origin') === new URL(c.env.SITE_URL).origin;
const browserOnly = (c: C) => !c.req.header('authorization');
const noCookie = (c: C) => !c.req.header('cookie');
const address = (c: C) => c.req.header('cf-connecting-ip') ?? 'local';
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const rateError = (c: C) => c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
const tokenFrom = (c: C) => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')?.[1];
const profile = (row: ProfileRow, origin: string) => ({
  srn: row.number,
  name: row.name,
  image: row.image && /^\/api\/avatars\/[a-z0-9-]+\/[a-z0-9.]+$/.test(row.image) ? new URL(row.image, origin).href : null,
});
// Enabled, and for Web still with a maintainer (deleting that account leaves it inactive).
const registrationActive = `r.enabled = 1 AND (r.client_type = 'desktop' OR r.owner_user_id IS NOT NULL)`;
const registrationValid = `${registrationActive} AND r.revision = q.registration_revision AND r.secret_version = q.secret_version
  AND r.redirect_uri = q.registration_redirect_uri AND q.scope = 'profile:read'
  AND ((r.client_type = 'desktop' AND q.grant_kind = 'srn-desktop-code-v1') OR (r.client_type = 'web' AND q.grant_kind = 'srn-web-code-v1'))`;
const sessionValid = `s.revoked_at IS NULL AND s.expires_at > ${NOW} AND s.scope = 'profile:read' AND ${registrationActive}
  AND ((r.client_type = 'desktop' AND s.grant_kind = 'srn-desktop-code-v1') OR (r.client_type = 'web' AND s.grant_kind = 'srn-web-code-v1'))`;

/**
 * The registered client, or null. Public desktop clients send no credentials
 * and confidential Web clients always do, so neither can pass for the other.
 */
async function client(c: C, clientId: unknown): Promise<Registration | null> {
  if (typeof clientId !== 'string') return null;
  const type = DESKTOP_ID.test(clientId) ? 'desktop' : WEB_ID.test(clientId) ? 'web' : null;
  const auth = c.req.header('authorization');
  if (!type || (type === 'desktop') === !!auth) return null;
  const row = await c.env.DB.prepare(`SELECT r.* FROM client_registrations r WHERE r.client_id = ?1 AND r.client_type = ?2 AND ${registrationActive}`)
    .bind(clientId, type).first<Registration>();
  if (!row || type === 'desktop') return row;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(auth ?? '');
  if (!match || match[1].length > 1024) return null;
  let id: string;
  let secret: string;
  try {
    const decoded = atob(match[1]);
    const at = decoded.indexOf(':');
    if (at < 0) return null;
    const unform = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
    id = unform(decoded.slice(0, at));
    secret = unform(decoded.slice(at + 1));
  } catch { return null; }
  if (id !== clientId || !opaque(secret, 43, 128) || !row.secret_hash) return null;
  const digest = await hash(secret);
  let different = digest.length ^ row.secret_hash.length;
  for (let i = 0; i < digest.length; i++) different |= digest.charCodeAt(i) ^ row.secret_hash.charCodeAt(i);
  return different === 0 ? row : null;
}

export function clientRoutes(session: (c: C) => Promise<SessionUser | null>) {
  const app = new Hono<{ Bindings: Env }>();
  const protect: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!(await allowed(c.env.CLIENT_LIMIT, address(c)))) return rateError(c);
    await next();
  };
  app.use('/client/v1/*', protect);
  app.use('/me/clients', protect);
  app.use('/me/clients/*', protect);

  /**
   * Request creation and code exchange: an anonymous public client is limited
   * per address before any database work; a Web client per client, once its
   * secret is checked (its users share the instance's address).
   */
  const anonymousStep = async (c: C, step: string) => !!c.req.header('authorization') || allowed(c.env.CLIENT_FLOW_LIMIT, `${step}:${address(c)}`);
  const clientStep = async (c: C, step: string, reg: Registration) => reg.client_type !== 'web' || !(await limited(c.env, `${step}-client`, reg.client_id, 60));

  app.post('/client/v1/login-requests', async (c) => {
    if (!noCookie(c)) return c.json({ error: 'invalid_request' }, 400);
    if (!(await anonymousStep(c, 'create'))) return rateError(c);
    const b = await objectBody(c.req.raw, ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'installation_id', 'platform', 'device_name']);
    if (!b || b.response_type !== 'code' || b.scope !== SCOPE || !opaque(b.state) || !opaque(b.code_challenge, 43, 43) || b.code_challenge_method !== 'S256'
      || !opaque(b.installation_id, 16, 128) || !displayText(b.platform, 32) || (b.device_name !== undefined && !displayText(b.device_name, 80))) return c.json({ error: 'invalid_request' }, 400);
    const reg = await client(c, b.client_id);
    if (!reg) return c.json({ error: 'invalid_client' }, 401);
    if (!(await clientStep(c, 'create', reg))) return rateError(c);
    if (!redirectAllowed(reg, b.redirect_uri)) return c.json({ error: 'invalid_request' }, 400);
    const requestId = randomValue();
    const id = uuidv7();
    const result = await c.env.DB.prepare(`INSERT INTO client_login_requests
      (id, request_id, client_id, registration_revision, secret_version, registration_redirect_uri, grant_kind, scope, redirect_uri, state, code_challenge, challenge_method, installation_id, platform, device_name, expires_at, created_at)
      SELECT ?1, ?2, r.client_id, r.revision, r.secret_version, r.redirect_uri, ?3, 'profile:read', ?4, ?5, ?6, 'S256', ?7, ?8, ?9,
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), ${NOW}
      FROM client_registrations r WHERE r.client_id = ?10 AND ${registrationActive} AND r.revision = ?11 AND r.secret_version = ?12 AND r.redirect_uri = ?13`)
      .bind(id, requestId, grantFor(reg.client_type), b.redirect_uri, b.state, b.code_challenge, b.installation_id, b.platform, b.device_name ?? null,
        reg.client_id, reg.revision, reg.secret_version, reg.redirect_uri).run();
    if (result.meta.changes !== 1) return c.json({ error: 'invalid_client' }, 401);
    const row = await c.env.DB.prepare('SELECT expires_at FROM client_login_requests WHERE id = ?1').bind(id).first<{ expires_at: string }>();
    // The request ID travels in the fragment, which browsers never send to a
    // server: it stays out of request logs, traces and Referer headers.
    const url = new URL('/authorize/', c.env.SITE_URL);
    url.hash = new URLSearchParams({ request_id: requestId }).toString();
    return c.json({ request_id: requestId, authorization_url: url.href, expires_at: row!.expires_at });
  });

  // Public presentation for the authorization page. POST keeps the request ID
  // out of the URL; nothing here reads cookies or can produce a code.
  app.post('/client/v1/login-requests/lookup', async (c) => {
    if (!(await allowed(c.env.CLIENT_FLOW_LIMIT, `lookup:${address(c)}`))) return rateError(c);
    const b = await objectBody(c.req.raw, ['request_id']);
    if (!b || !opaque(b.request_id, 43, 43)) return c.json({ error: 'invalid_request' }, 400);
    const row = await c.env.DB.prepare(`SELECT q.status, q.expires_at, r.name, r.client_type, r.redirect_uri
      FROM client_login_requests q JOIN client_registrations r ON r.client_id = q.client_id
      WHERE q.request_id = ?1 AND ${registrationValid} AND q.expires_at > ${NOW}`).bind(b.request_id).first<{ status: string; expires_at: string; name: string; client_type: string; redirect_uri: string }>();
    if (!row) return c.json({ error: 'request_expired' }, 410);
    return c.json({ status: row.status, expires_at: row.expires_at, scope: SCOPE, client: { name: row.name, type: row.client_type, origin: row.client_type === 'web' ? new URL(row.redirect_uri).origin : null } });
  });

  app.post('/client/v1/login-requests/decision', async (c) => {
    if (!fromSite(c) || !browserOnly(c)) return c.json({ error: 'forbidden' }, 403);
    const b = await objectBody(c.req.raw, ['request_id', 'decision', 'expected_srn']);
    if (!b || !opaque(b.request_id, 43, 43) || !['approve', 'deny'].includes(String(b.decision)) || !Number.isSafeInteger(b.expected_srn)) return c.json({ error: 'invalid_request' }, 400);
    const requestId = b.request_id;
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    if (user.number !== b.expected_srn) return c.json({ error: 'account_changed' }, 409);
    if (await limited(c.env, 'decision-user', user.id, 20) || await limited(c.env, 'decision-request', requestId, 10)) return rateError(c);
    const code = b.decision === 'approve' ? randomValue() : null;
    const result = await c.env.DB.prepare(`UPDATE client_login_requests AS q SET status = ?1, user_id = ?2, code_hash = ?3,
      code_expires_at = CASE WHEN ?1 = 'authorized' THEN MIN(expires_at, strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')) ELSE NULL END,
      decided_at = ${NOW}
      WHERE request_id = ?4 AND status = 'pending' AND expires_at > ${NOW}
      AND EXISTS (SELECT 1 FROM client_registrations r WHERE r.client_id = q.client_id AND ${registrationValid})
      AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND number = ?5)`)
      .bind(code ? 'authorized' : 'denied', user.id, code ? await hash(code) : null, requestId, user.number).run();
    if (result.meta.changes !== 1) return c.json({ error: 'request_decided' }, 409);
    const row = await c.env.DB.prepare('SELECT redirect_uri, state FROM client_login_requests WHERE request_id = ?1').bind(requestId).first<{ redirect_uri: string; state: string }>();
    const callback = new URL(row!.redirect_uri);
    callback.searchParams.set(code ? 'code' : 'error', code ?? 'access_denied');
    callback.searchParams.set('state', row!.state);
    later(audit(c.env, code ? 'client.authorized' : 'client.denied', user.id, undefined, c.req.raw));
    return c.json({ callback_url: callback.href });
  });

  app.post('/client/v1/token', async (c) => {
    if (!noCookie(c)) return c.json({ error: 'invalid_request' }, 400);
    if (!(await anonymousStep(c, 'token'))) return rateError(c);
    const b = await objectBody(c.req.raw, ['grant_type', 'client_id', 'redirect_uri', 'code', 'code_verifier']);
    if (!b || b.grant_type !== 'authorization_code' || !opaque(b.code, 43, 43) || typeof b.code_verifier !== 'string'
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier)) return c.json({ error: 'invalid_request' }, 400);
    const reg = await client(c, b.client_id);
    if (!reg) return c.json({ error: 'invalid_client' }, 401);
    if (!(await clientStep(c, 'token', reg))) return rateError(c);
    if (!redirectAllowed(reg, b.redirect_uri)) return c.json({ error: 'invalid_grant' }, 400);
    const sessionId = uuidv7();
    const token = randomValue();
    const tokenHash = await hash(token);
    const codeHash = await hash(b.code);
    const codeChallenge = await challenge(b.code_verifier);
    // INSERT is the sole conditional claim. D1 batch runs transactionally;
    // the unique source_request_id is a second guard across Workers. A failed
    // insert rolls the batch back, and a no-op cannot change the request.
    const [inserted] = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO client_sessions
        (id, user_id, client_id, grant_kind, scope, installation_id, platform, device_name, token_hash, source_request_id, created_at, last_used_at, renewed_at, expires_at)
        SELECT ?1, q.user_id, q.client_id, q.grant_kind, q.scope, q.installation_id, q.platform, q.device_name, ?2, q.id,
          ${NOW}, ${NOW}, ${NOW}, strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')
        FROM client_login_requests q JOIN client_registrations r ON r.client_id = q.client_id
        WHERE q.code_hash = ?3 AND q.status = 'authorized' AND q.consumed_at IS NULL
          AND q.expires_at > ${NOW} AND q.code_expires_at > ${NOW} AND q.code_challenge = ?4 AND q.challenge_method = 'S256'
          AND q.client_id = ?5 AND q.redirect_uri = ?6 AND r.revision = ?7 AND r.secret_version = ?8 AND ${registrationValid}`)
        .bind(sessionId, tokenHash, codeHash, codeChallenge, reg.client_id, b.redirect_uri, reg.revision, reg.secret_version),
      c.env.DB.prepare(`UPDATE client_login_requests SET status = 'consumed', consumed_at = ${NOW}
        WHERE status = 'authorized' AND id IN (SELECT source_request_id FROM client_sessions WHERE id = ?1 AND token_hash = ?2)`)
        .bind(sessionId, tokenHash),
    ]);
    if (inserted.meta.changes !== 1) {
      // A code presented again revokes the connection it already issued
      // (RFC 6749 section 4.1.2). Requiring the matching verifier keeps a
      // party holding only the code from ending someone's connection.
      const reused = await c.env.DB.prepare(`UPDATE client_sessions SET revoked_at = ${NOW}
        WHERE revoked_at IS NULL AND source_request_id = (SELECT id FROM client_login_requests
          WHERE code_hash = ?1 AND status = 'consumed' AND client_id = ?2 AND code_challenge = ?3)
        RETURNING id, user_id`).bind(codeHash, reg.client_id, codeChallenge).first<{ id: string; user_id: string }>();
      if (reused) later(audit(c.env, 'client.code_reused', reused.user_id, { connection_id: reused.id }, c.req.raw));
      return c.json({ error: 'invalid_grant' }, 400);
    }
    const row = await c.env.DB.prepare(`SELECT s.id AS connection_id, s.user_id, s.expires_at, u.number, u.name, u.image
      FROM client_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1`).bind(sessionId).first<ConnectionRow>();
    if (!row) return c.json({ error: 'server_error' }, 500);
    later(audit(c.env, 'client.connected', row.user_id, { connection_id: row.connection_id, client_id: reg.client_id }, c.req.raw));
    return c.json({ access_token: token, token_type: 'Bearer', scope: SCOPE, expires_at: row.expires_at, connection_id: row.connection_id, user: profile(row, c.env.SITE_URL) });
  });

  app.get('/client/v1/me', async (c) => {
    const token = tokenFrom(c);
    if (!token || !noCookie(c)) return c.json({ error: 'invalid_token' }, 401);
    const tokenHash = await hash(token);
    const read = () => c.env.DB.prepare(`SELECT s.id AS connection_id, s.user_id, s.expires_at, u.number, u.name, u.image,
        (s.last_used_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') OR s.renewed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')) AS due
      FROM client_sessions s JOIN client_registrations r ON r.client_id = s.client_id JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND ${sessionValid}`).bind(tokenHash).first<ConnectionRow & { due: number }>();
    let row = await read();
    if (!row) return c.json({ error: 'invalid_token' }, 401);
    if (row.due) {
      // Use is recorded hourly and the expiry renewed at most daily, so most
      // checks are reads. The write repeats the validity test: it cannot
      // revive a connection revoked or expired in the meantime.
      await c.env.DB.prepare(`UPDATE client_sessions SET last_used_at = ${NOW},
        expires_at = CASE WHEN renewed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') THEN MAX(expires_at, strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')) ELSE expires_at END,
        renewed_at = CASE WHEN renewed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') THEN ${NOW} ELSE renewed_at END
        WHERE id IN (SELECT s.id FROM client_sessions s JOIN client_registrations r ON r.client_id = s.client_id WHERE s.token_hash = ?1 AND ${sessionValid})`).bind(tokenHash).run();
      row = await read();
      if (!row) return c.json({ error: 'invalid_token' }, 401);
    }
    return c.json({ scope: SCOPE, expires_at: row.expires_at, connection_id: row.connection_id, user: profile(row, c.env.SITE_URL) });
  });

  app.post('/client/v1/logout', async (c) => {
    const token = tokenFrom(c);
    if (!token || !noCookie(c)) return c.json({ error: 'invalid_token' }, 401);
    await c.env.DB.prepare(`UPDATE client_sessions SET revoked_at = COALESCE(revoked_at, ${NOW}) WHERE token_hash = ?1 AND scope = 'profile:read'`).bind(await hash(token)).run();
    return c.json({ ok: true });
  });

  app.get('/me/clients', async (c) => {
    if (!browserOnly(c)) return c.json({ error: 'forbidden' }, 403);
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    const cursor = c.req.query('cursor') ?? null;
    if (cursor !== null && !uuid(cursor)) return c.json({ error: 'invalid_request' }, 400);
    const { results } = await c.env.DB.prepare(`SELECT s.id, r.name AS client_name, r.client_type, r.redirect_uri, s.platform, s.device_name, s.scope,
      s.created_at, s.last_used_at, s.expires_at, s.revoked_at,
      CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at <= ${NOW} THEN 'expired'
        WHEN NOT (${registrationActive}) THEN 'disabled' ELSE 'active' END AS status
      FROM client_sessions s JOIN client_registrations r ON r.client_id = s.client_id
      WHERE s.user_id = ?1 AND (?2 IS NULL OR s.id < ?2) ORDER BY s.id DESC LIMIT 101`).bind(user.id, cursor)
      .all<{ id: string; client_type: string; redirect_uri: string } & Record<string, unknown>>();
    // A Web connection names the instance holding it; the rest is
    // what its client said about itself.
    const clients = results.slice(0, 100).map(({ redirect_uri, ...row }) => ({ ...row, client_origin: row.client_type === 'web' ? new URL(redirect_uri).origin : null }));
    return c.json({ account_srn: user.number, clients, next_cursor: results.length > 100 ? clients[clients.length - 1].id : null });
  });

  app.delete('/me/clients/:id', async (c) => {
    if (!fromSite(c) || !browserOnly(c)) return c.json({ error: 'forbidden' }, 403);
    if (!uuid(c.req.param('id'))) return c.json({ error: 'invalid_request' }, 400);
    const body = await objectBody(c.req.raw, ['expected_srn']);
    if (!body || !Number.isSafeInteger(body.expected_srn)) return c.json({ error: 'invalid_request' }, 400);
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    if (user.number !== body.expected_srn) return c.json({ error: 'account_changed' }, 409);
    const result = await c.env.DB.prepare(`UPDATE client_sessions SET revoked_at = COALESCE(revoked_at, ${NOW}) WHERE id = ?1 AND user_id = ?2`).bind(c.req.param('id'), user.id).run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    later(audit(c.env, 'client.revoked', user.id, { connection_id: c.req.param('id') }, c.req.raw));
    return c.json({ ok: true });
  });

  // This boundary never logs request objects, URLs, credentials or SQL binds.
  app.onError((_err, c) => c.json({ error: 'server_error' }, 500));
  return app;
}
