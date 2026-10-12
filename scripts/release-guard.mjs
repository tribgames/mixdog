// Shared helpers for the release automation guards: latest-guard.yml,
// publish-asset-release.mjs and post-release-check.mjs.
//
// GitHub's "Latest" release is what electron-updater follows (latest.yml /
// latest-mac.yml), so it must always be the newest published desktop app
// release (vX.Y.Z). Asset releases (effort-judge-*, voice-*, graph-v*, ...)
// and mobile-v* releases must never take it.

import { execFileSync } from 'node:child_process';

export const APP_TAG_RE = /^v\d+\.\d+\.\d+$/;

/** Numeric semver comparison of two vX.Y.Z tags (or X.Y.Z versions). */
export function compareSemver(a, b) {
  const left = String(a).replace(/^v/, '').split('.').map(Number);
  const right = String(b).replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** The newest non-draft, non-prerelease app release, or null. */
export function selectLatestAppRelease(releases) {
  const apps = releases.filter(
    (release) => !release.draft && !release.prerelease && APP_TAG_RE.test(release.tag_name || '')
  );
  apps.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
  return apps[0] ?? null;
}

/** Run `gh` and return stdout. Throws with gh's stderr on failure. */
export function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function ghJson(args, run = gh) {
  return JSON.parse(run(args));
}

/** All releases of a repo, newest first as the API returns them. */
export function listReleases(repo, run = gh) {
  return ghJson(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`], run).flat();
}

/** True only for an explicit HTTP 404 from `gh api`; "not found" wording alone (e.g. behind a 500) is not absence. */
export function isHttp404(error) {
  return /\bHTTP 404\b/.test(`${error.stderr ?? ''}${error.message ?? ''}`);
}

/** Tag of the repo's current "Latest" release, or null when there is none. */
export function currentLatestTag(repo, run = gh) {
  try {
    return run(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name']).trim() || null;
  } catch (error) {
    if (isHttp404(error)) return null;
    throw error;
  }
}
