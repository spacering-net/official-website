import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, Next } from 'hono';
import { etag } from 'hono/etag';
import { facetCounts, getItem, getPublisher, getVersion, getVersions, KINDS, listItems, listTags, readmeKey, SORTS } from './catalog';
import { LIMITS } from './limits';
import * as S from './schemas';

/**
 * The Harness API, v1 (docs: section 8), under /api/harness/v1. Everything
 * here reads, anonymously: browsing and search, items, versions with what it
 * takes to install them, and the files. Signing in and publishing come in
 * H2 and H3.
 */
export const harnessApi = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: 'invalid_request' }, 400);
  },
});

type C = Context<{ Bindings: Env }>;

// per address, a few hundred requests a minute
harnessApi.use('*', async (c, next) => {
  const { success } = await c.env.HARNESS_LIMIT.limit({ key: c.req.header('cf-connecting-ip') ?? 'local' });
  if (!success) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
  await next();
});

/**
 * Anonymous answers are the same for everyone: browsers keep them a minute,
 * each Cloudflare location five (the Cache API), and an unchanged one costs
 * a 304. Anyone may read them from any site (no credentials involved).
 */
const shared = async (c: C, next: Next) => {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(c.req.url, { method: 'GET' });
  const hit = c.req.method === 'GET' ? await cache?.match(key) : undefined;
  if (hit) return new Response(hit.body, hit);
  await next();
  if (c.res.status === 200) {
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    if (cache && c.req.method === 'GET') c.executionCtx.waitUntil(cache.put(key, c.res.clone()));
  }
};
harnessApi.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', '*');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
});
// outside the cache, so a cached answer still turns into a 304 when unchanged
harnessApi.use('*', etag({ weak: true }));
harnessApi.use('*', shared);

const json = <T extends z.ZodType>(schema: T, description: string) => ({ content: { 'application/json': { schema } }, description });
const notFound = json(S.ErrorBody, 'Not found');

