#!/usr/bin/env node
// What Node's folder watches (apps/desktop/src/main/desktop-operations.ts `createFolderWatchRegistry`, the registry behind the phone's
// `folderWatch`) do with the path classes the Rust watch must treat as Node does, recorded from an exact export of b6f10295a on this Windows
// host with the real `fs.watch`:
//   two names   a folder and a junction to it, both watched: the paths `fs.watch` was given (one watch per name) and the directory each
//               change was reported under;
//   failures    a missing folder, a folder the user may not list, and a file: `fs.watch`'s error (message and code) or none.
// Every path is recorded with the recording's folder written as `{root}`; the replay fills in its own.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-folder-watch.mjs --tree <git archive of b6f10295a with node_modules>
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'folder-watch');
const WAIT_MS = 60_000;
const tree = resolveTree(parseArgs());

const base = 'D:\\mixdog-build\\tmp\\w11';
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'fw-'));
const actual = join(root, 'actual');
const alias = join(root, 'alias');
const locked = join(root, 'locked');
const file = join(root, 'afile.txt');
const missing = join(root, 'missing');
mkdirSync(actual);
mkdirSync(locked);
writeFileSync(file, 'a');
symlinkSync(actual, alias, 'junction');
// Everyone is denied listing the folder (the owner keeps the right to undo it, which the cleanup does).
const icacls = (...args) => {
  const ran = spawnSync('icacls', [locked, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (ran.error || ran.status !== 0) throw new Error(`icacls ${args.join(' ')} failed (${ran.status}): ${ran.error?.message ?? ran.stdout + ran.stderr}`);
};
icacls('/deny', '*S-1-1-0:(RD)');
const token = (text) => String(text).replaceAll(root, '{root}');

const { createFolderWatchRegistry } = await importFrom(tree, 'apps/desktop/src/main/desktop-operations.ts');
const emitted = [];
let changed = () => {};
const given = [];
const registry = createFolderWatchRegistry(
  (event) => {
    if (event.name !== 'folder-changed') return;
    emitted.push(event.value);
    changed();
  },
  // The real fs.watch; the registry's own seam says which path it watched.
  (dir, options, listener) => {
    given.push(dir);
    return watch(dir, options, listener);
  },
  async () => []
);
const until = (test, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}; emitted ${JSON.stringify(emitted)}`)), WAIT_MS);
    changed = () => {
      if (!test()) return;
      clearTimeout(timer);
      changed = () => {};
      resolve();
    };
    changed();
  });
const attempt = (dir, recursive) => {
  try {
    registry.watch(dir, recursive);
    return { watched: true };
  } catch (error) {
    return { error: { message: token(error.message), code: error.code ?? null } };
  }
};

let recording;
try {
  // Two names of one folder: each is its own watch, and a change is reported under each name.
  const twoNames = { watch: [attempt(alias, true), attempt(actual, true)] };
  writeFileSync(join(actual, 'changed.txt'), '1');
  await until(() => emitted.includes(alias) && emitted.includes(actual), 'the change reported under both names');
  twoNames.fsWatchPaths = given.map(token);
  twoNames.reportedUnder = [alias, actual].map((dir) => ({ dir: token(dir), reports: emitted.filter((value) => value === dir).length }));
  registry.unwatch(alias, true);
  registry.unwatch(actual, true);
  // The failures, each on its own.
  given.length = 0;
  emitted.length = 0;
  const failures = [
    { name: 'missing folder', path: token(missing), answer: attempt(missing, false) },
    { name: 'folder the user may not list', path: token(locked), answer: attempt(locked, false) },
    { name: 'a file', path: token(file), answer: attempt(file, false) },
  ];
  writeFileSync(file, 'b');
  await until(() => emitted.includes(file), 'the change of the watched file');
  failures[2].reportedUnder = token(emitted[0]);
  registry.unwatch(file, false);
  recording = { twoNames, failures, fsWatchPathsOfFailures: given.map(token) };
} finally {
  icacls('/remove:d', '*S-1-1-0');
  rmSync(root, { recursive: true, force: true });
}

const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "Node's folder-watch registry (createFolderWatchRegistry, the real fs.watch) on a Windows host: a folder and a junction to it watched under both names, and the answers for a missing folder, a folder the user may not list and a file. `{root}` is the recording's folder.",
  ...recording,
});
writeSetManifest(out, {
  set: 'folder-watch',
  recorder: 'benchmarks/rust-core/recorders/record-folder-watch.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-folder-watch.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { cases: 4 },
});
commitStage(out, FIXTURES);
console.log(`folder-watch: ${JSON.stringify(recording)}`);
process.exit(0);
