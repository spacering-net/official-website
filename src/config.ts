/** Site-wide constants. */
export const SITE = {
  url: 'https://spacering.net',
  name: 'SpaceRing',
  org: 'spacering-net',
  orgUrl: 'https://github.com/spacering-net',
  /** this website's own repository, and its license */
  site: {
    repo: 'spacering-net/official-website',
    license: 'MIT',
  },
  codeg: {
    repo: 'spacering-net/codeg',
    docs: 'https://docs.codeg.app',
    /** the first version that opens Harness links (codeg://harness/…, /workspace?harness=…); set when it ships */
    opensHarness: '0.46',
    /** the first version that installs Harness plugins; shown only while HARNESS_PLUGINS is on (docs/harness-plugins.md, phase P3) */
    installsPlugins: '0.48' as string | null,
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
