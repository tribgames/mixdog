#!/usr/bin/env node
// Leaves a cargo target directory holding only what a later run can reuse: the compiled third-party dependencies.
//
// The cached target directory is restored before a build and saved after one that missed (release-gate.yml). The workspace's own
// crates and every test and binary executable are rebuilt by every run (a checkout's file times are new, so cargo rebuilds a
// path package whatever is cached) and are by far the larger part of the directory, so they are removed before it is saved:
// the entry stays the size of the dependencies (a few GB uncompressed for the 941 packages of Cargo.lock) and does not grow with
// the tests.
//
// Removed under <target>/<profile>:
//   deps/        every file of a workspace package (`libmixdog_core-<hash>.rlib`, `.rmeta`, `.d`), and every executable
//                (a test binary, a binary of the workspace: a file with no extension, or `.exe` with its `.pdb`)
//   .fingerprint/ and build/   the directories of a workspace package (`mixdog-core-<hash>`)
//   incremental/, examples/, and the profile's top-level executables
// and <target>/nextest. A removed unit is simply built again; a kept one is a dependency that a rebuild would repeat.
//
// Usage: node scripts/ci/prune-core-target.mjs --target <dir> --profile debug|release
//          (--packages "<name> <name> ..." | --manifest-path <native/core/Cargo.toml>: the workspace's members from cargo metadata)
import { execFileSync } from 'node:child_process';
import { readdirSync, lstatSync, realpathSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

const HASH = /-[0-9a-f]{16}$/;

const underscored = (name) => name.replaceAll('-', '_');
export const packageNames = (value) => value.split(/\s+/).filter(Boolean);

// Refuse links/junctions at every level, including ancestors of the target. A
// deletion plan is fully inspected before its first mutation, and directories
// are removed empty, never through a recursive remover that might follow a link.
function checked(path, root) {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error(`cache path escapes verified root: ${absolute}`);
  let cursor = parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`cache link or junction refused: ${cursor}`);
  }
  if (realpathSync(absolute) !== absolute) throw new Error(`cache path is not canonical: ${absolute}`);
  return lstatSync(absolute);
}
function deletionPlan(path, root, out = []) {
  const stat = checked(path, root);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) deletionPlan(join(path, entry), root, out);
  else if (!stat.isFile()) throw new Error(`unsupported cache entry: ${path}`);
  out.push({ path, directory: stat.isDirectory(), bytes: stat.isFile() ? stat.size : 0 });
  return out;
}

export function pruneTarget({ target, profile, packages, cacheRoot }) {
  if (!['debug', 'release'].includes(profile)) throw new Error('profile must be debug or release');
  if (!cacheRoot || resolve(cacheRoot) !== resolve(target) || resolve(target) === parse(resolve(target)).root)
    throw new Error('target must equal the explicitly verified CI cache root');
  target = resolve(target);
  checked(target, target);
  return deletePlans(planPrune(target, profile, packages), target);
}

function planPrune(target, profile, packages) {
  const plans = [];
  const planned = new Set();
  const remove = (path) => {
    if (!planned.has(path)) {
      planned.add(path);
      plans.push(deletionPlan(path, target));
    }
  };
  const names = new Set(packages.map(underscored));
  const dir = join(target, profile);
  const list = (path) => {
    try {
      checked(path, target);
      return readdirSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  };

  const executables = new Set();
  for (const entry of list(join(dir, 'deps'))) {
    const dot = entry.lastIndexOf('.');
    const extension = dot > 0 ? entry.slice(dot) : '';
    const stem = (dot > 0 ? entry.slice(0, dot) : entry).replace(/^lib/, '');
    if (extension === '.exe' || extension === '') {
      executables.add(entry.slice(0, dot > 0 ? dot : undefined));
      remove(join(dir, 'deps', entry));
    } else if (
      names.has(underscored(stem.replace(HASH, ''))) ||
      names.has(underscored(entry.slice(0, dot).replace(HASH, '')))
    ) {
      remove(join(dir, 'deps', entry));
    }
  }
  // The debug information of an executable that was removed (Windows).
  for (const entry of list(join(dir, 'deps'))) {
    if (entry.endsWith('.pdb') && executables.has(entry.slice(0, -4))) remove(join(dir, 'deps', entry));
  }
  for (const kind of ['.fingerprint', 'build']) {
    for (const entry of list(join(dir, kind))) {
      if (names.has(underscored(entry.replace(HASH, '')))) remove(join(dir, kind, entry));
    }
  }
  for (const entry of ['incremental', 'examples']) {
    if (list(dir).includes(entry)) remove(join(dir, entry));
  }
  for (const entry of list(dir)) {
    if (entry.endsWith('.exe') || entry.endsWith('.pdb') || entry.endsWith('.d')) remove(join(dir, entry));
    else if (checked(join(dir, entry), target).isFile() && !entry.includes('.')) remove(join(dir, entry));
  }
  if (list(target).includes('nextest')) remove(join(target, 'nextest'));
  return plans;
}

function deletePlans(plans, target) {
  const removed = { bytes: 0, entries: plans.length };
  for (const plan of plans)
    for (const entry of plan) {
      checked(entry.path, target);
      if (entry.directory) rmdirSync(entry.path);
      else unlinkSync(entry.path);
      removed.bytes += entry.bytes;
    }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
  );
  if (!args.target || !args.profile || !(args.packages || args['manifest-path']))
    throw new Error(
      'usage: --target <dir> --profile <debug|release> (--packages "<names>" | --manifest-path <Cargo.toml>)'
    );
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_WORKSPACE)
    throw new Error('cache pruning is restricted to GitHub Actions workspaces');
  const cacheRoot = resolve(process.env.GITHUB_WORKSPACE, 'native/core/target');
  if (resolve(args.target) !== cacheRoot) throw new Error('only this CI checkout target may be pruned');
  const packages = args.packages
    ? packageNames(args.packages)
    : JSON.parse(
        execFileSync(
          'cargo',
          [
            'metadata',
            '--locked',
            '--offline',
            '--no-deps',
            '--format-version',
            '1',
            '--manifest-path',
            resolve(args['manifest-path']),
          ],
          {
            cwd: resolve(args['manifest-path'], '..'),
            encoding: 'utf8',
            maxBuffer: 1 << 28,
          }
        )
      ).packages.map((pkg) => pkg.name);
  const removed = pruneTarget({ target: args.target, profile: args.profile, packages, cacheRoot });
  console.log(
    `[prune-core-target] removed ${removed.entries} entries, ${(removed.bytes / 1048576).toFixed(0)} MiB, from ${args.target}/${args.profile}`
  );
}
