// The platforms the npm distribution of mixdog has a native runtime for, in one place: the staging of the runtime
// archives, the package check, the publication and their tests read it; bin/native-layout.mjs restates the keys the
// launcher selects (it ships alone) and a test holds the two together.
//
// The npm package carries no program. Each platform's programs are one archive, `mixdog-runtime-<key>.tar.gz`, an asset
// of the GitHub release of the version; the package carries bin/runtime-manifest.json, which names each archive with its
// length, SHA-256, version and build, and the launcher fetches and verifies the one of its machine (bin/runtime.mjs).
//
// win32-arm64 has no program of its own: Windows on Arm runs the x64 program (the same rule as
// src/runtime/shared/native-asset.mjs `platformKeyCandidates`), so the launcher selects win32-x64 there. A native
// Windows Arm leg is one more row here and one in .github/workflows/mixdogd-build.yml.

/** Rust target triple each platform's programs are built for in mixdogd-build.yml. */
export const PLATFORMS = Object.freeze([
  { key: 'win32-x64', platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' },
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin' },
  { key: 'darwin-x64', platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin' },
  { key: 'linux-x64', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-gnu' },
  { key: 'linux-arm64', platform: 'linux', arch: 'arm64', target: 'aarch64-unknown-linux-gnu' },
]);

export const platformOf = (key) => {
  const found = PLATFORMS.find((entry) => entry.key === key);
  if (!found) throw new Error(`no npm platform ${key}; known: ${PLATFORMS.map((entry) => entry.key).join(', ')}`);
  return found;
};

/** The programs of a runtime, beside each other (the core looks for mixdog-askpass and the templates beside mixdogd). */
export const NATIVE_PROGRAMS = Object.freeze(['mixdog', 'mixdogd', 'mixdog-askpass']);

export const programFile = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);

/** The release asset that holds the runtime of platform `key`. */
export const runtimeAssetName = (key) => `mixdog-runtime-${platformOf(key).key}.tar.gz`;
