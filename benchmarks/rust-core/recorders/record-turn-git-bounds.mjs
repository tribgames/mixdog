#!/usr/bin/env node
// Golden twin of the bounds Node puts on the turn review's git children and on a turn's end:
//
//   * every git child of the review's baseline, undo/reapply and ignored-path reads runs under a
//     `timeoutMs` (`runGit` -> `runGitOffThread`, run-child.mjs kills the child and rejects with
//     ETIMEDOUT `<git> <args> timed out after <ms>ms`), recorded here against a real hanging child
//     (a copy of this process's executable named git, preloaded to hang; in a directory named
//     `answer-*` it answers `rev-parse --show-toplevel` with that directory first);
//   * the baseline's failure is swallowed (`beginTurnSnapshot` still answers the turn token), a
//     wedged capture releases the worktree lock so the next capture runs;
//   * `tracker.finish` (snapshot-tracker.mjs) waits for the seal at most `turnCleanupSettleMs`,
//     for a cancelled wait only until the abort, and seals a cancelled turn in the background.
//
//   node benchmarks/rust-core/recorders/record-turn-git-bounds.mjs --tree <archive of the ref with node_modules> [--ref b6f10295a] [--work <dir>]
//
// The 30 s / 60 s limits are measured (a run takes about a minute); the 300 s gc limit and the
// 10 s ignored-path limit are read from the source lines that set them.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-git-bounds-')));
process.env.GIT_CEILING_DIRECTORIES = work;
process.env.GIT_CONFIG_NOSYSTEM = '1';

// ── the hanging git ─────────────────────────────────────────────────────────
const worktree = join(work, 'hang-workspace');
const beginTree = join(work, 'hang-begin');
const answerTree = join(work, 'answer-workspace');
for (const dir of [worktree, beginTree, answerTree]) mkdirSync(dir);
const fakeDir = join(work, 'fake-git');
mkdirSync(fakeDir);
const preload = join(work, 'fake-git-preload.cjs');
writeFileSync(
  preload,
  [
    "const { basename } = require('node:path');",
    "if (basename(process.execPath).toLowerCase().startsWith('git')) {",
    '  const argv = process.argv.slice(1);',
    "  if (argv.includes('--show-toplevel') && argv.some((a) => /rev-parse$/.test(a)) && basename(process.cwd()).startsWith('answer')) {",
    "    process.stdout.write(process.cwd() + '\\n', () => process.exit(0));",
    '  } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '}',
    '',
  ].join('\n')
);
copyFileSync(process.execPath, join(fakeDir, process.platform === 'win32' ? 'git.exe' : 'git'));
const realPath = process.env.PATH;
const realNodeOptions = process.env.NODE_OPTIONS;
process.env.PATH = `${fakeDir}${delimiter}${process.env.PATH}`;
process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;

const runner = await importFrom(tree, 'src/runtime/shared/git-runner.mjs');
const worktreeSnapshot = await importFrom(tree, 'src/runtime/shared/turn-worktree-snapshot.mjs');
const turnSnapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const turnChanges = await importFrom(tree, 'src/runtime/shared/turn-changes.mjs');
const abortRace = await importFrom(tree, 'src/runtime/shared/abort-race.mjs');
const trackerMod = await importFrom(tree, 'src/session-runtime/turn/turn-run/snapshot-tracker.mjs');

const text = (rel) => readFileSync(join(tree, rel), 'utf8');
const seconds = (started) => Math.round((performance.now() - started) / 1000);

// ── A. the error a killed git rejects with ──────────────────────────────────
const timeoutCases = [];
for (const [argv, timeoutMs] of [
  [['rev-parse', '--show-toplevel'], 300],
  [['rev-parse', '--show-object-format'], 450],
  [['check-ignore', '-z', '--stdin'], 600],
  [['cat-file', '-t', 'abc123'], 250],
]) {
  const error = await runner.runGitOffThread(argv, { cwd: worktree, timeoutMs, maxBytes: 1024 }).then(
    () => null,
    (e) => e
  );
  if (!error) throw new Error(`${argv.join(' ')} did not time out`);
  timeoutCases.push({ args: argv, timeoutMs, code: error.code, message: error.message });
}

// ── B. the limits, measured against a child that never answers ──────────────
// Concurrent: a baseline whose first command hangs (30 s), the same worktree's next capture queued
// behind it, the object-format read and the apply of an Undo (60 s).
const started = performance.now();
const settled = (promise) =>
  promise.then(
    (value) => ({ settled: 'resolved', value, afterSeconds: seconds(started) }),
    (error) => ({ settled: 'rejected', code: error.code, message: error.message, afterSeconds: seconds(started) })
  );
