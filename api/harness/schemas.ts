import { z } from '@hono/zod-openapi';

/**
 * The shapes of Harness API responses, as Zod schemas: the single definition
 * the API validates against, the OpenAPI document is generated from
 * (/api/harness/v1/openapi.json, which Codeg generates its client types
 * from), and catalog.ts takes its types from. Field names are camelCase, like
 * server.json's.
 */

export const Kind = z.enum(['skill', 'mcp', 'prompt', 'assistant', 'connector']).openapi('Kind');
export const Risk = z.enum(['low', 'medium', 'high']).openapi('Risk');
export const Localized = z
  .object({ en: z.string().optional(), zh: z.string().optional() })
  .openapi('Localized', { description: 'Display text per language. Either may be missing: show the other.' });

export const Publisher = z
  .object({
    handle: z.string().openapi({ example: 'anthropics' }),
    name: z.string(),
    kind: z.enum(['github', 'domain', 'user']),
    verified: z.boolean(),
    unclaimed: z.boolean().openapi({ description: 'Imported under this account; its owner has not signed in to claim it yet.' }),
  })
  .openapi('Publisher');

export const ItemSummary = z
  .object({
    id: z.string().openapi({ description: 'Stable id (UUIDv7); survives renames.' }),
    ref: z.string().openapi({ example: 'anthropics/pdf', description: 'publisher/name: the address.' }),
    name: z.string(),
    kind: Kind,
    status: z.enum(['public', 'listed']).openapi({ description: 'listed: reachable by address or exact name, not browsed or recommended.' }),
    title: Localized,
    summary: Localized,
    publisher: Publisher,
    tags: z.array(z.string()),
    runtime: z.string().openapi({ example: 'python' }),
    risk: Risk,
    reviewed: z.boolean().openapi({ description: 'A person has reviewed it.' }),
    featured: z.boolean(),
    source: z.enum(['registry', 'github', 'upload', 'form']),
    repoStars: z.number().int().nullable(),
    stars: z.number().int(),
    installs: z.number().int(),
    latest: z.object({ revision: z.number().int(), version: z.string().nullable(), publishedAt: z.string() }),
  })
  .openapi('ItemSummary');

export const ItemList = z
  .object({
    items: z.array(ItemSummary),
    next: z.string().nullable().openapi({ description: 'Pass back as `cursor` for the next page; null on the last.' }),
    approxTotal: z.number().int().nullable(),
  })
  .openapi('ItemList');

export const Permissions = z
  .object({
    runsCode: z.array(z.string()),
    installs: z.array(z.string()),
    installScripts: z.array(z.string()),
    network: z.array(z.string()),
    secrets: z.array(z.string()),
    paths: z.array(z.string()),
    tools: z.array(z.string()),
  })
  .openapi('Permissions');

export const PinnedPackage = z
  .object({
    registryType: z.string().openapi({ example: 'npm' }),
    identifier: z.string(),
    version: z.string().nullable(),
    verified: z.enum(['ok', 'missing', 'unchecked', 'pending']),
    integrity: z.string().optional().openapi({ description: "npm: the tarball's integrity (sha512-…)." }),
    files: z.array(z.object({ name: z.string(), sha256: z.string(), kind: z.enum(['wheel', 'sdist']) })).optional(),
    hasInstallScript: z.boolean().optional(),
    fileSha256: z.string().optional(),
  })
  .openapi('PinnedPackage');

export const Advisory = z
  .object({
    id: z.string(),
    severity: Risk,
    action: z.enum(['notify', 'disable', 'remove']).openapi({ description: 'What clients do with installed copies.' }),
    revisions: z.array(z.number().int()).openapi({ description: 'The versions it applies to; empty for all.' }),
    summary: Localized,
    publishedAt: z.string(),
  })
  .openapi('Advisory', { description: 'Security advisories arrive in H3; until then the list is always empty.' });

export const FileEntry = z.object({ path: z.string(), sha256: z.string(), size: z.number().int(), executable: z.boolean() }).openapi('FileEntry');

