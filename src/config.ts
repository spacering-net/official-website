/**
 * Site-wide constants. When Codeg moves to the spacering-net organisation,
 * change `codeg.repo` to 'spacering-net/codeg'. GitHub redirects the old
 * path, so nothing breaks before then.
 */
export const SITE = {
  url: 'https://spacering.net',
  name: 'SpaceRing',
  org: 'spacering-net',
  orgUrl: 'https://github.com/spacering-net',
  codeg: {
    repo: 'xintaofei/codeg',
    docs: 'https://docs.codeg.app',
  },
} as const;

export const repoUrl = (repo: string) => `https://github.com/${repo}`;
export const releasesUrl = (repo: string) => `https://github.com/${repo}/releases/latest`;

/** Used when the build cannot reach the GitHub API. Last checked 2026-10-06. */
export const CODEG_FALLBACK = {
  stars: 3804,
  forks: 490,
  version: 'v0.33.0',
  license: 'Apache-2.0',
};
