#!/usr/bin/env node
// Records Node's git repository write lock for the k1 UNTESTED git-repo-rw-lock.test.mjs (gaps-tools.md row 27,
// mixdog-scm `locks.rs`). Each order case is the test's steps as a script, run through Node's real
// `withGitWorktreeWriteLock` / `withGitRepoWriteLock`; the events at each checkpoint and each write's outcome are
// recorded. The key case runs each of the test's spellings through Node's real `gitRepoLockKey` and records which
// spellings share one key. Paths under the case's temp root are written as `<root>`.
//
//   node benchmarks/rust-core/recorders/record-repo-locks-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/repo-locks-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-repo-locks-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/tools/builtin/git-repo-rw-lock.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { gitRepoLockKey, withGitRepoWriteLock, withGitWorktreeWriteLock } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/tools/builtin/git-repo-rw-lock.mjs'
);

const cases = [];

{
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rw-key-'));
  const dir = join(root, 'Repo', '.git');
  mkdirSync(dir, { recursive: true });
  // The test's spellings of one directory, each as the string it hands to gitRepoLockKey.
  const spellings = [dir, `${dir}/`, join(dir, 'x', '..'), realpathSync.native(dir), dir.toUpperCase(), dir.replace(/\\/g, '/')];
  const keys = spellings.map((s) => gitRepoLockKey(s));
  const groups = keys.map((k) => keys.indexOf(k));
  const unify = (s) => s.replace(/\\/g, '/').toLowerCase();
  const rel = (s) => (unify(s).startsWith(unify(root)) ? `<root>${s.slice(root.length)}` : s);
  cases.push({ case: 'git repo lock keys are canonical: real path, trailing separators, Windows casing', kind: 'keys', spellings: spellings.map(rel), recorded: { groups } });
  rmSync(root, { recursive: true, force: true });
}

// Ops: write {name, repo, worktrees (null = whole repository), hold, signal}; settle (setImmediate); tick
// (Promise.resolve); release {name}; abort {name}; await {name} records the outcome; snapshot records the events.
async function run(steps, root) {
  const events = [];
  const holds = new Map();
  const controllers = new Map();
  const writes = new Map();
  const out = [];
  // `<upper>` is the test's Windows spelling of the held worktree: upper-cased, with a trailing separator.
  const path = (p) => (p === '<upper>' ? `${join(root, 'Worktree').toUpperCase()}\\` : p.startsWith('<root>') ? join(root, p.slice(7)) : p);
  for (const step of steps) {
    if (step.op === 'write') {
      let body;
      if (step.hold) {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        holds.set(step.name, release);
        body = async () => {
          events.push(`${step.name}:start`);
          await gate;
          events.push(`${step.name}:end`);
        };
      } else body = async () => events.push(step.name);
      const options = {};
      if (step.signal) {
        const controller = new AbortController();
        controllers.set(step.name, controller);
        options.signal = controller.signal;
      }
      const repo = path(step.repo);
      writes.set(
        step.name,
        step.worktrees === null ? withGitRepoWriteLock(repo, body, options) : withGitWorktreeWriteLock(repo, step.worktrees.map(path), body, options)
      );
    } else if (step.op === 'settle') await new Promise((resolve) => setImmediate(resolve));
    else if (step.op === 'tick') await Promise.resolve();
    else if (step.op === 'release') holds.get(step.name)();
    else if (step.op === 'abort') controllers.get(step.name).abort();
    else if (step.op === 'await') {
      try {
        await writes.get(step.name);
        out.push({ await: step.name, ok: true });
      } catch (error) {
        out.push({ await: step.name, ok: false, error: error.message });
      }
    } else if (step.op === 'snapshot') out.push({ events: [...events] });
  }
  return out;
}

