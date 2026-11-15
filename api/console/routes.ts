/**
 * The console's view of the signed-in account (src/client/console.ts). Each
 * answer is about the account whose website cookie came with the request,
 * names it (account_srn), and goes no further than that account's rows.
 *
 *   GET    /api/me/account                 who, how they sign in, what is connected
 *   PATCH  /api/me/profile                 change the name, the picture, or both
 *   GET    /api/me/sessions                the browsers signed in, without their tokens
 *   DELETE /api/me/sessions/:id            sign one other browser out
 *   POST   /api/me/sessions/revoke-others  sign every other browser out
 *   GET    /api/me/activity?cursor=        the security log, newest first
 *
 * Changes need the site's exact Origin and the ring number the page shows
 * (expected_srn), as the connection list's do. A client's Bearer token is
 * never accepted here.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { AVATAR_MAX_BYTES, AVATAR_MAX_SIDE, cleanName, nameProblem } from '../../src/lib/profile';
import { audit, keyedHash } from '../audit';
import { avatarKey, imageInfo, keepPicture, ownAvatarKey } from '../avatars';
import { later } from '../context';
import { allowed, limited, NOW, objectBody } from '../clients/protocol';
import { registrationActive } from '../clients/routes';
import type { SessionUser } from '../rings/routes';

type C = Context<{ Bindings: Env }>;
/** who a change is for, or the answer that refuses it */
type Change = { user: SessionUser & { sessionId: string }; error?: undefined } | { user?: undefined; error: Response };

const fromSite = (c: C) => c.req.header('origin') === new URL(c.env.SITE_URL).origin;
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
/** a page of the log */
const PAGE = 50;
/** What a profile change may hold: the account it is for, a name, a picture or the picture's removal. */
const PROFILE_FIELDS = ['expected_srn', 'name', 'avatar', 'remove_avatar'];
/** room for the largest picture and the fields around it */
const PROFILE_MAX_BODY = AVATAR_MAX_BYTES + 16 * 1024;
/** profile changes a minute, per account */
const PROFILE_LIMIT = 10;
/** the pictures the ring card's renderer can draw (resvg: not WebP), so the console makes these */
const PICTURE_TYPES = ['image/png', 'image/jpeg'];

/** A request's body, read no further than `max` bytes; null past that. */
async function cappedBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

interface EventRow {
  id: string;
  type: string;
  created_at: string;
  user_agent: string | null;
  this_network: number | null;
  provider: string | null;
  client_name: string | null;
  count: number | null;
}

