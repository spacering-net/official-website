import type { APIRoute } from 'astro';
import { SITE } from '../config';

// Every page built ahead of time, in both languages, each naming its twin as
// an alternate, as the pages' own hreflang links do (Base.astro, Page.astro);
// and the Harness home page. Harness items have sitemaps of their own
// (sitemap.xml lists them all). The 404 page is left out.
const pages = [
  { en: '/', zh: '/zh/' },
  { en: '/space/', zh: '/zh/space/' },
  { en: '/assistant/', zh: '/zh/assistant/' },
  { en: '/harness/', zh: '/zh/harness/' },
  { en: '/open-source/', zh: '/zh/open-source/' },
  { en: '/privacy/', zh: '/zh/privacy/' },
  { en: '/terms/', zh: '/zh/terms/' },
];

const entry = (loc: string, p: (typeof pages)[number]) =>
  `  <url><loc>${SITE.url}${loc}</loc>` +
  `<xhtml:link rel="alternate" hreflang="en" href="${SITE.url}${p.en}"/>` +
  `<xhtml:link rel="alternate" hreflang="zh-CN" href="${SITE.url}${p.zh}"/>` +
  `<xhtml:link rel="alternate" hreflang="x-default" href="${SITE.url}${p.en}"/></url>\n`;

export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
      pages.map((p) => entry(p.en, p) + entry(p.zh, p)).join('') +
      `</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
