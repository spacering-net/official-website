import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SITE } from '../config';
import { SITEMAP_SHARD } from '../lib/harness';

export const prerender = false;

/**
 * The sitemap index: the pages built ahead of time, then Harness items in
 * shards of SITEMAP_SHARD (each item twice, once per language, under the
 * 50,000 addresses a sitemap may hold). The count comes from the facets.
 */
export const GET: APIRoute = async () => {
  const row = await env.HARNESS_DB.prepare("SELECT count FROM facets WHERE key = 'all'").first<{ count: number }>();
  const shards = Math.ceil((row?.count ?? 0) / SITEMAP_SHARD);
  const maps = ['/sitemap-pages.xml', ...Array.from({ length: shards }, (_, i) => `/sitemap-harness-${i + 1}.xml`)];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      maps.map((m) => `  <sitemap><loc>${SITE.url}${m}</loc></sitemap>\n`).join('') +
      `</sitemapindex>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=86400' } },
  );
};
