#!/usr/bin/env node
// Single source of truth for CI/CD path selection.
//
// Consumers:
//   - .github/workflows/release-gate.yml  → `node scripts/release-paths.mjs desktop-regex|runtime-regex|patch-regex|history-regex|mobile-regex`
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
  'scripts/prune-desktop-runtime',
  'scripts/prune-embedding-runtime',
  'scripts/native-binary-arch',
  'scripts/native-tool-download',
  'scripts/runtime-dependency-cache-key',
];

// Prefixes whose changes require the runtime gate. The gate runs the
// discovered default lane (scripts/test.mjs: every test file under src/ and
// scripts/), so any change under those roots is a candidate.
export const RUNTIME_GATE_PREFIXES = ['.github/workflows/', 'native/', 'scripts/', 'src/'];

// Native patch changes must be tested from the checkout, not the published binary.
const PATCH_GATE_PREFIXES = ['native/mixdog-patch/', 'src/runtime/agent/orchestrator/tools/patch/'];
const PATCH_GATE_FILES = [
  '.github/workflows/release-gate.yml',
  'src/runtime/agent/orchestrator/tools/patch.mjs',
  'src/runtime/agent/orchestrator/tools/patch-binary-fetcher.mjs',
  'scripts/apply-patch-edit-smoke.mjs',
  'scripts/native-edit-wire-test.mjs',
  'scripts/release-gate-test.mjs',
  ...PACKAGE_MANIFESTS,
  ...GATE_SELECTION_SOURCES,
];

// The shipped-definition history is generated from git history of the agent,
// workflow, output-style and bundled-skill trees (scripts/build-shipped-history.mjs)
// and committed under src/defaults/. Release re-checks it, so the gate checks
// it first instead of letting a stale file fail the deploy late.
const HISTORY_GATE_PREFIXES = ['src/agents/', 'src/workflows/', 'src/output-styles/', 'src/defaults/'];
const HISTORY_GATE_FILES = [
  'scripts/build-shipped-history.mjs',
  'src/runtime/shared/shipped-definitions.mjs',
  '.github/workflows/release-gate.yml',
  ...GATE_SELECTION_SOURCES,
];

// The mobile release scripts (Python) carry unittest suites that no Node lane
// discovers; they run when those scripts or the mobile workflows change.
const MOBILE_GATE_PREFIXES = ['apps/mobile/scripts/'];
const MOBILE_WORKFLOW_PATTERN = '\\.github/workflows/mobile-[^/]*\\.yml$';
const MOBILE_GATE_FILES = ['.github/workflows/release-gate.yml', ...GATE_SELECTION_SOURCES];

// deploy.yml plan: paths whose change since the published release tag marks
// the default lane as unverified.
export const RELEASE_CRITICAL_PATHS = ['native', 'scripts', 'src', ...PACKAGE_MANIFESTS];

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
    ...PACKAGE_MANIFESTS.map((file) => `${escapeRegex(file)}$`),
    ...GATE_SELECTION_SOURCES.map((file) => `${escapeRegex(file)}$`),
  ].join('|')})`;
}

export function patchGateRegex() {
  return `^(${[
    ...PATCH_GATE_PREFIXES.map(escapeRegex),
    ...PATCH_GATE_FILES.map((file) => `${escapeRegex(file)}$`),
  ].join('|')})`;
}

export function historyGateRegex() {
  return `^(${[
    ...HISTORY_GATE_PREFIXES.map(escapeRegex),
    ...HISTORY_GATE_FILES.map((file) => `${escapeRegex(file)}$`),
  ].join('|')})`;
}

export function mobileGateRegex() {
  return `^(${[
    ...MOBILE_GATE_PREFIXES.map(escapeRegex),
    ...MOBILE_GATE_FILES.map((file) => `${escapeRegex(file)}$`),
    MOBILE_WORKFLOW_PATTERN,
  ].join('|')})`;
}

const mode = process.argv[2];
if (mode) {
  if (mode === 'desktop-regex') process.stdout.write(`${desktopGateRegex()}\n`);
  else if (mode === 'runtime-regex') process.stdout.write(`${runtimeGateRegex()}\n`);
  else if (mode === 'patch-regex') process.stdout.write(`${patchGateRegex()}\n`);
  else if (mode === 'history-regex') process.stdout.write(`${historyGateRegex()}\n`);
  else if (mode === 'mobile-regex') process.stdout.write(`${mobileGateRegex()}\n`);
  else if (mode === 'critical-paths') process.stdout.write(`${RELEASE_CRITICAL_PATHS.join('\n')}\n`);
  else {
    process.stderr.write(
      `unknown mode: ${mode} (expected desktop-regex|runtime-regex|patch-regex|history-regex|mobile-regex|critical-paths)\n`
    );
    process.exit(1);
  }
}
