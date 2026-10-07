// @ts-check
import { access, rename, rm } from 'node:fs/promises';
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

/**
 * Cloudflare answers an address with nothing behind it with the nearest
 * 404.html up its path. Astro writes src/pages/404.astro as /404.html but the
 * Chinese one as /zh/404/index.html: move it to /zh/404.html.
 * @type {import('astro').AstroIntegration}
 */
const notFoundInChinese = {
  name: 'zh-404',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      const from = new URL('zh/404/index.html', dir);
      try {
        await access(from);
      } catch {
        return;
      }
      await rename(from, new URL('zh/404.html', dir));
      await rm(new URL('zh/404/', dir), { recursive: true, force: true });
    },
  },
};

export default defineConfig({
  site: 'https://spacering.net',
  trailingSlash: 'ignore',
  // Pages are built ahead of time, except those that opt out with
  // `export const prerender = false` (Harness): those are rendered by the
  // Worker (api/index.ts hands them to the adapter).
  adapter: cloudflare({
    // no images go through astro:assets, so no Images binding
    imageService: 'passthrough',
  }),
  // no Astro sessions, so no KV namespace for them
  session: false,
  integrations: [notFoundInChinese],
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    build: {
      // three.js is one large chunk by design; it is loaded once and cached.
      chunkSizeWarningLimit: 1200,
    },
  },
});
