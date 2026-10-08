import { handle } from '@astrojs/cloudflare/handler';
import { Hono, type Context } from 'hono';
import { getAuth } from './auth';
import { serveAvatar } from './avatars';
import { withRequest } from './context';
import { cacheKey, edgeCache, forCache, fromCache } from './harness/cache';
import { daily as harnessDaily, runJob, startRegistrySync, type Job } from './harness/jobs';
import { harnessApi } from './harness/routes';
import { ringRoutes, type SessionUser } from './rings/routes';

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

/**
 * The signed-in user, or null. A session in use is renewed (at most daily);
 * an expired one is cleared. Either way the new cookies go back with the
 * answer, which must then be made with `c` (c.json, c.body).
 */
async function sessionUser(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const { headers, response: session } = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
  const user = session?.user;
  if (!user || typeof user.number !== 'number') return null;
  return { id: user.id, number: user.number, name: user.name, image: user.image ?? null, createdAt: new Date(user.createdAt).toISOString() };
}

/** Who is signed in: what the page needs to engrave the band, or 401. */
api.get('/me', async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.json({ user: null }, 401);
  const { number, name, image } = user;
  return c.json({ user: { number, name, image } });
});

api.get('/avatars/*', (c) => serveAvatar(c.env, c.req.path.slice('/api/avatars/'.length)));

api.route('/', ringRoutes(sessionUser));

api.route('/harness/v1', harnessApi);

api.notFound((c) => c.json({ error: 'not_found' }, 404));
api.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'server_error' }, 500);
});

// Pages rendered on demand show content from packages (descriptions, checked
// and rendered safe). Scripts may come only from this site and never inline:
// the site's own bundles (the HUD, the account dialog, Harness's browsing).
// Package files are served as attachments, as octet streams, with nosniff,
// so none of them can run as a script here.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * The pages rendered on demand: the addresses wrangler.jsonc sends to the
 * script first (run_worker_first). Only `astro dev` asks, as it renders every
 * page through the script: the others go out as their files do, without the
 * headers above (the homepage starts from an inline script).
 */
const ON_DEMAND = /^\/(?:zh\/)?(?:harness|ring)(?:\/|$)|^\/sitemap(?:\.xml$|-harness-)/;

/**
 * The site's not-found page for this address, in its language: the nearest
 * 404.html up its path, as Cloudflare serves for addresses that are not files.
 * In development there are no files yet, and Astro renders it.
 */
async function notFound(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const file = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' }));
  if (file.status === 404 && file.headers.get('Content-Type')?.startsWith('text/html')) return file;
  const zh = /^\/zh(?:\/|$)/.test(new URL(request.url).pathname);
  const rendered = await handle(new Request(new URL(zh ? '/zh/404' : '/404', request.url)), env, ctx);
  return rendered.ok ? new Response(rendered.body, { status: 404, headers: rendered.headers }) : null;
}

/** Astro's answer, or for an address with nothing behind it the site's not-found page. */
async function render(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rendered = await handle(request, env, ctx);
  if (rendered.status !== 404 || (request.method !== 'GET' && request.method !== 'HEAD')) return rendered;
  return (await notFound(request, env, ctx)) ?? rendered;
}

/**
 * A page rendered on demand (Harness, the sitemap). The same for every
 * reader, so a page that says it is public is kept at each Cloudflare
 * location for its s-maxage (the Cache API) and served from there.
 */
async function page(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = request.method === 'GET' ? edgeCache() : undefined;
  const key = cacheKey(request.url, env.CF_VERSION_METADATA?.id);
  const hit = await cache?.match(key);
  if (hit) return fromCache(hit);
  const rendered = await render(request, env, ctx);
  const res = new Response(rendered.body, rendered);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) res.headers.set(k, v);
  if (cache && res.status === 200 && /\bpublic\b/.test(res.headers.get('Cache-Control') ?? '')) ctx.waitUntil(cache.put(key, forCache(res)));
  return res;
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Static pages never reach the script. What does (run_worker_first) is
    // the API, or a page rendered on demand; and a request that is not a
    // navigation, for an address with nothing behind it.
    if (pathname === '/api' || pathname.startsWith('/api/')) return withRequest(ctx, () => api.fetch(request, env, ctx));
    if (import.meta.env?.DEV && !ON_DEMAND.test(pathname)) return render(request, env, ctx);
    return page(request, env, ctx);
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
