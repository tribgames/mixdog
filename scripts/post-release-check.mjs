#!/usr/bin/env node
// Final job of Deploy: verify the published app release end to end.
//
//   - GitHub Latest is the new app tag
//   - the release asset set matches the asset contract (release.yml
//     "Verify complete hidden release"), and every url/sha512 listed in
//     latest.yml and latest-mac.yml matches the uploaded assets
//   - mixdog@<version> is resolvable on npm (retried while it propagates)
//   - production relay /app answers 200 and links an existing, published
//     mobile-v* release
//   - the effort-judge manifest release exists, is published, and is not Latest
//
// Env: GITHUB_REPOSITORY, RELEASE_TAG (vX.Y.Z), RELAY_DOMAIN, GH_TOKEN.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseMacFeed } from './merge-mac-update-feed.mjs';
import { APP_TAG_RE, currentLatestTag, gh, isHttp404 } from './release-guard.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep in step with the per-platform `requirements` in
// .github/workflows/release.yml (a unit test compares both). The Linux update
// feeds (latest-linux*.yml) are not parsed here, only required to exist.
export const ASSET_CONTRACT = Object.freeze([
  'latest-linux-arm64.yml',
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
  'mixdog-desktop-linux-amd64.deb',
  'mixdog-desktop-linux-arm64.AppImage',
  'mixdog-desktop-linux-arm64.deb',
  'mixdog-desktop-linux-x86_64.AppImage',
  'mixdog-desktop-mac-arm64.dmg',
  'mixdog-desktop-mac-arm64.zip',
  'mixdog-desktop-mac-arm64.zip.blockmap',
  'mixdog-desktop-mac-x64.dmg',
  'mixdog-desktop-mac-x64.zip',
  'mixdog-desktop-mac-x64.zip.blockmap',
  'mixdog-desktop-win-x64.exe',
  'mixdog-desktop-win-x64.exe.blockmap',
]);

const MAC_ZIPS = ['mixdog-desktop-mac-arm64.zip', 'mixdog-desktop-mac-x64.zip'];

export function checkLatest(tag, latestTag) {
  return latestTag === tag ? [] : [`GitHub Latest is ${latestTag ?? 'none'}, expected ${tag}`];
}

export function checkAssetSet(assets) {
  const problems = [];
  const names = assets.map((asset) => asset.name);
  for (const name of ASSET_CONTRACT) {
    if (!names.includes(name)) problems.push(`missing release asset ${name}`);
  }
  for (const name of names) {
    if (!ASSET_CONTRACT.includes(name)) problems.push(`unexpected release asset ${name}`);
  }
  if (new Set(names).size !== names.length) problems.push('duplicate release asset names');
  for (const asset of assets) {
    if (asset.state !== 'uploaded' || !(asset.size > 0)) problems.push(`incomplete release asset ${asset.name}`);
  }
  return problems;
}

/**
 * Check one electron-builder feed against the uploaded assets: version, that
 * every listed file is an uploaded asset of the listed size, and that its
 * sha512 is the hash of the uploaded bytes. `hashAsset(asset)` returns the
 * base64 sha512 of an asset's content.
 */
