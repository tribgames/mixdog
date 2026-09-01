#!/usr/bin/env node
// Single source of truth for CI/CD path selection.
//
// Consumers:
//   - .github/workflows/release-gate.yml  → `node scripts/release-paths.mjs desktop-regex|runtime-regex`
//     (grep -E patterns selecting which incremental gates a change requires)
//   - .github/workflows/deploy.yml        → `import { RELEASE_CRITICAL_PATHS }`
//     (git diff paths whose change invalidates the previous release's
//     critical verification)
//
// Adding or renaming a release-relevant script means editing THIS file only;
// the workflows derive their patterns from it at run time.

export const PACKAGE_MANIFESTS = ['package.json', 'package-lock.json'];

// This module governs gate selection itself, so changing it must re-run
// every gate it feeds.
const GATE_SELECTION_SOURCES = ['scripts/release-paths.mjs'];

// Prefixes whose changes require the desktop bundle gate.
export const DESKTOP_GATE_PREFIXES = ['apps/desktop/', 'src/', 'vendor/', 'LICENSES/'];
export const DESKTOP_GATE_FILES = ['README.md', 'NOTICE.md', ...PACKAGE_MANIFESTS];
// Desktop packaging/postinstall scripts; `.test` companions ride along.
export const DESKTOP_GATE_SCRIPT_BASES = [
  'scripts/prune-embedding-runtime',
  'scripts/native-binary-arch',
  'scripts/native-tool-download',
  'scripts/runtime-dependency-cache-key',
];

// Prefixes whose changes require the runtime gate (the release-critical lane
// plus the tool-contract suites the gate also executes).
export const RUNTIME_GATE_PREFIXES = [
  '.github/workflows/',
  'native/',
  'scripts/tool-contracts/',
  'src/runtime/agent/orchestrator/',
  'src/runtime/shared/',
];

// Everything `npm run test:release-critical` executes
// (test:release-assets + smoke:patch + test:providers).
export const RELEASE_CRITICAL_SCRIPTS = [
  'scripts/verify-release-assets.mjs',
  'scripts/release-gate-test.mjs',
  'scripts/prepare-native-assets.mjs',
  'scripts/prepare-native-assets-test.mjs',
  'scripts/generate-voice-runtime-manifest.mjs',
  'scripts/generate-voice-runtime-manifest.test.mjs',
  'scripts/apply-patch-edit-smoke.mjs',
  'scripts/provider-contract-test.mjs',
  'scripts/provider-stream-outcome-test.mjs',
  'scripts/cursor-provider-test.mjs',
];

// Directory-shaped suites the critical lane executes (test:providers runs
// scripts/provider-toolcall/*.test.mjs): deploy consumes these as git
// pathspecs, the gate regex as path prefixes.
export const RELEASE_CRITICAL_SUITE_DIRS = ['scripts/provider-toolcall'];

// Gate-only suite files the runtime job executes beyond the critical lane
// (test:compact); editing one must re-run the gate that executes it.
export const RUNTIME_GATE_SUITE_FILES = ['scripts/suite-compact-test.mjs'];

// deploy.yml plan: paths whose change since the published release tag marks
// the critical lane as unverified.
export const RELEASE_CRITICAL_PATHS = [
  'native',
  'src/runtime/agent/orchestrator',
  'src/runtime/shared',
  ...RELEASE_CRITICAL_SCRIPTS,
  ...RELEASE_CRITICAL_SUITE_DIRS,
  ...PACKAGE_MANIFESTS,
];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function desktopGateRegex() {
  return `^(${[
    ...DESKTOP_GATE_PREFIXES.map(escapeRegex),
    ...DESKTOP_GATE_FILES.map((file) => `${escapeRegex(file)}$`),
    ...DESKTOP_GATE_SCRIPT_BASES.map((base) => `${escapeRegex(base)}(\\.test)?\\.mjs$`),
    ...GATE_SELECTION_SOURCES.map((file) => `${escapeRegex(file)}$`),
  ].join('|')})`;
}

export function runtimeGateRegex() {
  return `^(${[
    ...RUNTIME_GATE_PREFIXES.map(escapeRegex),
    ...RELEASE_CRITICAL_SCRIPTS.map((file) => `${escapeRegex(file)}$`),
    ...RELEASE_CRITICAL_SUITE_DIRS.map((dir) => `${escapeRegex(dir)}/`),
    ...RUNTIME_GATE_SUITE_FILES.map((file) => `${escapeRegex(file)}$`),
    ...DESKTOP_GATE_SCRIPT_BASES.map((base) => `${escapeRegex(base)}(\\.test)?\\.mjs$`),
    ...PACKAGE_MANIFESTS.map((file) => `${escapeRegex(file)}$`),
    ...GATE_SELECTION_SOURCES.map((file) => `${escapeRegex(file)}$`),
  ].join('|')})`;
}

const mode = process.argv[2];
if (mode) {
  if (mode === 'desktop-regex') process.stdout.write(`${desktopGateRegex()}\n`);
  else if (mode === 'runtime-regex') process.stdout.write(`${runtimeGateRegex()}\n`);
  else if (mode === 'critical-paths') process.stdout.write(`${RELEASE_CRITICAL_PATHS.join('\n')}\n`);
  else {
    process.stderr.write(`unknown mode: ${mode} (expected desktop-regex|runtime-regex|critical-paths)\n`);
    process.exit(1);
  }
}
