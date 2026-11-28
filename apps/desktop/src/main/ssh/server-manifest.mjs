// The server runtime manifest (`servers.json`) shared by the staging script
// (scripts/stage-core.mjs) that writes it, the checks of the package and the
// release that read it, and the ssh install (mixdog-ssh install_payload.rs):
// one definition of what the release's `build` is and of what each bundle,
// a release asset the app fetches when an install needs it, must be.
import { createHash } from 'node:crypto';

export const SERVER_MANIFEST_FILE = 'servers.json';

/** Server platforms a desktop ships `mixdogd` for (LR §8.1) and the Rust
 *  target each is built for: Linux x64/arm64 on glibc, macOS x64/arm64. */
export const SERVER_PLATFORM_TARGETS = Object.freeze({
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
});

/** Every platform `mixdogd` is built for (the servers above plus Windows,
 *  where only a desktop or a terminal runs it) and the Rust target of each. */
export const CORE_PLATFORM_TARGETS = Object.freeze({
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  ...SERVER_PLATFORM_TARGETS,
});

/** The build every platform's upload of one release shares: a digest of the
 *  per-platform digests (the binary's and the content of its bundle, which
 *  carries the JS runtime), so a rebuilt binary or JS runtime of any platform
 *  is a new build, while restaging the same inputs is not. */
export function manifestBuild(binaries) {
  const lines = Object.keys(binaries)
    .sort()
    .map((key) => `${key}:${binaries[key].sha256}:${binaries[key].bundle?.content ?? ''}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex').slice(0, 16);
}

/** The name of the release asset that is the bundle of server platform `key`. */
export const serverBundleAsset = (key) => `mixdog-server-${key}.tgz`;

const SHA256 = /^[0-9a-f]{64}$/;
// mixdog-ssh `is_safe_segment`: the version and build name a folder on the server.
const segment = (value) => typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** Why `manifest` is not the manifest of a release (of `version`, when given): every server platform with its target, the
 *  binary's sha256 and size, its bundle's asset name, sha256, size and content digest, and the build of them all. [] when it is. */
export function serverManifestProblems(manifest, { version } = {}) {
  const problems = [];
  if (!segment(manifest?.version)) problems.push(`the version ${manifest?.version} is not a version`);
  else if (version !== undefined && manifest.version !== version)
    problems.push(`it is version ${manifest.version}, the release is ${version}`);
  const binaries = manifest?.binaries ?? {};
  const keys = Object.keys(binaries).sort();
  const wanted = Object.keys(SERVER_PLATFORM_TARGETS).sort();
  if (keys.join() !== wanted.join()) problems.push(`it lists ${keys.join(', ') || 'no platform'}, not ${wanted.join(', ')}`);
  for (const [key, entry] of Object.entries(binaries)) {
    const target = SERVER_PLATFORM_TARGETS[key];
    if (!target) continue;
    if (entry?.target !== target) problems.push(`${key}: the target is ${entry?.target}, not ${target}`);
    if (!SHA256.test(entry?.sha256 ?? '') || !positive(entry?.size)) problems.push(`${key}: the mixdogd sha256 or size is missing`);
    const bundle = entry?.bundle;
    if (bundle?.asset !== serverBundleAsset(key))
      problems.push(`${key}: the bundle asset is ${bundle?.asset}, not ${serverBundleAsset(key)}`);
    if (!SHA256.test(bundle?.sha256 ?? '') || !positive(bundle?.size) || !SHA256.test(bundle?.content ?? ''))
      problems.push(`${key}: the bundle's sha256, size or content digest is missing`);
  }
  if (!segment(manifest?.build) || manifestBuild(binaries) !== manifest.build)
    problems.push('the recorded build is not the build of the listed binaries');
  return problems;
}