export function consoleRoutes(session: (c: C) => Promise<SessionUser | null>) {
  const app = new Hono<{ Bindings: Env }>();

  // Per address, without a database write; then cookies only.
  const protect: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    if (!(await allowed(c.env.CLIENT_LIMIT, c.req.header('cf-connecting-ip') ?? 'local'))) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    if (c.req.header('authorization')) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
  // (a pattern ending in /* covers the address without it too: one each, so each request counts once)
  app.use('/me/account', protect);
  app.use('/me/profile', protect);
  app.use('/me/sessions/*', protect);
  app.use('/me/activity', protect);

  /** The account a change is made for: signed in here, and the one the page shows (expected_srn). */
  const changeFor = async (c: C, expected: unknown): Promise<Change> => {
    const user = await session(c);
    if (!user) return { error: c.json({ error: 'signed_out' }, 401) };
    if (user.number !== expected) return { error: c.json({ error: 'account_changed' }, 409) };
    if (!user.sessionId) return { error: c.json({ error: 'server_error' }, 500) };
    return { user: user as SessionUser & { sessionId: string } };
  };

  /** A change: the site's own page, for the account it shows, from a browser session it can tell apart. */
  const change = async (c: C): Promise<Change> => {
    if (!fromSite(c)) return { error: c.json({ error: 'forbidden' }, 403) };
    const body = await objectBody(c.req.raw, ['expected_srn']);
    if (!body || !Number.isSafeInteger(body.expected_srn)) return { error: c.json({ error: 'invalid_request' }, 400) };
    return changeFor(c, body.expected_srn);
  };

  app.get('/me/account', async (c) => {
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    const db = c.env.DB;
    const now = new Date().toISOString();
    const [profile, providers, counts, last] = await db.batch([
      db.prepare('SELECT email, created_at FROM users WHERE id = ?1').bind(user.id),
      db.prepare('SELECT provider_id AS provider, created_at AS linked_at FROM accounts WHERE user_id = ?1 ORDER BY created_at').bind(user.id),
      db.prepare(`SELECT (SELECT COUNT(*) FROM sessions WHERE user_id = ?1 AND expires_at > ?2) AS sessions,
        (SELECT COUNT(*) FROM client_sessions s JOIN client_registrations r ON r.client_id = s.client_id
          WHERE s.user_id = ?1 AND s.revoked_at IS NULL AND s.expires_at > ${NOW} AND ${registrationActive}) AS clients`).bind(user.id, now),
      db.prepare(`SELECT created_at AS at, user_agent, json_extract(data, '$.provider') AS provider FROM audit_events
        WHERE user_id = ?1 AND type = 'session.created' ORDER BY id DESC LIMIT 1`).bind(user.id),
    ]);
    const me = profile.results[0] as { email: string; created_at: string } | undefined;
    if (!me) return c.json({ error: 'signed_out' }, 401);
    const count = counts.results[0] as { sessions: number; clients: number };
    return c.json({
      account_srn: user.number,
      user: { number: user.number, name: user.name, image: user.image, email: me.email, since: me.created_at },
      providers: providers.results,
      sessions: count.sessions,
      clients: count.clients,
      last_sign_in: last.results[0] ?? null,
    });
  });

  // A multipart form: expected_srn, and a name, a picture (`avatar`, the
  // file the console made) or remove_avatar=1, or a name with either. The
  // picture is checked by its own bytes; the one it replaces is deleted.
  app.patch('/me/profile', async (c) => {
    if (!fromSite(c)) return c.json({ error: 'forbidden' }, 403);
    const type = c.req.header('content-type') ?? '';
    if (!/^multipart\/form-data\s*;/i.test(type)) return c.json({ error: 'invalid_request' }, 400);
    const bytes = await cappedBody(c.req.raw, PROFILE_MAX_BODY);
    if (!bytes) return c.json({ error: 'too_large' }, 413);
    const form = await new Response(bytes, { headers: { 'content-type': type } }).formData().catch(() => null);
    if (!form) return c.json({ error: 'invalid_request' }, 400);
    const names = [...form.keys()];
    if (names.some((key) => !PROFILE_FIELDS.includes(key)) || new Set(names).size !== names.length) return c.json({ error: 'invalid_request' }, 400);
    const expected = form.get('expected_srn');
    const rawName = form.get('name');
    const avatar = form.get('avatar');
    const remove = form.get('remove_avatar');
    if (typeof expected !== 'string' || !/^[1-9][0-9]{4,8}$/.test(expected)) return c.json({ error: 'invalid_request' }, 400);
    if ((rawName !== null && typeof rawName !== 'string') || typeof avatar === 'string' || (remove !== null && remove !== '1')) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if ((avatar && remove) || (rawName === null && !avatar && !remove)) return c.json({ error: 'invalid_request' }, 400);

    const { user, error } = await changeFor(c, Number(expected));
    if (error) return error;
    if (await limited(c.env, 'profile', user.id, PROFILE_LIMIT)) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });

    let name: string | undefined;
    if (rawName !== null) {
      const clean = rawName.length > 1024 ? null : cleanName(rawName);
      const problem = clean === null ? 'long' : nameProblem(clean);
      if (problem) return c.json({ error: 'invalid_name', reason: problem }, 400);
      name = clean!;
    }
    let picture: { bytes: Uint8Array; type: string } | undefined;
    if (avatar) {
      const data = new Uint8Array(await avatar.arrayBuffer());
      const info = data.byteLength <= AVATAR_MAX_BYTES ? imageInfo(data) : null;
      if (!info || !PICTURE_TYPES.includes(info.type) || info.width < 1 || info.height < 1 || info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) {
        return c.json({ error: 'invalid_image' }, 400);
      }
      picture = { bytes: data, type: info.type };
    }

    // The new picture first (a file of its own, see keepPicture), then the
    // account, with what it held before in the same transaction: what
    // changed is what really did, even with another tab changing it at the
    // same moment, and the picture it replaced is no one's any more.
    const image = picture ? await keepPicture(c.env, user.id, picture.bytes, picture.type) : remove ? null : undefined;
    // a new picture that ends up pointed at by no one is not kept
    const dropNew = () => {
      const kept = image ? avatarKey(image) : null;
      if (kept) later(c.env.MEDIA.delete(kept));
    };
    const db = c.env.DB;
    let rows: Awaited<ReturnType<typeof db.batch>>;
    try {
      rows = await db.batch([
        db.prepare('SELECT name, image FROM users WHERE id = ?1').bind(user.id),
        db.prepare('UPDATE users SET name = COALESCE(?2, name), image = CASE WHEN ?3 = 1 THEN ?4 ELSE image END, updated_at = ?5 WHERE id = ?1')
          .bind(user.id, name ?? null, image === undefined ? 0 : 1, image ?? null, new Date().toISOString()),
        db.prepare('SELECT name, image FROM users WHERE id = ?1').bind(user.id),
      ]);
    } catch (err) {
      dropNew();
      throw err;
    }
    const before = rows[0].results[0] as { name: string; image: string | null } | undefined;
    const after = rows[2].results[0] as { name: string; image: string | null } | undefined;
    if (!before || !after) {
      dropNew();
      return c.json({ error: 'signed_out' }, 401);
    }
    const renamed = name !== undefined && name !== before.name;
    const repictured = image !== undefined && image !== before.image;
    if (repictured) {
      const old = ownAvatarKey(before.image, user.id);
      if (old && old !== (image ? avatarKey(image) : null)) later(c.env.MEDIA.delete(old));
    }
    if (renamed) later(audit(c.env, 'profile.name_changed', user.id, undefined, c.req.raw));
    if (repictured) later(audit(c.env, image ? 'profile.avatar_changed' : 'profile.avatar_removed', user.id, undefined, c.req.raw));
    return c.json({ account_srn: user.number, user: { number: user.number, name: after.name, image: after.image } });
  });

  app.get('/me/sessions', async (c) => {
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    // never the token: it is what signs a browser in
    const { results } = await c.env.DB.prepare(`SELECT id, created_at, updated_at, expires_at, ip_address, user_agent FROM sessions
      WHERE user_id = ?1 AND expires_at > ?2 ORDER BY updated_at DESC LIMIT 100`).bind(user.id, new Date().toISOString()).all<{ id: string }>();
    return c.json({ account_srn: user.number, sessions: results.map((row) => ({ ...row, current: row.id === user.sessionId })) });
  });

  app.delete('/me/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuid(id)) return c.json({ error: 'invalid_request' }, 400);
    const { user, error } = await change(c);
    if (error) return error;
    // this browser signs out the usual way, which also clears its cookie
    if (id === user.sessionId) return c.json({ error: 'current_session' }, 400);
    const result = await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run();
    if (!result.meta.changes) return c.json({ error: 'not_found' }, 404);
    later(audit(c.env, 'session.revoked', user.id, { count: 1 }, c.req.raw));
    return c.json({ ok: true });
  });

  app.post('/me/sessions/revoke-others', async (c) => {
    const { user, error } = await change(c);
    if (error) return error;
    const result = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND id != ?2').bind(user.id, user.sessionId).run();
    const count = result.meta.changes;
    if (count) later(audit(c.env, 'session.revoked', user.id, { count }, c.req.raw));
    return c.json({ ok: true, signed_out: count });
  });

  app.get('/me/activity', async (c) => {
    const user = await session(c);
    if (!user) return c.json({ error: 'signed_out' }, 401);
    const cursor = c.req.query('cursor') ?? null;
    if (cursor !== null && !uuid(cursor)) return c.json({ error: 'invalid_request' }, 400);
    // The log keeps addresses only as keyed hashes; the visitor's own, hashed
    // the same way, tells which events came from the network they are on.
    const ip = c.req.header('cf-connecting-ip');
    const here = ip ? await keyedHash(ip, c.env.BETTER_AUTH_SECRET) : null;
    const { results } = await c.env.DB.prepare(`SELECT e.id, e.type, e.created_at, e.user_agent, e.ip_hash = ?3 AS this_network,
        CASE WHEN e.type IN ('session.created', 'account.linked') THEN json_extract(e.data, '$.provider') END AS provider,
        CASE WHEN r.client_type = 'web' THEN r.name || ' Web' ELSE r.name END AS client_name,
        CASE WHEN e.type = 'session.revoked' THEN json_extract(e.data, '$.count') END AS count
      FROM audit_events e LEFT JOIN client_registrations r ON e.type = 'client.connected' AND r.client_id = json_extract(e.data, '$.client_id')
      WHERE e.user_id = ?1 AND (?2 IS NULL OR e.id < ?2) ORDER BY e.id DESC LIMIT ${PAGE + 1}`).bind(user.id, cursor, here).all<EventRow>();
    const events = results.slice(0, PAGE).map((row) => ({ ...row, this_network: row.this_network === 1 }));
    return c.json({ account_srn: user.number, events, next_cursor: results.length > PAGE ? events[events.length - 1].id : null });
  });

  // This boundary never logs request objects, URLs, cookies or SQL binds.
  app.onError((_err, c) => c.json({ error: 'server_error' }, 500));
  return app;
}
