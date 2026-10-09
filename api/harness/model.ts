/** The shapes Harness keeps: statuses, checks, listings and pinned packages (JSON columns in db/harness). */
import type { FormatError } from './package';
import type { Finding, Severity } from './scan/content';
import type { SecretFinding } from './scan/secrets';
import type { Lang, Localized } from './text';

export type ItemKind = 'skill' | 'mcp' | 'prompt' | 'assistant' | 'connector';
export type ItemStatus = 'draft' | 'pending' | 'listed' | 'public' | 'retired' | 'removed';
export type Risk = Severity;

/** What the checks found, kept per version (item_versions.checks). */
export interface Checks {
  format: { errors: FormatError[]; warnings: string[]; dropped: { path: string; reason: string }[] };
  secrets: SecretFinding[];
  /** built-in structural checks and database rules */
  findings: Finding[];
  /** hash of the rule set the version was checked with */
  rules: string | null;
  /** why the item is not on the shelves, and how much its description reads like stuffing */
  quality: { reasons: string[]; score: number };
  /** the model review: 'off' while it is switched off (wrangler.jsonc, HARNESS_REVIEW) */
  review: 'off' | 'pending' | 'done';
  checkedAt: string;
}

export type TextSource = 'author' | 'model';

/** The listing: what the shelves show (item_versions.listing). */
export interface Listing {
  title: Localized;
  summary: Localized;
  /** who wrote each language of each field */
  sources: { title: Partial<Record<Lang, TextSource>>; summary: Partial<Record<Lang, TextSource>> };
  tags: string[];
  /** the model that wrote the generated parts */
  model?: string;
}

/** A package an MCP server launches, pinned (item_versions.packages). */
export interface PinnedPackage {
  registryType: string;
  identifier: string;
  /** the exact version; null when the source named none and it could not be resolved */
  version: string | null;
  /** 'ok': the registry has this exact version; 'missing': it does not; 'unchecked': not a registry Harness checks yet */
  verified: 'ok' | 'missing' | 'unchecked' | 'pending';
  /** npm: the tarball's integrity (sha512-…) */
  integrity?: string;
  /** PyPI: the release's files and hashes */
  files?: { name: string; sha256: string; kind: 'wheel' | 'sdist' }[];
  /** npm: runs scripts as it installs; PyPI: has no wheel, so builds from source */
  hasInstallScript?: boolean;
  /** an MCP bundle's hash, as server.json gives it */
  fileSha256?: string;
}

/**
 * One result made with a prompt (a video, a game), as its source names it:
 * who shared it, the original post, and pictures of it (addresses at the
 * source; pages show the copies kept here, see the media table).
 */
export interface Showcase {
  by: { name: string; url: string | null } | null;
  link: string | null;
  cover: string | null;
  motion: string | null;
  category: string | null;
  categoryName?: Localized;
  labels: string[];
  /** when it was posted, or collected */
  at: string | null;
}

/** A prompt as a version keeps it (item_versions.metadata.prompt). */
export interface PromptMeta {
  name: string;
  text: string;
  /** the model it was written for */
  model: string | null;
  argumentHint: string | null;
  /** its author shared only part of it */
  partial: boolean;
  /** 'creators': it belongs to whoever shared it (shown credited); 'license': the item's license covers it */
  rights: 'creators' | 'license';
  /** the language it is written in, when it can be told: en, zh, ja, ko */
  lang: string | null;
}

/** What a prompt's card shows (items.card), with its pictures named by their addresses at the source. */
export interface StoredPromptCard {
  excerpt: string;
  /**
   * pictures of its results, a few, the likeliest first: the card shows the
   * first whose cover is kept here, and moves with the first that also has a
   * moving preview kept here (catalog.ts)
   */
  faces: { cover: string | null; motion: string | null }[];
  model: string | null;
  /** who shared it first */
  by: string | null;
  results: number;
  partial: boolean;
}

/**
 * One of the examples a definition's description gives (Anthropic writes them
 * in `<example>` blocks): when it is called, what the user says, what the
 * main session answers, and why.
 */
export interface AssistantExample {
  context: string | null;
  user: string;
  assistant: string | null;
  commentary: string | null;
}

/** What an assistant may touch, by its tools: read files, change them, run commands, reach the web; `all` when its tools are not limited. */
export interface Access {
  read: boolean;
  edit: boolean;
  run: boolean;
  web: boolean;
  all: boolean;
}

/** An assistant as a version keeps it (item_versions.metadata.assistant): its definition's frontmatter, read. */
export interface AssistantMeta {
  /** as the definition gives it: what the assistant is called where it is installed */
  name: string;
  /** when to hand it work, without the examples written into it */
  description: string;
  /** null: not limited, it may use every tool the agent has */
  tools: string[] | null;
  disallowedTools: string[];
  /** as written: an alias (sonnet, opus, haiku, fable, inherit) or a model id */
  model: string | null;
  /** one of Claude Code's eight colours, the nearest when it named another; null when it names none */
  color: string | null;
  /** skills it has loaded when it starts, by name */
  skills: string[];
  /** MCP servers it may use, by name */
  mcpServers: string[];
  /** MCP servers it defines itself with a command to launch */
  mcpLaunches: string[];
  permissionMode: string | null;
  hooks: boolean;
  /** a line about itself, for people (agency-agents' `vibe`) */
  vibe: string | null;
  emoji: string | null;
  /** things to say to it: its own example prompts, and the user's turns in its examples */
  starters: string[];
  examples: AssistantExample[];
  /** the rest of its frontmatter, as written */
  settings: Record<string, unknown>;
  /** its file's name, in its folder (the version's metadata.path) */
  file: string;
  /** the plugin it comes in, when its repository keeps it in one */
  plugin: string | null;
}

/** What an assistant's card shows (items.card). */
export interface StoredAssistantCard {
  /** its description, without examples, cut to what a card can show */
  role: string;
  model: string | null;
  tools: string[] | null;
  access: Access;
  color: string | null;
  skills: number;
  mcpServers: number;
  plugin: string | null;
  /** the other plugins of its repository that carry the same assistant */
  alsoIn: string[];
}

export const listingOf = (title: Localized, summary: Localized, tags: string[]): Listing => ({
  title,
  summary,
  sources: {
    title: Object.fromEntries(Object.keys(title).map((k) => [k, 'author'])),
    summary: Object.fromEntries(Object.keys(summary).map((k) => [k, 'author'])),
  },
  tags,
});
