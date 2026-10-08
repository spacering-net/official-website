/** Site-wide constants. */
export const SITE = {
  url: 'https://spacering.net',
  name: 'SpaceRing',
  org: 'spacering-net',
  orgUrl: 'https://github.com/spacering-net',
  codeg: {
    repo: 'spacering-net/codeg',
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
