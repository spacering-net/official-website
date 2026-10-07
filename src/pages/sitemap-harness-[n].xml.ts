import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SITE } from '../config';
import { SITEMAP_SHARD } from '../lib/harness';

export const prerender = false;

/** /sitemap-harness-<n>.xml: the nth shard of public Harness items, oldest first, so a shard's contents rarely move. */
export const GET: APIRoute = async ({ params }) => {
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 1 || n > 100) return new Response(null, { status: 404 });
  const { results } = await env.HARNESS_DB.prepare(
    `SELECT p.handle, i.name, i.version_at FROM items i JOIN publishers p ON p.id = i.publisher_id
      WHERE i.status = 'public' AND i.visibility = 'public' ORDER BY i.seq LIMIT ?1 OFFSET ?2`,
  )
    .bind(SITEMAP_SHARD, (n - 1) * SITEMAP_SHARD)
    .all<{ handle: string; name: string; version_at: string }>();
  if (!results.length) return new Response(null, { status: 404 });
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const entry = (loc: string, ref: string, at: string) =>
    `  <url><loc>${xml(`${SITE.url}${loc}`)}</loc><lastmod>${at.slice(0, 10)}</lastmod>` +
    `<xhtml:link rel="alternate" hreflang="en" href="${xml(`${SITE.url}/harness/${ref}`)}"/>` +
    `<xhtml:link rel="alternate" hreflang="zh-CN" href="${xml(`${SITE.url}/zh/harness/${ref}`)}"/></url>\n`;
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      results
        .map((r) => {
          const ref = `${r.handle}/${r.name}`;
          return entry(`/harness/${ref}`, ref, r.version_at) + entry(`/zh/harness/${ref}`, ref, r.version_at);
        })
        .join('') +
      `</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=86400' } },
  );
};
