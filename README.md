# spacering.net

English | [简体中文](README.zh-CN.md)

The website of SpaceRing, the cyberspace ring. The pages are a static Astro build with a three.js scene. Sign-in and user data come from the same Cloudflare Worker (Hono and Better Auth, with data in D1 and profile pictures in R2).

## Development

Requires Node 22.12+ and pnpm.

```bash
pnpm install
pnpm dev        # http://localhost:4321, Chinese at /zh/
pnpm build      # builds the static site into dist/
pnpm preview    # serves dist/ locally
pnpm check      # type-checks the site and the Worker
```

Sign-in and `/api` come from the Worker. Run it in a second terminal:

```bash
cp .dev.vars.example .dev.vars   # first time: fill in BETTER_AUTH_SECRET
pnpm db:migrate                  # first time and after each new migration: creates the local D1 tables
pnpm dev:api                     # :8787; pnpm dev forwards /api to it
```

## Where to change things

| What | Where |
| --- | --- |
| Copy in both languages, product names, the sample assistant's name | `src/i18n/index.ts` |
| The projected previews in each chapter | `src/components/holo/` |
| Repository and docs links, fallback stats | `src/config.ts` |
| Palette, type sizes, spacing | the variables at the top of `src/styles/global.css` |
| Ring size, materials and the veins on the band | `src/client/scene/ring.ts` |
| The particle disk around the ring | `src/client/scene/disk.ts` |
| Intro timing | `src/client/intro.ts` |
| Where the ring sits in each chapter | `layouts()` in `src/client/chapters.ts` |
| Sign-in, sessions, ring numbers | `api/auth.ts`, `api/ring-number.ts` |
| Database schema | `db/migrations/` (add new files only; do not edit existing migrations; run `pnpm db:migrate:remote` before pushing) |
| The engraving inside the band | `inscribe()` in `src/client/scene/ring.ts`, `src/client/account.ts` |

## Debug parameters

- `?quality=high|medium|low`: forces a quality tier.
- `?off=bloom,nebula,corona,disk,glow,stars,iri,final,ring`: turns off individual effects, to track down performance problems.
- `?capture`: hides the interface, for rendering share images.

## Visual checks

The scripts drive the local Chrome with Playwright. Run `pnpm build && pnpm preview` first. Screenshots go to `shots/` (git-ignored).

```bash
pnpm qa:shots   # intro and chapter screenshots (desktop)
pnpm qa:modes   # no WebGL, reduced motion, keyboard focus
pnpm qa:nav     # deep links, focus, chapter dial, HUD nav highlight, language switch
pnpm qa:jump    # jumps across several chapters project only the start and end chapters
pnpm qa:switch  # language switch hand-over: same chapter, no intro replay, no flash
pnpm qa:menu    # menu on short screens: scrolls, locks the page, Esc and focus return; pauses the scene, no live blur
pnpm qa:fit     # panels fit between the HUD and the bottom edge at every size
pnpm qa:perf    # frame times at 1x and 2x pixel ratio
pnpm og         # re-renders the share images; then convert them to public/og.jpg and og-zh.jpg
```

## Brand assets

`logo/` holds the logo sources and the construction drawing. The favicons are built from the same vector paths.

## License

The code is released under the MIT License; see [LICENSE](LICENSE). The SpaceRing name and logo (`logo/`, the site icons and the share images) are not covered.
