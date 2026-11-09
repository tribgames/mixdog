#!/usr/bin/env node
// When Node tells the review it may read differently (`noteTurnReviewChanged`, turn-worktree-snapshot.mjs lines 175, 197, 1416 and
// turn-boundary-signal.mjs): after each action, how many times the one `onTurnReviewChanged` listener ran, and which sessions had a
// turn open (the signal names none: the desktop forwards it as `turn-review-changed` and the open session rereads).
//
//   node benchmarks/rust-core/recorders/record-turn-review-signal.mjs --tree <tree of b6f10295a with node_modules>
// Output: native/core/fixtures/turn-review-signal/scenarios.json
//
// Drives the real modules: the command-tool wiring of `session-runtime/runtime-review-api.mjs` (a command tool settling), the cache
// invalidation listener (file-change evidence of a tool write), the turn snapshot store (begin, tool writes, reads, the turn-end
// capture, Undo/Reapply) over real Git. After every action it takes one microtask turn (`await null`): the signal's own dispatch is
// a microtask queued before it, so no clock or retry is involved.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-review-signal-')));
process.env.GIT_CEILING_DIRECTORIES = work;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const snapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const store = await importFrom(tree, 'src/runtime/shared/turn-snapshot-store.mjs');
const worktrees = await importFrom(tree, 'src/runtime/shared/turn-worktree-snapshot.mjs');
const boundary = await importFrom(tree, 'src/runtime/shared/turn-boundary-signal.mjs');
const cache = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs');
const uiDiff = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch/ui-diff.mjs');
// Importing it registers the two wirings under test (a command settling, a cache invalidation) exactly as the runtime does.
await importFrom(tree, 'src/session-runtime/runtime-review-api.mjs');

let fires = 0;
boundary.onTurnReviewChanged(() => {
  fires += 1;
});
let delivered = null;
cache.registerCacheInvalidationListener((paths, source) => {
  delivered = { paths, canonical: source?.canonical === true };
});

const T = (text) => ({ text });
const lines = (...rows) => `${rows.join('\n')}\n`;
const bytes = (spec) => (spec === null ? null : Buffer.from(spec.text, 'utf8'));

