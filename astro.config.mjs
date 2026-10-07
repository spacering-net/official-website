// @ts-check
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

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
