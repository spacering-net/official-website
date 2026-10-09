import MarkdownIt, { type Token } from 'markdown-it';

/**
 * Descriptions from packages, rendered to HTML that is safe to put on
 * spacering.net (docs: section 7): raw HTML is never passed through (it is
 * shown as text), links go only to http(s) and mailto and are marked as
 * user content, relative links become plain text, and images become links
 * (nothing is loaded from elsewhere).
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:|^\/\//i;
// absolute links to safe schemes, and relative ones (rendered as text below)
md.validateLink = (url) => SAFE_LINK.test(url.trim()) || !HAS_SCHEME.test(url.trim());

// per render: whether each open link was kept (a safe address) or turned into text
type RenderState = { links?: boolean[] };
const attr = (v: string | number | null) => (v === null ? '' : String(v));

md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const safe = SAFE_LINK.test(attr(tokens[i].attrGet('href')));
  ((env as RenderState).links ??= []).push(safe);
  if (!safe) return '<span>';
  tokens[i].attrSet('rel', 'nofollow ugc noopener noreferrer');
  tokens[i].attrSet('target', '_blank');
  return self.renderToken(tokens, i, options);
};
md.renderer.rules.link_close = (tokens, i, options, env, self) => ((env as RenderState).links?.pop() ? self.renderToken(tokens, i, options) : '</span>');

md.renderer.rules.image = (tokens, i) => {
  const t = tokens[i];
  const src = attr(t.attrGet('src'));
  const alt = md.utils.escapeHtml(t.content || src);
  return SAFE_LINK.test(src)
    ? `<a href="${md.utils.escapeHtml(src)}" rel="nofollow ugc noopener noreferrer" target="_blank">[${alt}]</a>`
    : `<span>[${alt}]</span>`;
};

export const renderMarkdown = (text: string): string => md.render(text, {} satisfies RenderState);

/** Line ends as markdown-it reads them (\n), and no NUL: what its block parser expects. */
const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');

/** The block structure of a Markdown text, as markdown-it reads it (no inline parsing: quick and small). */
function blocksOf(text: string): Token[] {
  const tokens: Token[] = [];
  md.block.parse(text, md, {}, tokens);
  return tokens;
}

/**
 * A Markdown text's prose: its code taken out (fenced and indented blocks, at
 * any depth: in a list or a quote too, as markdown-it reads them), and the
 * comments in what is left, each within the stretch of prose it is in, so
 * taking the code out cannot pair one comment's start with another's end.
 * Line ends as \n; the stretches parted by a blank line, as the code was.
 */
export function prose(text: string): string {
  const src = normalize(text);
  const code = new Set<number>();
  for (const t of blocksOf(src)) {
    if ((t.type === 'fence' || t.type === 'code_block') && t.map) for (let i = t.map[0]; i < t.map[1]; i++) code.add(i);
  }
  const runs: string[][] = [[]];
  src.split('\n').forEach((line, i) => {
    if (!code.has(i)) runs[runs.length - 1].push(line);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  return runs
    .filter((r) => r.length)
    .map((r) => r.join('\n').replace(/<!--[\s\S]*?-->/g, ' '))
    .join('\n\n');
}

/**
 * A body's first top-level `#` heading among its first lines: what its author
 * titled it. One in code is not (`# Read the build file` in a shell block is a
 * comment), nor one inside a list, a quote or a table's head. Only those lines
 * are read, and a few after them (a table's second line makes its first one).
 */
export function firstHeading(body: string, lines = 20): string | null {
  const head = normalize(body).split('\n', lines + 10).join('\n');
  const tokens = blocksOf(head);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open' || t.tag !== 'h1' || t.level !== 0 || t.markup !== '#' || !t.map || t.map[0] >= lines) continue;
    const text = tokens[i + 1]?.content.trim() ?? '';
    if (text.length >= 2 && text.length <= 80) return text;
  }
  return null;
}

/**
 * Prose (see `prose`) as plain text, for the search index: pictures, link
 * targets and markup taken out, spaces collapsed, cut to `max`.
 */
export function plainText(text: string, max = 2000): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * The start of a description as plain text, for the search index: no code, no
 * comments. Only its first 64 KiB are read (a SKILL.md may be megabytes; its
 * start is what is wanted).
 */
export const excerpt = (text: string, max = 2000): string => plainText(prose(text.slice(0, 64 * 1024)), max);
