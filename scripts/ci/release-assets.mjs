import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  SERVER_PLATFORM_TARGETS,
  serverBundleAsset,
  serverManifestProblems,
} from '../../apps/desktop/src/main/ssh/server-manifest.mjs';
import { PLATFORMS, runtimeAssetName } from '../npm-platforms.mjs';

const curl = promisify(execFile);
const sha256 = /^sha256:[a-f0-9]{64}$/;
const assetName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const { GH_TOKEN, GITHUB_REPOSITORY: repo, RELEASE_TAG: tag, RELEASE_REF: ref } = process.env;
const releaseId = () => process.env.RELEASE_ID;

export const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
export const api = (path, args = []) => JSON.parse(gh(['api', path, ...args]));
const releasePath = () => {
  const id = releaseId();
  if (!/^\d+$/.test(id ?? '') || !tag || !/^[a-f0-9]{40}$/.test(ref ?? '')) {
    throw new Error('Expected release ID, tag and immutable commit SHA');
  }
  return `repos/${repo}/releases/${id}`;
};

/** The release of this id, tag and commit: a draft (`draft` true), public (false) or either (null). */
export function readRelease(draft, target = ref) {
  const id = releaseId();
  const release = api(releasePath());
  if (
    String(release.id) !== id ||
    release.tag_name !== tag ||
    release.target_commitish !== target ||
    (draft !== null && release.draft !== draft) ||
    release.prerelease !== false
  ) {
    const expected = draft === null ? 'release' : draft ? 'draft' : 'public release';
    throw new Error(`Release ${id} is not the expected ${expected} of ${tag} at ${target}`);
  }
  return release;
}

export function readAssets() {
  return api(`${releasePath()}/assets?per_page=100`, ['--paginate', '--slurp']).flat();
}

export async function recordFile(file) {
  const name = basename(file);
  if (!assetName.test(name)) throw new Error(`Unsupported release asset name: ${name}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size === 0) throw new Error(`Empty release asset: ${name}`);
  return { name, size, digest: `sha256:${hash.digest('hex')}` };
}

const sameAsset = (asset, expected) =>
  asset.name === expected.name &&
  asset.state === 'uploaded' &&
  asset.size === expected.size &&
  asset.digest === expected.digest;
const incompleteStarter = (asset) => asset.state === 'starter' && asset.size === 0 && asset.digest == null;

export function verifyAssets(actual, expected, names) {
  const expectedNames = expected.map((asset) => asset.name);
  const exactNames = (left, right) =>
    left.length === new Set(left).size && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  if (
    !names.length ||
    !exactNames(expectedNames, names) ||
    !exactNames(
      actual.map((asset) => asset.name),
      names
    )
  ) {
    throw new Error('Verified records and remote assets must both cover the exact release asset set');
  }
  for (const record of expected) {
    if (
      !Number.isSafeInteger(record.size) ||
      record.size <= 0 ||
      !sha256.test(record.digest ?? '') ||
      !sameAsset(
        actual.find((asset) => asset.name === record.name),
        record
      )
    ) {
      throw new Error(`Release asset differs from the verified bytes: ${record.name}`);
    }
  }
}

// No idle-speed limit: GitHub sends nothing while it finalizes a fully received asset, over 20 s for ~1 GB.
export async function postAsset(file, url) {
  const { stdout } = await curl('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--http1.1',
    '--connect-timeout',
    '20',
    '--max-time',
    '150',
    '--header',
    `Authorization: Bearer ${GH_TOKEN}`,
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    'Content-Type: application/octet-stream',
    '--header',
    'Expect:',
    '--data-binary',
    `@${file}`,
    url,
  ]);
  return stdout;
}

/** Throws unless the public release's `assets` hold every one of `expected` as its bytes. */
export function requirePublished(assets, expected) {
  const absent = expected.filter((record) => !assets.some((asset) => sameAsset(asset, record)));
  if (absent.length) {
    throw new Error(
      `${tag} is public without ${absent.map(({ name }) => name).join(', ')} as these bytes, and a public release is never changed`
    );
  }
}

export async function uploadAssets(files) {
  if (!files.length) throw new Error('Expected files to upload');
  const expected = await Promise.all(files.map(recordFile));
  if (new Set(expected.map(({ name }) => name)).size !== expected.length) throw new Error('Duplicate local asset name');
  const release = readRelease(null);
  // A re-run after this run published the release finds every asset already there, as these bytes.
  if (!release.draft) {
    requirePublished(readAssets(), expected);
    return expected;
  }
  const { upload_url: template } = release;
  const uploadUrl = new URL(template.split('{')[0]);
  if (uploadUrl.origin !== 'https://uploads.github.com' || uploadUrl.pathname !== `/${releasePath()}/assets`) {
    throw new Error('Invalid release upload URL');
  }
  const upload = async (file, record) => {
    const { name } = record;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const occupants = readAssets().filter((asset) => asset.name === name);
      if (occupants.length > 1) throw new Error(`Multiple assets occupy ${name}`);
      const [existing] = occupants;
      if (existing && sameAsset(existing, record)) return;
      if (existing) {
        // A failed upload can leave a zero-byte GitHub "starter" record.
        if (!incompleteStarter(existing)) {
          throw new Error(`Draft asset name ${name} is occupied by different or unverified bytes`);
        }
        readRelease(true);
        const current = readAssets().filter((asset) => asset.name === name);
        if (current.length === 1 && sameAsset(current[0], record)) return;
        if (current.length !== 1 || current[0].id !== existing.id || !incompleteStarter(current[0])) {
          throw new Error(`Draft asset ${name} changed before starter cleanup`);
        }
        gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${existing.id}`]);
      }
      readRelease(true);
      const url = new URL(uploadUrl);
      url.searchParams.set('name', name);
      let stdout;
      try {
        stdout = await postAsset(file, url.href);
      } catch (error) {
        const after = readAssets().filter((asset) => asset.name === name);
        if (after.length === 1 && sameAsset(after[0], record)) return;
        if (attempt === 1 && (after.length === 0 || (after.length === 1 && incompleteStarter(after[0])))) continue;
        // error.message repeats the curl command line, which holds the token.
        throw new Error(
          `Upload of ${name} did not produce the verified bytes: ${String(error.stderr ?? error.code).trim()}`
        );
      }
      if (!sameAsset(JSON.parse(stdout), record)) throw new Error(`Upload response does not match ${name}`);
      return;
    }
  };
  const results = await Promise.allSettled(files.map((file, i) => upload(file, expected[i])));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map(({ reason }) => reason),
      'Draft asset upload failed'
    );
  return expected;
}

