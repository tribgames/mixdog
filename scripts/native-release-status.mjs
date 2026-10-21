#!/usr/bin/env node
// Native tools (patch, graph, spawn) ship as their own immutable GitHub
// releases (`<kind>-v<version>`); the app pins one through
// src/runtime/agent/orchestrator/tools/<kind>-manifest.json and downloads that
// release's assets. A fix committed under native/<tool>/ therefore reaches
// users only when a new `<kind>-v*` release is published AND the manifest pin
// moves. This script answers, for every tool, "does the source differ from the
// release the app pins?" and is the single definition used by:
//   - deploy.yml plan  (refuses native=skip while a tool is unreleased)
//   - release.yml validate (fails a release that would ship an unreleased tool)
//   - the dev scripts  (warn / rebuild a stale local target/release binary)
//
//   node scripts/native-release-status.mjs            table
//   node scripts/native-release-status.mjs --json
//   node scripts/native-release-status.mjs --check    exit 1 when a tool is unreleased
//   node scripts/native-release-status.mjs --warn-dev warnings for a dev build, exit 0
//
// native/mixdog-computer, native/mixdog-browser-import and native/gnome-extension
// have no release/manifest: the desktop package builds them from source, keyed
// on a hash of that source (desktop-package.yml), so they cannot go stale.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS_DIR = 'src/runtime/agent/orchestrator/tools';

export const NATIVE_RELEASE_TOOLS = Object.freeze(
  ['patch', 'graph', 'spawn'].map((kind) =>
    Object.freeze({
      kind,
      dir: `native/mixdog-${kind}`,
      manifestPath: `${TOOLS_DIR}/${kind}-manifest.json`,
      tagPrefix: `${kind}-v`,
      binaryName: `mixdog-${kind}${process.platform === 'win32' ? '.exe' : ''}`,
    })
  )
);

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

/** Newest mtime (ms) of the files that decide a cargo build of `toolDir`. */
export function newestSourceMtime(toolDir) {
  let newest = 0;
  const consider = (path) => {
    try {
      const stat = statSync(path);
      if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* absent */
    }
  };
  for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs']) consider(join(toolDir, file));
  const src = join(toolDir, 'src');
  if (existsSync(src)) for (const entry of readdirSync(src, { recursive: true })) consider(join(src, entry));
  return newest;
}

/** The local `cargo build --release` binary the dev resolvers prefer over the
 *  pinned download, and whether the sources are newer than it. */
export function localBinaryState(tool, root = DEFAULT_ROOT) {
  const path = join(root, tool.dir, 'target', 'release', tool.binaryName);
  if (!existsSync(path)) return { path, exists: false, stale: false };
  const builtMs = statSync(path).mtimeMs;
  return { path, exists: true, builtMs, stale: newestSourceMtime(join(root, tool.dir)) > builtMs };
}

/** Release status of one tool at HEAD plus the working tree of `root`. */
export function nativeToolStatus(tool, root = DEFAULT_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, tool.manifestPath), 'utf8'));
  const version = String(manifest.version);
  const tag = `${tool.tagPrefix}${version}`;
  const tagCommit = git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  const tagMissing = tagCommit.status !== 0;
  let changedFiles = [];
  let commits = [];
  let tagDate = '';
  if (!tagMissing) {
    const diff = git(root, ['diff', '--name-only', tag, 'HEAD', '--', tool.dir]);
    if (diff.status !== 0) throw new Error(`git diff failed for ${tag}: ${diff.stderr}`);
    changedFiles = diff.stdout.split('\n').filter(Boolean);
    commits = git(root, ['log', '--format=%h %cs %s', `${tag}..HEAD`, '--', tool.dir])
      .stdout.split('\n')
      .filter(Boolean);
    tagDate = git(root, ['log', '-1', '--format=%cs', tag]).stdout.trim();
  }
  const dirtyFiles = git(root, ['status', '--porcelain', '--', tool.dir]).stdout.split('\n').filter(Boolean);
  const unreleased = tagMissing || changedFiles.length > 0 || dirtyFiles.length > 0;
  return {
    kind: tool.kind,
    version,
    tag,
    tagMissing,
    tagCommit: tagMissing ? '' : tagCommit.stdout.trim().slice(0, 9),
    tagDate,
    changedFiles,
    commits,
    dirtyFiles,
    unreleased,
    local: localBinaryState(tool, root),
  };
}

export function nativeReleaseStatuses(root = DEFAULT_ROOT, tools = NATIVE_RELEASE_TOOLS) {
  return tools.map((tool) => nativeToolStatus(tool, root));
}

