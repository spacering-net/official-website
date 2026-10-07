import type { APIRoute } from 'astro';
import { SITE } from '../config';

// Harness search results and later pages of a list are for people, not
// crawlers: every item is in the sitemap already. The API is not for crawling.
export const GET: APIRoute = () =>
  new Response(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      'Disallow: /harness/*q=',
      'Disallow: /zh/harness/*q=',
      'Disallow: /harness/*cursor=',
      'Disallow: /zh/harness/*cursor=',
      '',
      `Sitemap: ${SITE.url}/sitemap.xml`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
