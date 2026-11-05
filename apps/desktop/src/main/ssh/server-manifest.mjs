// The server runtime manifest (`servers.json`) shared by the staging script
// (scripts/stage-core.mjs) that writes it and the ssh install that reads it:
// one definition of what the release's `build` is.
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