const Ref = z.object({
  publisher: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/i).openapi({ param: { name: 'publisher', in: 'path' }, example: 'anthropics' }),
  name: z.string().regex(/^[a-z0-9-]{1,64}$/i).openapi({ param: { name: 'name', in: 'path' }, example: 'pdf' }),
});

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/config',
    summary: 'Limits, kinds, tags and runtimes',
    description: 'What clients check packages against before installing them, and the lists for filters.',
    responses: { 200: json(S.Config, 'Client configuration') },
  }),
  async (c) => {
    const db = c.env.HARNESS_DB;
    const [tags, counts] = await Promise.all([listTags(db), facetCounts(db)]);
    const runtimes = Object.entries(counts)
      .filter(([k]) => k.startsWith('runtime:'))
      .map(([k, count]) => ({ id: k.slice('runtime:'.length), count }))
      .sort((a, b) => b.count - a.count);
    return c.json(
      { limits: LIMITS, kinds: KINDS, sorts: [...SORTS], runtimes, tags, review: c.env.HARNESS_REVIEW === 'on' ? ('on' as const) : ('off' as const) },
      200,
    );
  },
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/items',
    summary: 'Browse and search',
    description:
      'Without `q`, public items in order of `sort`. With `q`, the best matches (at most 200), items whose address or exact name is `q` first, listed ones included.',
    request: {
      query: z.object({
        q: z.string().max(200).optional(),
        kind: z.enum(['skill', 'mcp', 'prompt', 'assistant', 'connector']).optional(),
        runtime: z.string().max(20).optional(),
        tag: z.string().max(40).optional(),
        publisher: z.string().max(253).optional(),
        sort: z.enum(['popular', 'new', 'updated']).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: { 200: json(S.ItemList, 'A page of items') },
  }),
  async (c) => c.json(await listItems(c.env.HARNESS_DB, c.req.valid('query')), 200),
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/items/{publisher}/{name}',
    summary: 'An item',
    request: { params: Ref },
    responses: { 200: json(S.ItemDetail, 'The item, its checks, and how to install its latest version'), 404: notFound },
  }),
  async (c) => {
    const { publisher, name } = c.req.valid('param');
    const item = await getItem(c.env.HARNESS_DB, publisher, name);
    return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
  },
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/items/{publisher}/{name}/versions',
    summary: "An item's versions",
    request: { params: Ref },
    responses: { 200: json(z.object({ versions: z.array(S.VersionSummary) }), 'Newest first'), 404: notFound },
  }),
  async (c) => {
    const { publisher, name } = c.req.valid('param');
    const versions = await getVersions(c.env.HARNESS_DB, publisher, name);
    return versions ? c.json({ versions }, 200) : c.json({ error: 'not_found' }, 404);
  },
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/items/{publisher}/{name}/versions/{revision}',
    summary: 'One version, with what it takes to install it',
    request: { params: Ref.extend({ revision: z.coerce.number().int().min(1).openapi({ param: { name: 'revision', in: 'path' }, example: 1 }) }) },
    responses: { 200: json(S.InstallInfo, 'Files, hashes, packages and permissions'), 404: notFound },
  }),
  async (c) => {
    const { publisher, name, revision } = c.req.valid('param');
    const info = await getVersion(c.env.HARNESS_DB, publisher, name, revision);
    if (!info) return c.json({ error: 'not_found' }, 404);
    // a version never changes: a client may keep this for good
    return c.json(info, 200, { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' });
  },
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/items/{publisher}/{name}/readme',
    summary: "An item's description, as HTML",
    description: 'Rendered from Markdown when the version was made: no raw HTML, scripts, frames, forms or images; links marked as user content.',
    request: { params: Ref },
    responses: { 200: { content: { 'text/html': { schema: z.string() } }, description: 'An HTML fragment' }, 404: notFound },
  }),
  async (c) => {
    const { publisher, name } = c.req.valid('param');
    const key = await readmeKey(c.env.HARNESS_DB, publisher, name);
    const object = key ? await c.env.HARNESS_FILES.get(key) : null;
    if (!object) return c.json({ error: 'not_found' }, 404);
    return c.body(await object.text(), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      // a fragment, never a page of this site: if opened directly, it can do nothing
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    });
  },
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/publishers/{publisher}',
    summary: 'A publisher',
    request: { params: Ref.pick({ publisher: true }) },
    responses: { 200: json(S.PublisherInfo, 'The publisher'), 404: notFound },
  }),
  async (c) => {
    const p = await getPublisher(c.env.HARNESS_DB, c.req.valid('param').publisher);
    return p ? c.json(p, 200) : c.json({ error: 'not_found' }, 404);
  },
);

/**
 * Files and archives, named by their SHA-256, so kept for good by everyone.
 * Always downloads, never pages: uploaded content must not run as part of
 * spacering.net (docs: section 7).
 */
async function serveFile(c: C, key: string, type: string, filename?: string) {
  const object = await c.env.HARNESS_FILES.get(key);
  if (!object) return c.json({ error: 'not_found' }, 404);
  return c.body(object.body, 200, {
    'Content-Type': type,
    'Content-Disposition': filename ? `attachment; filename="${filename}"` : 'attachment',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: object.httpEtag,
  });
}

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/archives/{file}',
    summary: 'A package, as a zip',
    request: { params: z.object({ file: z.string().regex(/^[0-9a-f]{64}\.zip$/).openapi({ param: { name: 'file', in: 'path' } }) }) },
    responses: { 200: { content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } }, description: 'The zip' }, 404: notFound },
  }),
  (c) => serveFile(c, `archives/${c.req.valid('param').file}`, 'application/zip', c.req.valid('param').file),
);

harnessApi.openapi(
  createRoute({
    method: 'get',
    path: '/blobs/{sha256}',
    summary: 'One file, by its hash',
    request: { params: z.object({ sha256: Sha.openapi({ param: { name: 'sha256', in: 'path' } }) }) },
    responses: { 200: { content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } }, description: 'The bytes' }, 404: notFound },
  }),
  (c) => serveFile(c, `blobs/${c.req.valid('param').sha256}`, 'application/octet-stream'),
);

harnessApi.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Harness API',
    version: '1',
    description: 'Skills, MCP servers, prompts, assistants and connectors: browse, search and install. https://spacering.net/harness/',
  },
  servers: [{ url: '/api/harness/v1' }],
});
