import MarkdownIt from 'markdown-it';

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

/** The start of a description as plain text, for the search index. */
export function excerpt(text: string, max = 2000): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