/** The server bundles: assets of the release the desktop fetches when an ssh install needs one. */
export const SERVER_BUNDLE_ASSET_NAMES = Object.freeze(Object.keys(SERVER_PLATFORM_TARGETS).map(serverBundleAsset));

export const DESKTOP_ASSET_NAMES = Object.freeze([
  'latest.yml',
  'mixdog-desktop-win-x64.exe',
  'mixdog-desktop-win-x64.exe.blockmap',
  'latest-mac.yml',
  ...['arm64', 'x64'].flatMap((arch) =>
    ['dmg', 'zip', 'zip.blockmap'].map((ext) => `mixdog-desktop-mac-${arch}.${ext}`)
  ),
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'mixdog-desktop-linux-arm64.AppImage',
  'mixdog-desktop-linux-arm64.deb',
  'mixdog-desktop-linux-x86_64.AppImage',
  'mixdog-desktop-linux-amd64.deb',
  ...SERVER_BUNDLE_ASSET_NAMES,
  ...PLATFORMS.map(({ key }) => runtimeAssetName(key)),
]);

/** The records the draft's server bundles must match: the length and sha256 the manifest every installer of `version`
 *  carries lists for each, which is the only description of them a desktop trusts. */
export function serverBundleRecords(manifest, version) {
  const problems = serverManifestProblems(manifest, { version });
  if (problems.length) throw new Error(`The server manifest is not one of release ${version}:\n- ${problems.join('\n- ')}`);
  return Object.values(manifest.binaries).map(({ bundle }) => ({
    name: bundle.asset,
    size: bundle.size,
    digest: `sha256:${bundle.sha256}`,
  }));
}

const desktopRecords = () => [
  ...[
    'WINDOWS_ASSETS',
    'MAC_ARM64_ASSETS',
    'MAC_X64_ASSETS',
    'LINUX_ARM64_ASSETS',
    'LINUX_X64_ASSETS',
    'MERGED_FEED',
    // The runtime archives the npm package names (scripts/ci/publish-npm.mjs upload-runtime).
    'NPM_RUNTIME_ASSETS',
  ].flatMap((key) => JSON.parse(process.env[key])),
  ...serverBundleRecords(JSON.parse(process.env.SERVER_BUNDLES_MANIFEST || 'null'), tag?.replace(/^v/, '')),
];

function verifyDesktop() {
  readRelease(null);
  const assets = readAssets();
  verifyAssets(assets, desktopRecords(), DESKTOP_ASSET_NAMES);
  for (const name of ['latest-linux.yml', 'latest-linux-arm64.yml']) {
    const { id: feedId } = assets.find((asset) => asset.name === name);
    const feed = gh(['api', `repos/${repo}/releases/assets/${feedId}`, '-H', 'Accept: application/octet-stream']);
    const referenced = [...feed.matchAll(/^\s*(?:-\s+)?(?:url|path):\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
    if (
      referenced.some((file) => !DESKTOP_ASSET_NAMES.includes(file)) ||
      ['.AppImage', '.deb'].some((ext) => !referenced.some((file) => file.endsWith(ext)))
    ) {
      throw new Error(`${name} must reference draft assets including both an AppImage and a .deb`);
    }
  }
}

export function publishDraft({ expected, names, latest, notes }) {
  const id = releaseId();
  const release = readRelease(null);
  verifyAssets(readAssets(), expected, names);
  // An earlier attempt of the run published it, with exactly these assets.
  if (!release.draft) return;
  const result = api(releasePath(), [
    '--method',
    'PATCH',
    '-F',
    'draft=false',
    '-f',
    `make_latest=${latest}`,
    ...(notes ? ['-F', `body=@${notes}`] : []),
  ]);
  if (String(result.id) !== id || result.draft !== false || result.tag_name !== tag) {
    throw new Error(`Finalization did not publish ${tag} (release ${id})`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'upload' || command === 'record') {
    const records = command === 'upload' ? await uploadAssets(args) : await Promise.all(args.map(recordFile));
    appendFileSync(process.env.GITHUB_OUTPUT, `assets=${JSON.stringify(records)}\n`);
  } else if (command === 'verify-desktop') {
    verifyDesktop();
  } else if (command === 'publish-desktop') {
    // Re-read immediately before the visibility change.
    publishDraft({ expected: desktopRecords(), names: DESKTOP_ASSET_NAMES, latest: true, notes: args[0] });
  } else {
    throw new Error(`Unknown release asset command: ${command}`);
  }
}
