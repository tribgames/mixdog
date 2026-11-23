#!/usr/bin/env node
// The workspace build cache of core-build (release-gate.yml): the whole build folder (target, and the registry and git
// checkouts of the third-party sources) of an earlier build, so that cargo rebuilds only what a change reaches.
//
// cargo decides freshness by modification time: a unit is fresh when no input is newer than its output. A checkout gives
// every file the time of the checkout, newer than any restored output, so every workspace crate would rebuild. `stamp` gives
// each tracked file and directory a time decided by its content instead: the time recorded with it in the restored entry when
// its content (the bytes in the working tree, or for a directory its tracked listing) is the one recorded, and otherwise T, a whole second later
// than every file of the restored entry. A recorded time is the T of the run in which that content first appeared, and every
// later run of the entry's line had the same content (another content replaces the record), so an output older than the
// recorded time is older than that content and stays stale, and an output newer than it was built from it. A changed,
// added or renamed file or directory is newer than every restored output. The registry's sources are immutable per version.
//
//   check  verifies a restored entry against its own list of files and sizes (a partial or failed restore, or a miss, removes
//          the folders instead: the build then starts from the dependency cache, as without this cache); prints warm=
//   stamp  sets the times; every run stamps, so what is saved always carries a record of the times this run set
//   seal   writes the list of files of the entry; prints save=false when the tracked sources changed during the build
//
// Usage: node scripts/ci/core-target-cache.mjs check --root <repo> --paths <target> <registry> <git> [--restored <key>]
//        node scripts/ci/core-target-cache.mjs stamp --root <repo> --target <target> [--warm true]
//        node scripts/ci/core-target-cache.mjs seal  --root <repo> --paths <target> <registry> <git>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATE = '.mixdog-cache';
const TIMES = 'mtimes.json';
const FILES = 'files.tsv';

const git = (root, args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30 }).toString('utf8');

// The bytes a build reads, not the index blob: .gitattributes (eol, filters) decides what a checkout writes for one blob.
function contentKey(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  return `${stat.mode & 0o111 ? 'x' : '-'}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

// Every tracked file (key: its working-tree bytes and executable bit, or a link's target) and every directory holding one
// (key: its tracked entries), by repository path; the repository's own directory is ''.
export function trackedEntries(root) {
  const entries = new Map();
  const children = new Map();
  for (const record of git(root, ['ls-files', '-s', '-z']).split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const mode = record.slice(0, tab).split(' ')[0];
    const path = record.slice(tab + 1);
    if (mode === '160000') continue;
    entries.set(path, contentKey(join(root, path)));
    let child = path;
    while (child !== '') {
      const slash = child.lastIndexOf('/');
      const parent = slash < 0 ? '' : child.slice(0, slash);
      if (!children.has(parent)) children.set(parent, new Set());
      const names = children.get(parent);
      const name = child.slice(slash + 1);
      if (names.has(name)) break;
      names.add(name);
      child = parent;
    }
  }
  for (const [dir, names] of children)
    entries.set(dir, `dir:${createHash('sha256').update([...names].sort().join('\n')).digest('hex')}`);
  return entries;
}

function walk(dir, visit) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const path = join(dir, name);
    const stat = lstatSync(path, { bigint: true });
    visit(path, stat);
    if (stat.isDirectory()) walk(path, visit);
  }
}

// The newest modification time of a build file under a folder, in whole seconds rounded up. Files only: cargo compares the
// times of its outputs and dep-info files, and an extraction may leave a directory at the time it ran.
export function newestSecond(dir) {
  let newest = 0n;
  const state = join(dir, STATE);
  walk(dir, (path, stat) => {
    if (stat.isFile() && stat.mtimeNs > newest && !path.startsWith(state)) newest = stat.mtimeNs;
  });
  return Number((newest + 999_999_999n) / 1_000_000_000n);
}

export function stamp({ root, target, warm, now = Math.floor(Date.now() / 1000) }) {
  root = resolve(root);
  target = resolve(target);
  const record = join(target, STATE, TIMES);
  const previous = warm && existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {};
  const restored = newestSecond(target);
  const fresh = restored > 0 ? restored + 1 : now;
  const times = {};
  let kept = 0;
  const entries = trackedEntries(root);
  // Deepest first: a directory's time is set after every entry in it.
  for (const path of [...entries.keys()].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const key = entries.get(path);
    const time = previous[path]?.[0] === key ? previous[path][1] : fresh;
    if (time !== fresh) kept++;
    lutimesSync(join(root, path), time, time);
    times[path] = [key, time];
  }
  mkdirSync(join(target, STATE), { recursive: true });
  writeFileSync(record, JSON.stringify(times));
  return { kept, changed: entries.size - kept, fresh };
}

function listFiles(paths) {
  const lines = [];
  paths.forEach((base, index) =>
    walk(base, (path, stat) => {
      const rel = path.slice(base.length + 1).replaceAll('\\', '/');
      if (index === 0 && (rel === STATE || rel.startsWith(`${STATE}/`))) return;
      if (stat.isFile()) lines.push(`${index}\t${stat.size}\t${rel}`);
    })
  );
  return lines;
}

export function seal({ root, paths }) {
  paths = paths.map((path) => resolve(path));
  if (git(resolve(root), ['status', '--porcelain', '--untracked-files=no']).trim() !== '') return false;
  mkdirSync(join(paths[0], STATE), { recursive: true });
  writeFileSync(join(paths[0], STATE, FILES), `${listFiles(paths).join('\n')}\n`);
  return true;
}

export function verify(paths) {
  paths = paths.map((path) => resolve(path));
  const list = join(paths[0], STATE, FILES);
  if (!existsSync(list) || !existsSync(join(paths[0], STATE, TIMES))) return false;
  for (const line of readFileSync(list, 'utf8').split('\n')) {
    if (!line) continue;
    const [index, size, rel] = line.split('\t');
    let stat;
    try {
      stat = lstatSync(join(paths[Number(index)], rel));
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size !== Number(size)) return false;
  }
  return true;
}

export function check({ paths, restored }) {
  if (restored && verify(paths)) return true;
  for (const path of paths) rmSync(resolve(path), { recursive: true, force: true });
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const name = rest[i].slice(2);
    const values = [];
    while (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) values.push(rest[++i]);
    args[name] = values;
  }
  const one = (name) => args[name]?.[0] ?? '';
  const output = (line) => {
    console.log(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  };
  if (command === 'check') {
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('check removes the build folders: GitHub Actions only');
    output(`warm=${check({ paths: args.paths, restored: one('restored') !== '' })}`);
  } else if (command === 'stamp') {
    const { kept, changed, fresh } = stamp({ root: one('root'), target: one('target'), warm: one('warm') === 'true' });
    console.log(`[core-target-cache] ${kept} tracked entries keep their recorded time, ${changed} take ${fresh}`);
  } else if (command === 'seal') {
    const sealed = seal({ root: one('root'), paths: args.paths });
    if (!sealed) console.log('::warning title=core-target-cache::the tracked sources changed during the build; the build folder is not saved');
    output(`save=${sealed}`);
  } else {
    throw new Error('usage: core-target-cache.mjs check|stamp|seal (see the header)');
  }
}
