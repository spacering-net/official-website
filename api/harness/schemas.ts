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
    avatar: z
      .string()
      .nullable()
      .openapi({ example: '/api/avatars/0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90/4f1c2a9e8b7d6c5a.png', description: "The publisher's picture, kept on this site: a GitHub account's avatar or a domain's icon. Null if it has none." }),
  })
  .openapi('Publisher');

export const PromptCard = z
  .object({
    excerpt: z.string().openapi({ description: 'The start of the prompt, on one line.' }),
    cover: z.string().nullable().openapi({ description: 'A picture of what it makes, kept on this site; null if there is none.' }),
    motion: z.string().nullable().openapi({ description: 'The same, moving (an animated WebP); null if there is none.' }),
    model: z.string().nullable().openapi({ example: 'claude-opus-5-5', description: 'The model it was written for.' }),
    by: z.string().nullable().openapi({ description: 'Who shared it first (a handle where it was shared, without @).' }),
    results: z.number().int().openapi({ description: 'How many results made with it its source lists.' }),
    partial: z.boolean().openapi({ description: 'Its author shared only part of it.' }),
  })
  .openapi('PromptCard');

export const Access = z
  .object({
    read: z.boolean().openapi({ description: 'It may read files (Read, Grep, Glob).' }),
    edit: z.boolean().openapi({ description: 'It may change files (Write, Edit).' }),
    run: z.boolean().openapi({ description: 'It may run commands (Bash).' }),
    web: z.boolean().openapi({ description: 'It may reach the web (WebFetch, WebSearch).' }),
    all: z.boolean().openapi({ description: 'Its tools are not limited: every tool the agent has, MCP tools included.' }),
  })
  .openapi('Access', { description: "What an assistant may touch, by its definition's tools." });

export const AssistantCard = z
  .object({
    role: z.string().openapi({ description: 'What it does: its description without examples, cut to what a card shows.' }),
    model: z.string().nullable().openapi({ example: 'sonnet', description: 'As its definition gives it: an alias (sonnet, opus, haiku, fable, inherit) or a model id.' }),
    tools: z.array(z.string()).nullable().openapi({ description: 'The tools it lists; null when it lists none (not limited).' }),
    access: Access,
    color: z.string().nullable().openapi({ example: 'blue', description: "One of Claude Code's eight colours for subagents, the nearest to the one it names; null for none." }),
    skills: z.number().int().openapi({ description: 'How many skills it has loaded when it starts.' }),
    mcpServers: z.number().int().openapi({ description: 'How many MCP servers it names.' }),
    plugin: z.string().nullable().openapi({ description: 'The plugin of its repository it comes in.' }),
    alsoIn: z.array(z.string()).openapi({ description: 'Other plugins of its repository that carry the same assistant (listed as copies).' }),
  })
  .openapi('AssistantCard');

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
    prompt: PromptCard.optional().openapi({ description: 'Prompts only: what their cards show.' }),
    assistant: AssistantCard.optional().openapi({ description: 'Assistants only: what their cards show.' }),
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
    tools: z.array(z.string()).openapi({ description: "Agent tools it asks for; an assistant that lists none may use all of them, given as ['*']." }),
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

export const Showcase = z
  .object({
    by: z.object({ name: z.string(), url: z.string().nullable() }).nullable().openapi({ description: 'Who made and shared it.' }),
    link: z.string().nullable().openapi({ description: 'The original post.' }),
    cover: z.string().nullable().openapi({ description: 'A picture of it, kept on this site.' }),
    motion: z.string().nullable().openapi({ description: 'The same, moving.' }),
    category: z.string().nullable(),
    categoryName: Localized.optional(),
    labels: z.array(z.string()),
    at: z.string().nullable().openapi({ description: 'When it was posted, or collected.' }),
  })
  .openapi('Showcase', { description: 'A result made with a prompt.' });

export const PromptInfo = z
  .object({
    text: z.string().openapi({ description: 'The prompt, as it is to be used.' }),
    model: z.string().nullable(),
    argumentHint: z.string().nullable().openapi({ description: 'What to add to it, as Claude Code commands give `argument-hint`.' }),
    partial: z.boolean(),
    rights: z.enum(['creators', 'license']).openapi({ description: "creators: it belongs to whoever shared it (credit them, see `showcases`); license: the item's license covers it." }),
    lang: z.string().nullable().openapi({ example: 'en' }),
    showcases: z.array(Showcase).openapi({ description: 'Results made with it, the first first.' }),
  })
  .openapi('PromptInfo');

export const AssistantExample = z
  .object({
    context: z.string().nullable(),
    user: z.string().openapi({ description: 'What the user says.' }),
    assistant: z.string().nullable().openapi({ description: 'How the main session answers, handing the work over.' }),
    commentary: z.string().nullable().openapi({ description: 'Why it is handed over.' }),
  })
  .openapi('AssistantExample', { description: "An example from its definition's description, written for the agent that decides when to hand it work." });

export const AssistantInfo = z
  .object({
    name: z.string().openapi({ description: 'As its definition gives it: what it is called once installed (it may differ from the address).' }),
    file: z.string().openapi({ example: 'code-reviewer.md', description: 'The definition, the one file of the package.' }),
    description: z.string().openapi({ description: 'When to hand it work, without the examples written into it.' }),
    model: z.string().nullable(),
    tools: z.array(z.string()).nullable().openapi({ description: 'null: not limited.' }),
    disallowedTools: z.array(z.string()),
    access: Access,
    color: z.string().nullable(),
    skills: z
      .array(z.object({ name: z.string(), ref: z.string().nullable().openapi({ description: "The skill's address in Harness (same publisher), if it has one." }) }))
      .openapi({ description: 'Skills it has loaded when it starts: install them with it.' }),
    mcpServers: z.array(z.string()).openapi({ description: 'MCP servers it may use, by the names the user has them under.' }),
    mcpLaunches: z.array(z.string()).openapi({ description: 'MCP servers it defines itself with a command to launch.' }),
    permissionMode: z.string().nullable(),
    hooks: z.boolean().openapi({ description: 'It brings hooks, which run commands.' }),
    starters: z.array(z.string()).openapi({ description: 'Things to say to it.' }),
    examples: z.array(AssistantExample),
    vibe: z.string().nullable().openapi({ description: 'A line about itself, for people.' }),
    emoji: z.string().nullable(),
    settings: z.record(z.string(), z.unknown()).openapi({ description: 'The rest of its frontmatter, as written (effort, maxTurns, initialPrompt, ...).' }),
    plugin: z.string().nullable(),
    alsoIn: z.array(z.string()),
  })
  .openapi('AssistantInfo');

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
    prompt: PromptInfo.optional().openapi({ description: 'Prompts only. The package is PROMPT.md: this text, with frontmatter.' }),
    assistant: AssistantInfo.optional().openapi({ description: 'Assistants only. The package is the definition (`file`), a Claude Code subagent as written.' }),
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
export type PromptCard = z.infer<typeof PromptCard>;
export type PromptInfo = z.infer<typeof PromptInfo>;
export type AssistantCard = z.infer<typeof AssistantCard>;
export type AssistantInfo = z.infer<typeof AssistantInfo>;