const w = (name, worktrees, extra = {}) => ({ op: 'write', name, repo: extra.repo ?? 'repo', worktrees, hold: false, ...extra });
const scripts = {
  'writes on different worktrees run together; writes on one worktree run one at a time in order': [
    w('a1', ['wt-a'], { hold: true }),
    w('a2', ['wt-a'], { hold: true }),
    w('b', ['wt-b'], { hold: true }),
    { op: 'settle' },
    { op: 'snapshot' },
    { op: 'release', name: 'a1' },
    { op: 'await', name: 'a1' },
    { op: 'settle' },
    { op: 'snapshot' },
    { op: 'release', name: 'a2' },
    { op: 'release', name: 'b' },
    { op: 'await', name: 'a2' },
    { op: 'await', name: 'b' },
    { op: 'snapshot' },
  ],
  'a write naming several worktrees conflicts with a write on any of them': [
    w('move', ['wt-a', 'wt-new'], { hold: true }),
    w('a', ['wt-a']),
    w('new', ['wt-new']),
    w('b', ['wt-b']),
    { op: 'await', name: 'b' },
    { op: 'settle' },
    { op: 'snapshot' },
    { op: 'release', name: 'move' },
    { op: 'await', name: 'move' },
    { op: 'await', name: 'a' },
    { op: 'await', name: 'new' },
    { op: 'snapshot' },
  ],
  'a waiting whole-repository write is never starved by later worktree writes': [
    w('a', ['wt-a'], { hold: true }),
    w('repo', null, { hold: true }),
    w('b', ['wt-b']),
    w('a2', ['wt-a']),
    { op: 'settle' },
    { op: 'snapshot' },
    { op: 'release', name: 'a' },
    { op: 'await', name: 'a' },
    { op: 'settle' },
    { op: 'snapshot' },
    { op: 'release', name: 'repo' },
    { op: 'await', name: 'repo' },
    { op: 'await', name: 'b' },
    { op: 'await', name: 'a2' },
    { op: 'snapshot' },
  ],
  'a later write that conflicts with nothing ahead of it is not held back by a queue': [
    w('a', ['wt-a'], { hold: true }),
    w('a2', ['wt-a']),
    w('b', ['wt-b']),
    { op: 'await', name: 'b' },
    { op: 'snapshot' },
    { op: 'release', name: 'a' },
    { op: 'await', name: 'a' },
    { op: 'await', name: 'a2' },
    { op: 'snapshot' },
  ],
  'worktree scopes are canonical paths; an empty scope holds the whole repository': [
    w('held', ['<root>/Worktree'], { repo: '<root>/.git', hold: true }),
    w('same', ['<upper>'], { repo: '<root>/.git' }),
    w('whole', [], { repo: '<root>/.git' }),
    { op: 'settle' },
    { op: 'snapshot' },
    { op: 'release', name: 'held' },
    { op: 'await', name: 'held' },
    { op: 'await', name: 'same' },
    { op: 'await', name: 'whole' },
    { op: 'snapshot' },
  ],
  'git repo writers on different repositories run in parallel': [
    w('a', null, { repo: 'repo-a', hold: true }),
    w('b', null, { repo: 'repo-b', hold: true }),
    { op: 'tick' },
    { op: 'snapshot' },
    { op: 'release', name: 'a' },
    { op: 'release', name: 'b' },
    { op: 'await', name: 'a' },
    { op: 'await', name: 'b' },
  ],
  'a queued git repo lock aborts without running or blocking later work': [
    w('writer', ['wt-a'], { hold: true }),
    { op: 'tick' },
    w('queued', null, { signal: true }),
    w('behind', ['wt-b']),
    { op: 'abort', name: 'queued' },
    { op: 'await', name: 'queued' },
    { op: 'await', name: 'behind' },
    { op: 'snapshot' },
    { op: 'release', name: 'writer' },
    { op: 'await', name: 'writer' },
    w('after', null),
    { op: 'await', name: 'after' },
    { op: 'snapshot' },
  ],
};

for (const [name, steps] of Object.entries(scripts)) {
  const usesRoot = JSON.stringify(steps).includes('<root>');
  const root = usesRoot ? mkdtempSync(join(tmpdir(), 'mixdog-rw-scope-')) : null;
  if (root) mkdirSync(join(root, 'Worktree'));
  cases.push({ case: name, kind: 'order', steps, recorded: await run(steps, root) });
  if (root) rmSync(root, { recursive: true, force: true });
}

const finalDir = join(FIXTURES_ROOT, 'repo-locks-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's git repository write lock at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'repo-locks-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "keys: which spellings share one key; order: every snapshot of the events and every write's outcome",
    excluded: {},
  },
});
commitStage(stage, finalDir);
console.log(`repo-locks-cases: ${cases.length} case(s)`);
process.exit(0);
