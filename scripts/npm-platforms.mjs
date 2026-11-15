// The platforms the npm distribution of mixdog carries a native program for, in one place: the staging script, the
// package check and their tests read it; bin/mixdog.mjs restates the names it resolves (it ships alone) and a test
// holds the two together.
//
// One small package per platform (`mixdog-<platform>-<arch>`, `os` and `cpu` set so npm installs only the one that
// fits the machine) is listed as an optional dependency of `mixdog`, at the same version. These names are not in a
// scope the repository publishes under (its only published package, `mixdog`, has none): the owner of the npm account
// must own `mixdog-darwin-arm64`, `mixdog-darwin-x64`, `mixdog-linux-arm64`, `mixdog-linux-x64` and `mixdog-win32-x64`.
//
// win32-arm64 has no program of its own: Windows on Arm runs the x64 program (the same rule as
// src/runtime/shared/native-asset.mjs `platformKeyCandidates`), so `mixdog-win32-x64` also installs there (`cpu` lists
// arm64) and the launcher resolves win32-arm64 to it. A native Windows Arm leg is one more row here and one in
// .github/workflows/mixdogd-build.yml.

/** Rust target triple each platform's programs are built for in mixdogd-build.yml. */
export const PLATFORMS = Object.freeze([
  { key: 'win32-x64', platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc', cpu: ['x64', 'arm64'] },
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin', cpu: ['arm64'] },
  { key: 'darwin-x64', platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin', cpu: ['x64'] },
  { key: 'linux-x64', platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-gnu', cpu: ['x64'] },
  { key: 'linux-arm64', platform: 'linux', arch: 'arm64', target: 'aarch64-unknown-linux-gnu', cpu: ['arm64'] },
]);

export const platformPackageName = (key) => `mixdog-${key}`;

export const platformOf = (key) => {
  const found = PLATFORMS.find((entry) => entry.key === key);
  if (!found) throw new Error(`no npm platform ${key}; known: ${PLATFORMS.map((entry) => entry.key).join(', ')}`);
  return found;
};

/** The programs a platform package carries beside each other (the core looks for mixdog-askpass and the templates beside mixdogd). */
export const NATIVE_PROGRAMS = Object.freeze(['mixdog', 'mixdogd', 'mixdog-askpass']);

export const programFile = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);