export async function checkFeed({ text, label, version, assets, hashAsset, requiredFiles = [] }) {
  let feed;
  try {
    feed = parseMacFeed(text, label);
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  if (feed.version !== version) {
    problems.push(`${label}: version ${feed.version}, expected ${version}`);
  }
  const field = (file, key) =>
    file.lines.map((line) => new RegExp(`^ +(?:- )?${key}: (\\S+)$`).exec(line)?.[1]).find(Boolean);
  const byUrl = new Map(feed.files.map((file) => [file.url, file]));
  for (const name of requiredFiles) {
    if (!byUrl.has(name)) problems.push(`${label}: files[] does not list ${name}`);
  }
  const hashes = new Map();
  for (const file of feed.files) {
    const asset = assets.find((candidate) => candidate.name === file.url);
    if (!asset) {
      problems.push(`${label}: ${file.url} is not an uploaded asset`);
      continue;
    }
    const size = field(file, 'size');
    if (size === undefined || Number(size) !== asset.size) {
      problems.push(`${label}: ${file.url} size ${size} != uploaded ${asset.size}`);
    }
    const sha512 = field(file, 'sha512');
    const actual = await hashAsset(asset);
    hashes.set(file.url, actual);
    if (sha512 !== actual) problems.push(`${label}: ${file.url} sha512 does not match the uploaded asset`);
  }
  // Top-level path/sha512 is what pre-files[] clients read; it must agree too.
  const topPath = /^path: (\S+)$/.exec(feed.top.path)?.[1];
  const topSha = /^sha512: (\S+)$/.exec(feed.top.sha512)?.[1];
  if (!byUrl.has(topPath)) problems.push(`${label}: path ${topPath} is not listed in files[]`);
  else if (hashes.has(topPath) && hashes.get(topPath) !== topSha) {
    problems.push(`${label}: top-level sha512 does not match ${topPath}`);
  }
  return problems;
}

export async function waitForNpm({
  name,
  version,
  fetchFn = fetch,
  sleep = defaultSleep,
  budgetMs = 10 * 60 * 1000,
  firstDelayMs = 5000,
  maxDelayMs = 60_000,
}) {
  let waited = 0;
  let delay = firstDelayMs;
  let last = 'not queried';
  for (;;) {
    try {
      const response = await fetchFn(`https://registry.npmjs.org/${name}/${version}`);
      if (response.ok && (await response.json()).version === version) return [];
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    if (waited >= budgetMs)
      return [`${name}@${version} not resolvable on npm after ${Math.round(waited / 1000)}s (${last})`];
    const step = Math.min(delay, budgetMs - waited);
    await sleep(step);
    waited += step;
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

const ANDROID_LINK_RE =
  /https:\/\/github\.com\/[^"'\s<>]+\/releases\/(?:tag|download)\/(mobile-v\d+\.\d+\.\d+)[^"'\s<>]*/;

/**
 * `getRelease(tag)` returns the release object or null when it does not exist.
 * `mobileVersion` is the Android version this deploy tried to ship (empty for
 * none). When that release failed, /app keeps linking the previous good
 * mobile-v* release (or the releases list); that is a warning, not an error.
 * A link to a missing or draft release stays an error.
 * Returns { problems, warnings }.
 */
export async function checkRelayApp({ domain, fetchFn = fetch, getRelease, mobileVersion = '' }) {
  const page = await fetchFn(`https://${domain}/app`);
  if (page.status !== 200)
    return { problems: [`https://${domain}/app answered ${page.status}, expected 200`], warnings: [] };
  const match = ANDROID_LINK_RE.exec(await page.text());
  const wanted = mobileVersion ? `mobile-v${mobileVersion}` : '';
  if (!match) {
    return wanted
      ? {
          problems: [],
          warnings: [`/app links no mobile-v* release; ${wanted} was not shipped (previous good release kept)`],
        }
      : { problems: [`https://${domain}/app has no link to a mobile-v* release`], warnings: [] };
  }
  const [url, tag] = match;
  const release = getRelease(tag);
  if (!release) return { problems: [`/app links ${tag}, which is not an existing release`], warnings: [] };
  if (release.draft) return { problems: [`/app links ${tag}, which is still a draft`], warnings: [] };
  const resolved = await fetchFn(url, { redirect: 'follow' });
  if (!resolved.ok) return { problems: [`/app Android link ${url} answered ${resolved.status}`], warnings: [] };
  const warnings =
    wanted && tag !== wanted
      ? [
          `/app links ${tag} instead of ${wanted}; the Android release failed or is not yet published (previous good release kept)`,
        ]
      : [];
  return { problems: [], warnings };
}

export function checkEffortJudge({ manifest, latestTag, getRelease }) {
  const tag = manifest.release;
  const release = getRelease(tag);
  if (!release) return [`effort-judge release ${tag} does not exist`];
  const problems = [];
  if (release.draft) problems.push(`effort-judge release ${tag} is a draft`);
  if (latestTag === tag) problems.push(`effort-judge release ${tag} is GitHub Latest`);
  for (const [name, file] of Object.entries(manifest.files)) {
    const asset = (release.assets ?? []).find((candidate) => candidate.name === name);
    if (!asset) problems.push(`effort-judge release ${tag} lacks ${name}`);
    else if (asset.size !== file.size)
      problems.push(`effort-judge ${name} size ${asset.size} != manifest ${file.size}`);
  }
  return problems;
}

/** The release for `tag`, or null only on an explicit HTTP 404. Any other failure throws. */
export function getReleaseByTag(repo, tag, run = gh) {
  try {
    return JSON.parse(run(['api', `repos/${repo}/releases/tags/${tag}`]));
  } catch (error) {
    if (isHttp404(error)) return null;
    throw error;
  }
}

/**
 * Was the app release published? A missing release (`fetchRelease` returns
 * null) or a draft means "not published" and the checks are skipped. Any
 * other failure (auth, transport, 5xx) is retried with backoff and then
 * rethrown, so an API outage fails the job instead of silently skipping
 * verification of a release that may be public.
 */
export async function detectPublished({
  fetchRelease,
  sleep = defaultSleep,
  attempts = 5,
  firstDelayMs = 2000,
}) {
  let delay = firstDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const release = fetchRelease();
      return Boolean(release) && release.draft === false;
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(
          `could not determine whether the release is published after ${attempts} attempts: ${error.message}`
        );
      }
      await sleep(delay);
      delay *= 2;
    }
  }
}

async function sha512Base64(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download ${url} answered ${response.status}`);
  const hash = createHash('sha512');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('base64');
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  const domain = process.env.RELAY_DOMAIN;
  if (!repo || !APP_TAG_RE.test(tag ?? '') || !domain) {
    throw new Error('GITHUB_REPOSITORY, RELEASE_TAG (vX.Y.Z) and RELAY_DOMAIN are required');
  }
  const version = tag.slice(1);
  const getRelease = (releaseTag) => getReleaseByTag(repo, releaseTag);
  const release = getRelease(tag);
  const assets = release?.assets ?? [];
  const latestTag = currentLatestTag(repo);
  const hashed = new Map();
  const hashAsset = (asset) => {
    if (!hashed.has(asset.name)) hashed.set(asset.name, sha512Base64(asset.browser_download_url));
    return hashed.get(asset.name);
  };
  const feedText = async (name) => {
    const asset = assets.find((candidate) => candidate.name === name);
    if (!asset) return null;
    const response = await fetch(asset.browser_download_url, { redirect: 'follow' });
    return response.ok ? response.text() : null;
  };
  const feed = async (name, requiredFiles) => {
    const text = await feedText(name);
    if (text === null) return [`${name} could not be downloaded from ${tag}`];
    return checkFeed({ text, label: name, version, assets, hashAsset, requiredFiles });
  };

  const sections = [
    [
      'GitHub Latest',
      async () => (release && !release.draft ? checkLatest(tag, latestTag) : [`${tag} is not a published release`]),
    ],
    ['Release assets', async () => checkAssetSet(assets)],
    ['latest.yml', () => feed('latest.yml', ['mixdog-desktop-win-x64.exe'])],
    ['latest-mac.yml', () => feed('latest-mac.yml', MAC_ZIPS)],
    ['Relay /app', () => checkRelayApp({ domain, getRelease, mobileVersion: process.env.MOBILE_VERSION ?? '' })],
    [
      'effort-judge release',
      async () =>
        checkEffortJudge({
          manifest: JSON.parse(readFileSync('src/runtime/effort-judge/model-manifest.json', 'utf8')),
          latestTag,
          getRelease,
        }),
    ],
    ['npm', () => waitForNpm({ name: 'mixdog', version })],
  ];
  const results = [];
  for (const [name, run] of sections) {
    try {
      const outcome = await run();
      results.push(
        Array.isArray(outcome)
          ? { name, problems: outcome, warnings: [] }
          : { name, problems: outcome.problems, warnings: outcome.warnings }
      );
    } catch (error) {
      results.push({ name, problems: [`check failed: ${error.message}`], warnings: [] });
    }
  }

  const lines = [`## Post-release check for ${tag}`, ''];
  for (const { name, problems, warnings } of results) {
    let status = 'ok';
    if (problems.length) status = 'FAIL';
    else if (warnings.length) status = 'WARN';
    lines.push(`- ${status} ${name}`);
    for (const problem of problems) lines.push(`    - ${problem}`);
    for (const warning of warnings) {
      lines.push(`    - warning: ${warning}`);
      console.log(`::warning title=Post-release ${name}::${warning}`);
    }
  }
  const text = `${lines.join('\n')}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  return results.some(({ problems }) => problems.length) ? 1 : 0;
}

// `detect-published`: write published=true|false to GITHUB_OUTPUT. Exits 1
// (job fails) when the GitHub API cannot give a definite answer.
async function detectPublishedMain() {
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG;
  if (!repo || !APP_TAG_RE.test(tag ?? '')) {
    throw new Error('GITHUB_REPOSITORY and RELEASE_TAG (vX.Y.Z) are required');
  }
  const published = await detectPublished({ fetchRelease: () => getReleaseByTag(repo, tag) });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
  const result = process.env.RELEASE_RESULT ?? 'unknown';
  if (published) console.log(`${tag} is published (release job: ${result}); running the post-release checks.`);
  else console.log(`::notice title=Post-release checks skipped::${tag} was not published (release job: ${result}).`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exit(process.argv[2] === 'detect-published' ? await detectPublishedMain() : await main());
  } catch (error) {
    console.log(`::error title=Post-release check::${error.message}`);
    process.exit(1);
  }
}
