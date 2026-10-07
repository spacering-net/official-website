// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://spacering.net',
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    build: {
      // three.js is one large chunk by design; it is loaded once and cached.
      chunkSizeWarningLimit: 1200,
    },
    // `pnpm dev:api` serves /api on :8787 (wrangler dev); in development the
    // site and the API are one origin, as they are on Cloudflare.
    server: {
      proxy: { '/api': 'http://localhost:8787' },
    },
  },
});