async function runScenario(scenario) {
  const dir = mkdtempSync(join(work, 'sc-'));
  const roots = { base: dir, w1: join(dir, 'w1'), w2: join(dir, 'w2'), out: join(dir, 'elsewhere') };
  for (const root of [roots.w1, roots.w2, roots.out]) mkdirSync(root, { recursive: true });
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  store._setTurnSnapshotStoreRootForTest(join(data, 'turn-snapshots'));
  snapshot._resetTurnSnapshotForTest();
  worktrees._resetTurnWorktreeSnapshotsForTest();
  const tokens = new Map();
  const revisions = new Map();
  const open = new Set();
  const results = [];
  const where = (spec) => (spec.path ? join(roots[spec.ws], spec.path) : roots[spec.ws]);
  // The directories as tokens, in every spelling Node may hand a listener.
  const tokenize = (text) => {
    for (const [name, root] of Object.entries(roots).filter(([key]) => key !== 'base').concat([['base', roots.base]])) {
      for (const form of [root, root.replace(/\\/g, '/'), root.toLowerCase(), root.toLowerCase().replace(/\\/g, '/')]) text = text.split(form).join(`<${name}>`);
    }
    return text;
  };
  const settle = (spec) => boundary.noteCommandToolSettled(spec.cwd === null ? '' : where(spec));
  const evidence = (spec) => {
    delivered = null;
    cache.invalidateBuiltinResultCache(spec.paths.map((path) => where({ ws: spec.ws, path })));
    return delivered;
  };
  const run = async (op) => {
    switch (op.op) {
      case 'git':
        execFileSync('git', ['init', '-q'], { cwd: roots[op.ws] });
        return {};
      case 'file':
        mkdirSync(dirname(where(op)), { recursive: true });
        writeFileSync(where(op), bytes(op.content));
        return {};
      case 'begin': {
        const token = await snapshot.beginTurnSnapshot(roots[op.ws], op.session, { checkpointId: op.checkpoint });
        tokens.set(op.session, token);
        open.add(op.session);
        return {};
      }
      case 'complete':
        return { completed: await snapshot.completeTurnSnapshot(op.session, tokens.get(op.session) ?? null) };
      case 'settle':
        settle(op);
        return {};
      case 'evidence': {
        const got = evidence(op);
        return { delivered: got.paths.map(tokenize) };
      }
      case 'burst': {
        // Several signals within one task: one delivery.
        const parts = [];
        for (const part of op.parts) {
          if (part.op === 'settle') {
            settle(part);
            parts.push({});
          } else parts.push({ delivered: evidence(part).paths.map(tokenize) });
        }
        return { parts };
      }
      case 'edit': {
        // A tool write: the file changes on disk, then the call's before/after join the review (no signal of its own).
        const full = where(op);
        const before = (() => {
          try {
            return readFileSync(full);
          } catch {
            return null;
          }
        })();
        mkdirSync(dirname(full), { recursive: true });
        if (op.content === null) rmSync(full, { force: true });
        else writeFileSync(full, bytes(op.content));
        uiDiff.recordToolFileChanges({ sessionId: op.session, basePath: roots[op.ws], changes: [{ fullPath: full, before, after: bytes(op.content) }] });
        return {};
      }
      case 'external':
        // A write no boundary reported.
        mkdirSync(dirname(where(op)), { recursive: true });
        writeFileSync(where(op), bytes(op.content));
        return {};
      case 'review': {
        const reply = await snapshot.getTurnReviewDiff(roots[op.ws], op.session, {});
        return { files: reply.files.map((file) => file.path) };
      }
      case 'sessionReview': {
        const reply = await snapshot.getSessionReviewDiff(roots[op.ws], op.session);
        return { files: reply.files.map((file) => file.path) };
      }
      case 'revert': {
        const outcome = await (op.file ? snapshot.revertTurnReviewFile(roots[op.ws], op.session, op.file, op.checkpoint) : snapshot.revertTurnReview(roots[op.ws], op.session, op.checkpoint)).then(
          () => true,
          () => false
        );
        return { ok: outcome };
      }
      case 'changes': {
        const reply = await snapshot.getTurnChanges(op.session, { checkpointId: op.checkpoint });
        revisions.set(op.checkpoint, reply.revision);
        return {};
      }
      case 'undo':
      case 'redo': {
        const run = op.op === 'undo' ? snapshot.revertTurnChanges : snapshot.reapplyTurnChanges;
        const outcome = await run(op.session, op.checkpoint, op.file ?? null, revisions.get(op.checkpoint)).then(
          (reply) => {
            revisions.set(op.checkpoint, reply.revision);
            return true;
          },
          () => false
        );
        return { ok: outcome };
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  };
  for (const [index, op] of scenario.ops.entries()) {
    fires = 0;
    const extra = await run(op);
    await null;
    results.push({ op: index, fires, sessions: [...open].sort(), ...extra });
  }
  worktrees._resetTurnWorktreeSnapshotsForTest();
  return { name: scenario.name, platform: process.platform, ops: scenario.ops, results };
}

const gitTwo = [
  { op: 'git', ws: 'w1' },
  { op: 'file', ws: 'w1', path: 'a.txt', content: T(lines('one', 'two')) },
  { op: 'file', ws: 'w1', path: 'sub/inner.txt', content: T('inner\n') },
  { op: 'git', ws: 'w2' },
  { op: 'file', ws: 'w2', path: 'b.txt', content: T(lines('bee')) },
];
const threeSessions = [
  { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp1' },
  { op: 'begin', ws: 'w1', session: 's2', checkpoint: 'cp2' },
  { op: 'begin', ws: 'w2', session: 's3', checkpoint: 'cp3' },
];
const scenarios = [
  {
    name: 'a command tool settling and file-change evidence, with two sessions on one worktree and one on another',
    ops: [
      // No worktree is tracked yet: nothing to stamp.
      { op: 'settle', ws: 'w1' },
      { op: 'evidence', ws: 'w1', paths: ['a.txt'] },
      ...gitTwo,
      ...threeSessions,
      { op: 'settle', ws: 'w1' },
      { op: 'settle', ws: 'w1', path: 'sub' },
      { op: 'settle', ws: 'w2' },
      { op: 'settle', cwd: null },
      { op: 'settle', ws: 'out' },
      { op: 'evidence', ws: 'w1', paths: ['a.txt'] },
      { op: 'evidence', ws: 'out', paths: ['x.txt'] },
      { op: 'evidence', ws: 'w2', paths: ['b.txt'] },
      { op: 'evidence', ws: 'w1', paths: ['sub'] },
      { op: 'evidence', ws: 'base', paths: [''] },
      {
        op: 'burst',
        parts: [
          { op: 'settle', ws: 'w1' },
          { op: 'evidence', ws: 'w2', paths: ['b.txt'] },
          { op: 'settle', cwd: null },
        ],
      },
      { op: 'settle', cwd: null },
    ],
  },
  {
    name: 'tool writes, reads and the turn-end capture of three sessions',
    ops: [
      ...gitTwo,
      ...threeSessions,
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', content: T(lines('one', '2')) },
      { op: 'review', ws: 'w1', session: 's1' },
      { op: 'review', ws: 'w1', session: 's1' },
      { op: 'review', ws: 'w1', session: 's2' },
      { op: 'review', ws: 'w2', session: 's3' },
      { op: 'edit', ws: 'w2', session: 's3', path: 'b.txt', content: T(lines('bee', 'hive')) },
      { op: 'review', ws: 'w2', session: 's3' },
      { op: 'review', ws: 'w2', session: 's3' },
      { op: 'external', ws: 'w2', path: 'b.txt', content: T(lines('bee', 'honey')) },
      { op: 'review', ws: 'w2', session: 's3' },
      { op: 'settle', ws: 'w2' },
      { op: 'review', ws: 'w2', session: 's3' },
      { op: 'sessionReview', ws: 'w2', session: 's3' },
      { op: 'sessionReview', ws: 'w2', session: 's3' },
      { op: 'external', ws: 'w1', path: 'a.txt', content: T(lines('one', 'three')) },
      { op: 'review', ws: 'w1', session: 's1' },
      { op: 'settle', ws: 'w1' },
      { op: 'review', ws: 'w1', session: 's1' },
      { op: 'sessionReview', ws: 'w1', session: 's1' },
      { op: 'sessionReview', ws: 'w1', session: 's2' },
      { op: 'external', ws: 'w2', path: 'b.txt', content: T(lines('bee', 'sting')) },
      { op: 'settle', ws: 'w2' },
      { op: 'complete', session: 's3' },
      { op: 'complete', session: 's1' },
      { op: 'external', ws: 'w1', path: 'a.txt', content: T(lines('one', 'four')) },
      { op: 'complete', session: 's2' },
      { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp4' },
      { op: 'complete', session: 's1' },
    ],
  },
  {
    name: 'Undo of a running turn and of a sealed one',
    ops: [
      { op: 'git', ws: 'w1' },
      { op: 'file', ws: 'w1', path: 'a.txt', content: T(lines('x', 'y')) },
      { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp1' },
      { op: 'begin', ws: 'w1', session: 's2', checkpoint: 'cp2' },
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', content: T(lines('x', 'Y')) },
      { op: 'edit', ws: 'w1', session: 's1', path: 'n.txt', content: T('new\n') },
      { op: 'revert', ws: 'w1', session: 's1', file: 'a.txt', checkpoint: 'cp1' },
      { op: 'revert', ws: 'w1', session: 's1', checkpoint: 'cp1' },
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', content: T(lines('x', 'Z')) },
      { op: 'complete', session: 's1' },
      { op: 'changes', session: 's1', checkpoint: 'cp1' },
      { op: 'undo', session: 's1', checkpoint: 'cp1' },
      { op: 'changes', session: 's1', checkpoint: 'cp1' },
      { op: 'redo', session: 's1', checkpoint: 'cp1' },
    ],
  },
];

const recorded = [];
for (const scenario of scenarios) recorded.push(await runScenario(scenario));

const finalOut = join(FIXTURES_ROOT, 'turn-review-signal');
const out = stageSet(finalOut);
writeText(join(out, 'scenarios.json'), `${JSON.stringify(recorded, null, 1)}\n`);
writeSetManifest(out, {
  set: 'turn-review-signal',
  recorder: 'benchmarks/rust-core/recorders/record-turn-review-signal.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-review-signal.mjs --tree <tree>',
  extra: { scenarios: recorded.length },
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(out, finalOut);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${finalOut}`);
