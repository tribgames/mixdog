// The mobile (Android APK + iOS TestFlight) side of Deploy.
//
// plan: whether this deploy ships a mobile release and under which version.
//   A release is due when anything the app binaries are built from changed
//   since the newest mobile-v* tag (input `auto`), always (`force`), or never
//   (`skip`). The version is the next patch (or minor) of that tag. The tag
//   itself is created by the Android release, so a failed mobile release
//   leaves no tag and the next deploy plans the same version again.
//   CLI: MOBILE_MODE=auto|force|skip MOBILE_BUMP=patch|minor node scripts/mobile-release.mjs plan
//   appends mobile_release / mobile_version / mobile_tag to $GITHUB_OUTPUT.
//
// link: the Android release the relay's /app page links — the newest
//   published (non-draft) mobile-v* release whose APK actually downloads, or
//   the releases list when there is none. `--require=<tag>` instead fails
//   unless that exact release is the one that resolves (post-publish check).
//   CLI: GITHUB_REPOSITORY=o/r GH_TOKEN=… node scripts/mobile-release.mjs link [--require=mobile-vX.Y.Z]
//   appends url / tag to $GITHUB_OUTPUT.
import { appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const TAG_RE = /^mobile-v(\d+)\.(\d+)\.(\d+)$/;

// Everything the APK and the iOS build are made from. The app bundles one
// desktop module (apps/mobile/src/main.ts imports shared/native-app.ts, which
// imports nothing). Relay changes are not listed: the relay deploys on its
// own with every release and the app binary does not embed it.
export const MOBILE_RELEASE_PATHS = [
  'apps/mobile',
  ':(exclude,glob)apps/mobile/**/*.md',
  'apps/desktop/src/shared/native-app.ts',
  '.github/workflows/mobile-android.yml',
  '.github/workflows/mobile-ios.yml',
];

export function parseMobileTag(tag) {
  const match = TAG_RE.exec(String(tag ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareMobileTags(left, right) {
  const a = parseMobileTag(left);
  const b = parseMobileTag(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function latestMobileTag(tags) {
  const valid = tags.map((tag) => String(tag).trim()).filter((tag) => parseMobileTag(tag));
  return valid.sort(compareMobileTags).at(-1) ?? null;
}

export function nextMobileVersion(tag, bump = 'patch') {
  const parts = parseMobileTag(tag);
  if (!parts) throw new Error(`invalid mobile release tag: ${tag}`);
  const [major, minor, patch] = parts;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`invalid mobile version bump: ${bump}`);
}

/** `changedSince(tag)` answers whether a mobile path changed between tag and HEAD. */
export function planMobileRelease({ mode = 'auto', bump = 'patch', tags, changedSince }) {
  if (!['auto', 'force', 'skip'].includes(mode)) throw new Error(`invalid mobile mode: ${mode}`);
  if (!['patch', 'minor'].includes(bump)) throw new Error(`invalid mobile version bump: ${bump}`);
  const base = latestMobileTag(tags);
  const none = (reason) => ({ release: false, version: '', tag: '', base: base ?? '', reason });
  if (mode === 'skip') return none('skipped by the mobile input');
  // Versions continue from the newest tag; without one there is nothing to
  // continue from, and guessing could overwrite a published release.
  if (!base) return none('no mobile-v* tag yet: push the first one by hand');
  const changed = changedSince(base);
  if (mode === 'auto' && !changed) return none(`no mobile source changed since ${base}`);
  const version = nextMobileVersion(base, bump);
  return {
    release: true,
    version,
    tag: `mobile-v${version}`,
    base,
    reason: changed ? `mobile sources changed since ${base}` : 'forced by the mobile input',
  };
}

export function mobilePathsChangedSince(tag, { cwd } = {}) {
  const result = spawnSync('git', ['diff', '--quiet', `${tag}..HEAD`, '--', ...MOBILE_RELEASE_PATHS], { cwd });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(`git diff failed for ${tag}: ${result.stderr?.toString() || result.status}`);
}

/** Published mobile releases that carry an APK, newest version first. */
export function androidReleaseCandidates(releases) {
  return releases
    .filter((release) => !release.draft && parseMobileTag(release.tag_name))
    .map((release) => ({
      tag: release.tag_name,
      url: release.html_url,
      apkUrl: release.assets?.find((asset) => /\.apk$/i.test(asset.name || ''))?.browser_download_url,
    }))
    .filter((release) => release.url && release.apkUrl)
    .sort((left, right) => compareMobileTags(right.tag, left.tag));
}

async function listReleases(repository, { token, fetchImpl }) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`listing releases failed: HTTP ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

async function downloadable(url, { fetchImpl, attempts, delayMs }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
      if (response.ok) return true;
    } catch {
      /* retried below */
    }
    if (attempt < attempts) await delay(delayMs);
  }
  return false;
}

export async function resolveAndroidLink({
  repository,
  token = '',
  requiredTag = '',
  fetchImpl = fetch,
  attempts = 3,
  delayMs = 5000,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error(`invalid repository: ${repository}`);
  }
  if (requiredTag && !parseMobileTag(requiredTag)) throw new Error(`invalid mobile release tag: ${requiredTag}`);
  const candidates = androidReleaseCandidates(await listReleases(repository, { token, fetchImpl }));
  for (const candidate of requiredTag ? candidates.filter((item) => item.tag === requiredTag) : candidates) {
    if (await downloadable(candidate.apkUrl, { fetchImpl, attempts, delayMs })) {
      return { url: candidate.url, tag: candidate.tag };
    }
    if (!requiredTag) console.warn(`::warning::${candidate.tag} APK is not downloadable; trying an older release.`);
  }
  if (requiredTag) throw new Error(`${requiredTag} is not a published release with a downloadable APK`);
  return { url: `https://github.com/${repository}/releases`, tag: '' };
}

function writeOutputs(values) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    );
  }
  console.log(JSON.stringify(values, null, 2));
}

async function main([command, ...args]) {
  if (command === 'plan') {
    const tags = execFileSync('git', ['tag', '--list', 'mobile-v*'], { encoding: 'utf8' }).split(/\r?\n/);
    const plan = planMobileRelease({
      mode: process.env.MOBILE_MODE || 'auto',
      bump: process.env.MOBILE_BUMP || 'patch',
      tags,
      changedSince: (tag) => mobilePathsChangedSince(tag),
    });
    writeOutputs({
      mobile_release: String(plan.release),
      mobile_version: plan.version,
      mobile_tag: plan.tag,
      mobile_base: plan.base,
      mobile_reason: plan.reason,
    });
    return;
  }
  if (command === 'link') {
    const requiredTag = args.find((arg) => arg.startsWith('--require='))?.slice('--require='.length) || '';
    writeOutputs(
      await resolveAndroidLink({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GH_TOKEN || '',
        requiredTag,
        // Right after publishing, the asset CDN can lag a few seconds.
        attempts: requiredTag ? 6 : 3,
      })
    );
    return;
  }
  throw new Error('usage: node scripts/mobile-release.mjs plan | link [--require=mobile-vX.Y.Z]');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