const [begin, firstCapture, secondCapture, objectFormat, apply] = await Promise.all([
  settled(turnSnapshot.beginTurnSnapshot(beginTree, 'bounds-session', { checkpointId: 'cp-1' })),
  settled(worktreeSnapshot.createTurnWorktreeSnapshot(answerTree)),
  settled(worktreeSnapshot.createTurnWorktreeSnapshot(answerTree)),
  settled(turnChanges.repositoryObjectFormat(worktree)),
  settled(turnChanges.applyTurnChangeFiles({ root: worktree, kind: 'git' }, [], { reverse: true })),
]);
const measured = { begin, firstCapture, secondCapture, objectFormat, apply };

// ── C. the limits written in the source ─────────────────────────────────────
const constantAt = (rel, pattern) => {
  const match = text(rel).match(pattern);
  if (!match) throw new Error(`${rel}: ${pattern} not found`);
  return Number(match[1].replaceAll('_', ''));
};
const sourceLimits = {
  commandTimeoutMs: constantAt('src/runtime/shared/turn-worktree-snapshot.mjs', /const COMMAND_TIMEOUT_MS = ([\d_]+);/),
  gcTimeoutMs: constantAt('src/runtime/shared/turn-worktree-snapshot.mjs', /'--quiet'\]\),\s*\{[\s\S]*?timeoutMs: ([\d_]+)/),
  applyTimeoutMs: constantAt('src/runtime/shared/turn-changes.mjs', /const APPLY_TIMEOUT_MS = ([\d_]+);/),
  ignoredPathsTimeoutMs: constantAt('src/runtime/shared/turn-snapshot.mjs', /\['check-ignore', '-z', '--stdin'\],\s*\{[\s\S]*?timeoutMs: ([\d_]+)/),
  turnCleanupSettleMs: constantAt('src/session-runtime/turn/turn-run.mjs', /turnCleanupSettleMs = ([\d_]+),/),
};

// ── D. tracker.finish ───────────────────────────────────────────────────────
const SETTLE_MS = 400;
const ABORT_AT_MS = 80;
const finishScenarios = [];
const tick = () => new Promise((done) => setImmediate(done));
for (const sc of [
  { name: 'seal resolves', hangs: false },
  { name: 'seal never resolves', hangs: true },
  { name: 'seal never resolves, the turn is cancelled while it waits', hangs: true, abortDuringWait: true },
  { name: 'cancelled turn seals in the background', hangs: true, abortedAtFinish: true },
  { name: 'cancelled turn whose review never began', hangs: false, abortedAtFinish: true, token: false },
  { name: 'cancelled completion wake', hangs: true, abortedAtFinish: true, continueTurn: true },
]) {
  const token = sc.token === false ? undefined : { generation: 3, checkpointId: 'cp-3' };
  const completeCalls = [];
  const controller = new AbortController();
  const factory = trackerMod.createSnapshotTrackerFactory({
    getCurrentCwd: () => worktree,
    beginTurnSnapshotForTurn: async () => token,
    completeTurnSnapshotForTurn: (sessionId, given) => {
      completeCalls.push({ sessionId, token: given === undefined ? null : given });
      return sc.hangs ? new Promise(() => {}) : Promise.resolve(true);
    },
    turnCleanupSettleMs: SETTLE_MS,
  });
  const tracker = factory({ id: 'cp-3', continueTurn: sc.continueTurn === true });
  tracker.start('sess-3');
  if (sc.abortedAtFinish) controller.abort();
  if (sc.abortDuringWait) setTimeout(() => controller.abort(), ABORT_AT_MS);
  const awaitTurn = (task) => abortRace.runAbortable(controller.signal, task, 'Turn aborted');
  const t0 = performance.now();
  await tracker.finish(controller.signal, awaitTurn);
  const waited = performance.now() - t0;
  await tick();
  finishScenarios.push({
    name: sc.name,
    abortedAtFinish: sc.abortedAtFinish === true,
    continueTurn: sc.continueTurn === true,
    abortDuringWait: sc.abortDuringWait === true,
    tokenBegan: token !== undefined,
    sealHangs: sc.hangs,
    // none: returned at once; abort: when the turn was cancelled; settle: when the settle limit passed.
    returnedAt: waited < SETTLE_MS / 8 ? 'none' : waited < SETTLE_MS * 0.9 ? 'abort' : 'settle',
    completeCalls,
  });
}

// ── write ───────────────────────────────────────────────────────────────────
// The manifest's identity check runs the real git.
process.env.PATH = realPath;
if (realNodeOptions === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = realNodeOptions;
const stage = stageSet(join(FIXTURES_ROOT, 'turn-git-bounds'));
writeText(join(stage, 'bounds.json'), `${JSON.stringify({ timeoutCases, measured, sourceLimits, finish: { settleMs: SETTLE_MS, abortAtMs: ABORT_AT_MS, scenarios: finishScenarios } }, null, 1)}\n`);
writeSetManifest(stage, {
  set: 'turn-git-bounds',
  recorder: 'benchmarks/rust-core/recorders/record-turn-git-bounds.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-git-bounds.mjs --tree <tree> --ref <ref>',
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, join(FIXTURES_ROOT, 'turn-git-bounds'));
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(FIXTURES_ROOT, 'turn-git-bounds')}`);
process.exit(0);