export const InstallInfo = z
  .object({
    item: z.object({ id: z.string(), ref: z.string(), kind: Kind, title: Localized }),
    version: z.object({ revision: z.number().int(), version: z.string().nullable(), publishedAt: z.string(), status: z.enum(['ok', 'yanked', 'blocked']) }),
    archive: z
      .object({ url: z.string(), sha256: z.string(), size: z.number().int() })
      .nullable()
      .openapi({ description: 'The whole package as one zip. Null when its license does not let us hand out copies: fetch `files` from `source`.' }),
    files: z.array(FileEntry),
    source: z
      .object({ repository: z.string(), commit: z.string(), path: z.string() })
      .nullable()
      .openapi({ description: 'GitHub owner/repo, commit and folder to fetch the files from when there is no archive.' }),
    skill: z
      .object({
        name: z.string(),
        description: z.string(),
        allowedTools: z.array(z.string()).optional(),
        license: z.string().optional(),
        compatibility: z.string().optional(),
      })
      .optional(),
    server: z.looseObject({ name: z.string() }).optional().openapi({ description: "The registry's server.json, as published." }),
    packages: z.array(PinnedPackage).optional(),
    permissions: Permissions,
    risk: Risk,
    reviewed: z.boolean(),
    advisories: z.array(Advisory),
  })
  .openapi('InstallInfo');

export const Finding = z
  .object({
    check: z.string(),
    severity: Risk,
    path: z.string().optional(),
    line: z.number().int().optional(),
    rule: z.string().optional(),
    category: z.string().optional(),
  })
  .openapi('Finding');

export const ItemDetail = ItemSummary.extend({
  license: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  listedReasons: z.array(z.string()),
  permissions: z.object({ declared: Permissions.partial(), detected: Permissions }),
  checks: z.object({
    findings: z.array(Finding),
    review: z.enum(['off', 'pending', 'done']),
    rules: z.string().nullable(),
    checkedAt: z.string(),
    secrets: z.number().int().openapi({ description: 'Credentials found (where, never what).' }),
    warnings: z.array(z.string()),
    dropped: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  readme: z.string().nullable().openapi({ description: 'Address of the description, rendered to safe HTML.' }),
  install: InstallInfo,
}).openapi('ItemDetail');

export const VersionSummary = z
  .object({ revision: z.number().int(), version: z.string().nullable(), status: z.enum(['ok', 'yanked', 'blocked']), risk: Risk, publishedAt: z.string() })
  .openapi('VersionSummary');

export const PublisherInfo = Publisher.extend({ githubLogin: z.string().nullable(), domain: z.string().nullable(), items: z.number().int() }).openapi('PublisherInfo');

export const TagInfo = z.object({ id: z.string(), name: Localized, count: z.number().int() }).openapi('Tag');

export const Config = z
  .object({
    limits: z.object({
      zipBytes: z.number().int(),
      totalBytes: z.number().int(),
      files: z.number().int(),
      fileBytes: z.number().int(),
      depth: z.number().int(),
      pathBytes: z.number().int(),
      compression: z.object({ minBytes: z.number().int(), ratio: z.number() }),
      textBytes: z.number().int(),
      descriptionChars: z.number().int(),
    }),
    kinds: z.array(Kind),
    sorts: z.array(z.enum(['popular', 'new', 'updated'])),
    runtimes: z.array(z.object({ id: z.string(), count: z.number().int() })),
    tags: z.array(TagInfo),
    review: z.enum(['off', 'on']).openapi({ description: 'Whether versions get the model review.' }),
  })
  .openapi('Config');

export const ErrorBody = z.object({ error: z.string().openapi({ example: 'not_found' }) }).openapi('Error');

export type ItemSummary = z.infer<typeof ItemSummary>;
export type ItemList = z.infer<typeof ItemList>;
export type InstallInfo = z.infer<typeof InstallInfo>;
export type ItemDetail = z.infer<typeof ItemDetail>;
export type VersionSummary = z.infer<typeof VersionSummary>;
export type PublisherInfo = z.infer<typeof PublisherInfo>;
export type TagInfo = z.infer<typeof TagInfo>;
export type Config = z.infer<typeof Config>;
export type PublisherSummary = z.infer<typeof Publisher>;
export type FileEntry = z.infer<typeof FileEntry>;
