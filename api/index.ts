import { Hono } from 'hono';
import { getAuth } from './auth';
import { serveAvatar } from './avatars';
import { withRequest } from './context';

const api = new Hono<{ Bindings: Env }>().basePath('/api');

// Nothing under /api is cached unless a route says otherwise.
api.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
});

api.use('/auth/*', async (c, next) => {
  const { success } = await c.env.AUTH_LIMIT.limit({ key: c.req.header('cf-connecting-ip') ?? 'local' });
  if (!success) return c.json({ error: 'rate_limited' }, 429);
  await next();
});

api.on(['GET', 'POST'], '/auth/*', (c) => getAuth(c.env).handler(c.req.raw));

/** Who is signed in: what the page needs to engrave the band, or 401. */
api.get('/me', async (c) => {
  const { headers, response: session } = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  // A session in use is renewed (at most daily) and its cookie cache refreshed;
  // an expired one is cleared. Either way the new cookies go back to the browser.
  for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
  if (!session) return c.json({ user: null }, 401);
  const { number, name, image } = session.user;
  return c.json({ user: { number, name, image } });
});

api.get('/avatars/*', (c) => serveAvatar(c.env, c.req.path.slice('/api/avatars/'.length)));

api.notFound((c) => c.json({ error: 'not_found' }, 404));
api.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'server_error' }, 500);
});

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Only /api/* is routed here (run_worker_first); anything else that
    // reaches the script is a static file or the 404 page.
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return withRequest(ctx, () => api.fetch(request, env, ctx));
  },

  /**
   * Daily: drop expired sign-in states and sessions, and audit entries older
   * than a year (the privacy policy promises both). ISO times compare as text.
   */
  async scheduled(_event, env) {
    const now = new Date();
    const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const [states, sessions, events] = await env.DB.batch([
      env.DB.prepare('DELETE FROM verifications WHERE expires_at < ?1').bind(now.toISOString()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now.toISOString()),
      env.DB.prepare('DELETE FROM audit_events WHERE created_at < ?1').bind(yearAgo),
    ]);
    console.info(
      `[api] cleanup: ${states.meta.changes} expired states, ${sessions.meta.changes} expired sessions, ${events.meta.changes} old audit entries`,
    );
  },
} satisfies ExportedHandler<Env>;
