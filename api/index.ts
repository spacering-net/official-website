import { handle } from '@astrojs/cloudflare/handler';
import { Hono } from 'hono';
import { getAuth } from './auth';
import { serveAvatar } from './avatars';
import { withRequest } from './context';
import { forCache, fromCache } from './harness/cache';
import { daily as harnessDaily, runJob, startRegistrySync, type Job } from './harness/jobs';
import { harnessApi } from './harness/routes';

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

api.route('/harness/v1', harnessApi);

api.notFound((c) => c.json({ error: 'not_found' }, 404));
api.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'server_error' }, 500);
});

// Pages rendered on demand show content from packages (descriptions, checked
// and rendered safe): they run no script of ours either, so allow none at all.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * A page rendered on demand (Harness, the sitemap). The same for every
 * reader, so a page that says it is public is kept at each Cloudflare
 * location for its s-maxage (the Cache API) and served from there.
 */
async function page(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = request.method === 'GET' ? caches.default : null;
  const key = new Request(request.url, { method: 'GET' });
  const hit = await cache?.match(key);
  if (hit) return fromCache(hit);
  const rendered = await handle(request, env, ctx);
  const res = new Response(rendered.body, rendered);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) res.headers.set(k, v);
  if (cache && res.status === 200 && /\bpublic\b/.test(res.headers.get('Cache-Control') ?? '')) ctx.waitUntil(cache.put(key, forCache(res)));
  return res;
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Static pages never reach the script. What does (run_worker_first) is
    // the API, or a page rendered on demand, which Astro renders; it serves
    // files and the 404 page for anything else.
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return page(request, env, ctx);
    return withRequest(ctx, () => api.fetch(request, env, ctx));
  },

  /**
   * Hourly: sync Harness with the MCP Registry. Daily: drop expired sign-in
   * states and sessions, and audit entries older than a year (the privacy
   * policy promises both); then Harness's daily jobs. ISO times compare as text.
   */
  async scheduled(event, env) {
    if (event.cron === '17 * * * *') return startRegistrySync(env);
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
    await harnessDaily(env);
  },

  /** Harness's background jobs (api/harness/jobs.ts), one at a time; a failed one is retried a minute later. */
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await runJob(env, message.body as Job);
        message.ack();
      } catch (err) {
        console.error('[harness] job failed', JSON.stringify(message.body).slice(0, 200), err);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
