import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { check, seal, stamp, trackedEntries, verify } from './core-target-cache.mjs';

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A repository with a crate, and a build folder whose newest output is at second 1000.
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'core-target-cache-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('crate/src/lib.rs', 'pub fn f() {}\n');
  put('crate/data/a.txt', 'a');
  put('other/lib.rs', 'pub fn g() {}\n');
  put('.gitignore', 'target\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const commit = () => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change');
  };
  const target = join(root, 'target');
  put('target/debug/deps/libcrate.rlib', 'out');
  utimesSync(join(target, 'debug/deps/libcrate.rlib'), 1000, 1000);
  const time = (path) => statSync(join(root, path)).mtimeMs / 1000;
  return { root, target, put, commit, time };
}

// A later run's checkout: every tracked file new, the build folder restored with its times.
function checkout({ root, target }, newest) {
  for (const path of trackedEntries(root).keys()) utimesSync(join(root, path), 5000, 5000);
  utimesSync(join(target, 'debug/deps/libcrate.rlib'), newest, newest);
}

test('core-target-cache: without a record, every tracked file and directory is newer than every restored file', () => {
  const repo = repository();
  const result = stamp({ root: repo.root, target: repo.target, warm: false });
  assert.equal(result.fresh, 1001);
  for (const path of ['crate/src/lib.rs', 'crate/data', 'crate', 'other/lib.rs', '']) assert.equal(repo.time(path), 1001, path);
});

test('core-target-cache: an unchanged file keeps its recorded time, a changed, added or removed one is newer than every restored file', () => {
  const repo = repository();
  stamp({ root: repo.root, target: repo.target, warm: false });
  repo.put('crate/src/lib.rs', 'pub fn f() { /* changed */ }\n');
  repo.put('crate/data/b.txt', 'b');
  repo.commit();
  checkout(repo, 2000);
  const result = stamp({ root: repo.root, target: repo.target, warm: true });
  assert.equal(result.fresh, 2001);
  assert.equal(repo.time('other/lib.rs'), 1001);
  assert.equal(repo.time('other'), 1001);
  assert.equal(repo.time('crate/data/a.txt'), 1001);
  // the content changed, and the directory gained an entry
  for (const path of ['crate/src/lib.rs', 'crate/data/b.txt', 'crate/data']) assert.equal(repo.time(path), 2001, path);
  // the record now holds the new content with the new time: a third run keeps it
  checkout(repo, 3000);
  stamp({ root: repo.root, target: repo.target, warm: true });
  assert.equal(repo.time('crate/src/lib.rs'), 2001);
  // a file restored to an earlier content is not that content's recorded time any more
  repo.put('crate/src/lib.rs', 'pub fn f() {}\n');
  repo.commit();
  checkout(repo, 3000);
  stamp({ root: repo.root, target: repo.target, warm: true });
  assert.equal(repo.time('crate/src/lib.rs'), 3001);
});

test('core-target-cache: a record that was not restored is not read', () => {
  const repo = repository();
  stamp({ root: repo.root, target: repo.target, warm: false });
  checkout(repo, 2000);
  stamp({ root: repo.root, target: repo.target, warm: false });
  assert.equal(repo.time('other/lib.rs'), 2001);
});

test('core-target-cache: an entry is warm only when every file of its list is there at its size', () => {
  const repo = repository();
  const registry = join(repo.root, 'registry');
  mkdirSync(join(registry, 'src'), { recursive: true });
  writeFileSync(join(registry, 'src/x.rs'), 'source');
  const paths = [repo.target, registry];
  // no list (an entry saved by nothing, or a miss): cold, and the folders are removed
  assert.equal(verify(paths), false);
  stamp({ root: repo.root, target: repo.target, warm: false });
  assert.equal(seal({ root: repo.root, paths }), true);
  assert.equal(verify(paths), true);
  writeFileSync(join(registry, 'src/x.rs'), 'sou');
  assert.equal(verify(paths), false, 'a truncated file');
  writeFileSync(join(registry, 'src/x.rs'), 'source');
  rmSync(join(repo.target, 'debug/deps/libcrate.rlib'));
  assert.equal(verify(paths), false, 'a missing file');
  assert.equal(check({ paths, restored: true }), false);
  assert.ok(!existsSync(repo.target) && !existsSync(registry));
});

test('core-target-cache: a build that changed a tracked file saves nothing', () => {
  const repo = repository();
  stamp({ root: repo.root, target: repo.target, warm: false });
  repo.put('other/lib.rs', 'pub fn g() { /* written by the build */ }\n');
  assert.equal(seal({ root: repo.root, paths: [repo.target] }), false);
});
