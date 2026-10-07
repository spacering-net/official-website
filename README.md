# spacering.net

English | [简体中文](README.zh-CN.md)

The website of SpaceRing, the cyberspace ring. Most pages are a static Astro build with a three.js scene. One Cloudflare Worker serves them, the API under `/api` (Hono and Better Auth for sign-in, with data in D1 and profile pictures in R2), and Harness: the marketplace of skills, MCP servers and more, whose pages the Worker renders on demand from its own D1 database and R2 bucket, with imports running on Cloudflare Queues.

## Development

Requires Node 22.12+ and pnpm.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # first time: fill in BETTER_AUTH_SECRET
pnpm db:migrate                  # first time and after each new migration: creates the local D1 tables
pnpm dev        # http://localhost:4321, Chinese at /zh/; the Worker and /api run inside it
pnpm build      # builds the site into dist/client and the Worker into dist/server
pnpm preview    # serves the build, Worker included
pnpm check      # type-checks the site and the Worker
pnpm test       # Harness unit tests
```

Harness imports run on a schedule. Locally, start them by hand (the queue runs in the dev server): the hourly registry sync with `curl 'http://localhost:4321/cdn-cgi/handler/scheduled?cron=17+*+*+*+*'`, the daily jobs (skill repositories, stars, counts) with `cron=23+3+*+*+*`. A `GITHUB_TOKEN` in `.dev.vars` raises GitHub's rate limit, and star counts need it: a fine-grained token with "Public repositories" (read-only) access and no permissions is enough.

## Where to change things

| What | Where |
| --- | --- |
| Copy in both languages, product names, the sample assistant's name | `src/i18n/index.ts` |
| The projected previews in each chapter | `src/components/holo/` |
| Repository and docs links, fallback stats | `src/config.ts` |
| Palette, type sizes, spacing | the variables at the top of `src/styles/site.css` |
| Ring size, materials and the veins on the band | `src/client/scene/ring.ts` |
| The particle disk around the ring | `src/client/scene/disk.ts` |
| Intro timing | `src/client/intro.ts` |
| Where the ring sits in each chapter | `layouts()` in `src/client/chapters.ts` |
| Sign-in, sessions, ring numbers | `api/auth.ts`, `api/ring-number.ts` |
| Database schema | `db/migrations/` and Harness's `db/harness/` (add new files only; do not edit existing migrations; run `pnpm db:migrate:remote` before pushing) |
| Harness: imports, checks, search and the API | `api/harness/` (the API's shapes: `api/harness/schemas.ts`, published at `/api/harness/v1/openapi.json`) |
| Harness pages and their copy | `src/pages/[...lang]/harness/`, `src/components/harness/`, `src/i18n/harness.ts` |
| The frame of every page but the homepage (HUD, menu, sign-in, footer; one column, `--page-max`) | `src/layouts/Page.astro`, `src/client/page.ts` |
| Light and dark on every page but the homepage (which stays dark): the light palette, the switch, the choice applied before the first paint | `:root[data-theme='light']` in `src/styles/site.css`, `src/components/ThemeSwitch.astro`, `src/client/theme.js` |
| Publishers' pictures (GitHub avatars, sites' icons; kept in R2, looked for again every 30 days by the daily jobs) | `api/harness/importers/avatars.ts`, `src/components/harness/Avatar.astro` |
| Products with pages of their own (the HUD links to them; the rest are homepage chapters) | `PRODUCT_PAGES` in `src/i18n/index.ts` |
| The not-found page, per language (`404.html`, `zh/404.html`; also for Harness addresses with nothing behind them) | `src/components/NotFound.astro`, `src/pages/404.astro`, `src/pages/zh/404.astro` |
| The engraving inside the band | `inscribe()` in `src/client/scene/ring.ts`, `src/client/account.ts` |

Harness's rule checks take their patterns from the database, not from this repository; a fresh database has none and relies on the built-in checks.

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
pnpm qa:pages   # the other pages: shared HUD, menu and sign-in, what sticks while scrolling, Harness's in-place search and filters, shared edges, the light theme
pnpm qa:perf    # frame times at 1x and 2x pixel ratio
pnpm og         # re-renders the share images; then convert them to public/og.jpg and og-zh.jpg
```

## Brand assets

`logo/` holds the logo sources and the construction drawing. The favicons are built from the same vector paths.

## License

The code is released under the MIT License; see [LICENSE](LICENSE). The SpaceRing name and logo (`logo/`, the site icons and the share images) are not covered.