/** Operator-facing explanation for every unreleased tool, or []. */
export function unreleasedProblems(statuses) {
  return statuses
    .filter((status) => status.unreleased)
    .map((status) => {
      if (status.tagMissing) {
        return `${status.kind}: the pinned release tag ${status.tag} does not exist, so the source it ships cannot be compared.`;
      }
      const what = [
        status.changedFiles.length &&
          `${status.changedFiles.length} file(s) changed since ${status.tag} (${status.changedFiles.slice(0, 3).join(', ')}${status.changedFiles.length > 3 ? ', ...' : ''})`,
        status.dirtyFiles.length && `${status.dirtyFiles.length} uncommitted file(s)`,
      ]
        .filter(Boolean)
        .join(' and ');
      return (
        `${status.kind}: ${what}, but users still get ${status.tag}. ` +
        `Publish a new ${status.kind}-v release and bump ${TOOLS_DIR}/${status.kind}-manifest.json: ` +
        `run Deploy with native=auto (or force); it bumps native/mixdog-${status.kind}/Cargo.toml, tags and syncs the manifest.`
      );
    });
}

/** Warnings for a local dev build, which ships the pinned download rather than the working tree. */
export function devWarnings(statuses) {
  const warnings = [];
  for (const status of statuses) {
    if (status.unreleased && !status.tagMissing) {
      warnings.push(
        `native ${status.kind}: source differs from the pinned ${status.tag} ` +
          `(${status.changedFiles.length} committed, ${status.dirtyFiles.length} uncommitted file(s)). ` +
          `A packaged dev build downloads the released binary, so these changes are NOT in it until a ${status.kind}-v release is published.`
      );
    }
    if (status.local.stale) {
      warnings.push(
        `native ${status.kind}: ${status.local.path} is older than its sources and is preferred by source checkouts. ` +
          `Rebuild: cargo build --release --manifest-path native/mixdog-${status.kind}/Cargo.toml`
      );
    }
  }
  return warnings;
}

function cargoBuild(root, tool) {
  return new Promise((resolve) => {
    const child = spawn(
      'cargo',
      ['build', '--locked', '--release', '--manifest-path', join(root, tool.dir, 'Cargo.toml')],
      { stdio: 'inherit' }
    );
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
}

/** Dev launch hook: rebuild every existing-but-stale local release binary.
 *  A tool with no local binary resolves to the pinned download instead, so it
 *  is left alone. Never throws: a failed build only warns. */
export async function refreshStaleLocalBinaries({
  root = DEFAULT_ROOT,
  tools = NATIVE_RELEASE_TOOLS,
  build = cargoBuild,
  log = console.log,
} = {}) {
  const results = [];
  for (const tool of tools) {
    if (!localBinaryState(tool, root).stale) continue;
    log(`native ${tool.kind}: local target/release binary is older than its sources; rebuilding.`);
    const code = await build(root, tool);
    const stale = code !== 0 || localBinaryState(tool, root).stale;
    if (stale)
      log(`native ${tool.kind}: rebuild failed (cargo missing or build error); the stale binary stays in use.`);
    results.push({ kind: tool.kind, rebuilt: !stale });
  }
  return results;
}

function localBinState(local) {
  if (!local.exists) return 'none';
  return local.stale ? 'STALE' : 'fresh';
}

function formatTable(statuses) {
  const rows = [['tool', 'pinned tag', 'tag commit', 'tag date', 'committed', 'uncommitted', 'local bin', 'state']];
  for (const status of statuses) {
    rows.push([
      status.kind,
      status.tag,
      status.tagCommit || '(missing)',
      status.tagDate || '-',
      String(status.changedFiles.length),
      String(status.dirtyFiles.length),
      localBinState(status.local),
      status.unreleased ? 'UNRELEASED' : 'released',
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ')).join('\n');
}

async function main(argv) {
  const statuses = nativeReleaseStatuses();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(statuses, null, 2));
    return 0;
  }
  if (argv.includes('--warn-dev')) {
    // stdout on purpose: PowerShell callers treat native stderr as an error.
    for (const warning of devWarnings(statuses)) console.log(`WARNING: ${warning}`);
    return 0;
  }
  console.log(formatTable(statuses));
  const problems = unreleasedProblems(statuses);
  for (const problem of problems) console.log(`\n${problem}`);
  if (argv.includes('--check') && problems.length) {
    console.error('\nNative release check failed: native sources differ from the releases the app pins.');
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
