#!/usr/bin/env node
// Golden twin of the bounds Node puts on the turn review's git children and on a turn's end:
//
//   * every git child of the review's baseline, undo/reapply, ignored-path reads and shadow gc
//     runs under a `timeoutMs` (`runGit` -> `runGitOffThread`, run-child.mjs kills the child tree
//     and rejects with ETIMEDOUT `<git> <args> timed out after <ms>ms`);
//   * the baseline's failure is swallowed (`beginTurnSnapshot` still answers the turn token) and
//     a capture that gives up releases the worktree lock, so the capture queued behind it runs;
//   * `tracker.finish` (snapshot-tracker.mjs) waits for the seal at most `turnCleanupSettleMs`,
//     for a cancelled wait only until the abort, and seals a cancelled turn in the background.
//
// Everything runs the real modules over real repositories and the real git. A preload (the
// worker threads inherit it) wraps `child_process.spawn` of the git runner's workers: the one
// call a scenario names (a verb in a directory) is replaced by a child that never answers, every
// other call runs the real git. Each spawn is logged, so the recorder proves that the hanging
// call was reached, when it was started, when its child ended and that it is gone.
//
//   node benchmarks/rust-core/recorders/record-turn-git-bounds.mjs --tree <archive of the ref with node_modules> [--ref b6f10295a] [--work <dir>]
//
// A run takes about seven minutes: the shadow gc starts a minute after the capture it follows and
// is measured to its 300 s limit.
import { existsSync, mkdirSync, mkdtempSync, watch, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-git-bounds-')));
process.env.GIT_CEILING_DIRECTORIES = work;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.MIXDOG_DATA_DIR = join(work, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR);

const pathKey = (p) => resolve(String(p)).replace(/\\/g, '/').toLowerCase();

// ── real repositories ───────────────────────────────────────────────────────
function git(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function seedRepo(name) {
  const repo = join(work, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tautocrlf = false\n[maintenance]\n\tauto = false\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitignore'), 'out/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return realpathSync.native(repo);
}
const repos = Object.fromEntries(['capture', 'begin', 'apply', 'ignore'].map((n) => [n, seedRepo(n)]));
const directDirs = [0, 1, 2, 3].map((n) => {
  const dir = join(work, `direct-${n}`);
  mkdirSync(dir);
  return realpathSync.native(dir);
});

// ── the plan: which call hangs ──────────────────────────────────────────────
const plan = join(work, 'plan.json');
const log = join(work, 'spawns.jsonl');
const rules = [];
const hang = (id, verb, cwd) => rules.push({ id, verb, cwd: pathKey(cwd) });
hang('direct-0', 'rev-parse', directDirs[0]);
hang('direct-1', 'rev-parse', directDirs[1]);
hang('direct-2', 'check-ignore', directDirs[2]);
hang('direct-3', 'cat-file', directDirs[3]);
hang('capture', 'write-tree', repos.capture);
hang('gc', 'gc', repos.capture);
hang('begin', 'write-tree', repos.begin);
hang('apply', 'apply', repos.apply);
hang('check-ignore', 'check-ignore', repos.ignore);
writeFileSync(plan, JSON.stringify({ rules }));
writeFileSync(log, '');
const preload = join(work, 'hang-preload.cjs');
writeFileSync(
  preload,
  `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.env.BOUNDS_PLAN && !process.env.BOUNDS_HUNG_CHILD) {
  const realSpawn = cp.spawn;
  const key = (p) => path.resolve(String(p)).replace(/\\\\/g, '/').toLowerCase();
  const verbOf = (argv) => {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '-c' || a === '-C' || a === '--git-dir' || a === '--work-tree') i += 1;
      else if (!a.startsWith('-')) return a;
    }
    return '';
  };
  const note = (entry) => fs.appendFileSync(process.env.BOUNDS_LOG, JSON.stringify(entry) + '\\n');
  cp.spawn = function (command, argv, options) {
    const list = Array.isArray(argv) ? argv : [];
    const verb = verbOf(list);
    const cwd = options && options.cwd ? key(options.cwd) : '';
    let rule = null;
    for (const r of JSON.parse(fs.readFileSync(process.env.BOUNDS_PLAN, 'utf8')).rules) {
      if (r.verb !== verb || r.cwd !== cwd) continue;
      try {
        fs.closeSync(fs.openSync(process.env.BOUNDS_PLAN + '.' + r.id + '.claimed', 'wx'));
        rule = r;
        break;
      } catch {}
    }
    if (!rule) {
      const child = realSpawn.apply(this, arguments);
      note({ ev: 'spawn', t: Date.now(), verb, args: list, cwd, hung: false, pid: child.pid });
      return child;
    }
    const env = { ...((options && options.env) || process.env), BOUNDS_HUNG_CHILD: '1' };
    const child = realSpawn.call(this, process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { ...options, env });
    note({ ev: 'spawn', t: Date.now(), verb, args: list, cwd, hung: true, rule: rule.id, pid: child.pid });
    child.once('exit', (code, signal) => note({ ev: 'exit', t: Date.now(), rule: rule.id, pid: child.pid, code, signal }));
    return child;
  };
}
`
);
const realNodeOptions = process.env.NODE_OPTIONS;
process.env.BOUNDS_PLAN = plan;
process.env.BOUNDS_LOG = log;
process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;

const runner = await importFrom(tree, 'src/runtime/shared/git-runner.mjs');
// The executable every timeout message names: the program git-runner-worker.mjs starts for this PATH.
const { gitCommand } = await importFrom(tree, 'src/runtime/shared/git-launch.mjs');
const GIT_COMMAND = gitCommand();
if (!isAbsolute(GIT_COMMAND)) throw new Error(`git resolves to ${GIT_COMMAND}, not a path the messages can name`);
const worktreeSnapshot = await importFrom(tree, 'src/runtime/shared/turn-worktree-snapshot.mjs');
const turnSnapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const turnChanges = await importFrom(tree, 'src/runtime/shared/turn-changes.mjs');
const abortRace = await importFrom(tree, 'src/runtime/shared/abort-race.mjs');
const trackerMod = await importFrom(tree, 'src/session-runtime/turn/turn-run/snapshot-tracker.mjs');
const { registerEditToolUiDiff } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch/ui-diff.mjs');

const text = (rel) => readFileSync(join(tree, rel), 'utf8');
const entries = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
// Resolves once `found()` holds, woken by the log's own writes.
const untilLogged = (found) =>
  new Promise((done) => {
    const watcher = watch(log, () => {
      if (!found()) return;
      watcher.close();
      done();
    });
    if (found()) {
      watcher.close();
      done();
    }
  });
const spawnOf = (id) => {
  const entry = entries().find((e) => e.ev === 'spawn' && e.rule === id);
  if (!entry) throw new Error(`${id}: the hanging git call was never reached`);
  return entry;
};
const exitOf = (id) => entries().find((e) => e.ev === 'exit' && e.rule === id);
// Names in a message or an argument that differ between two runs.
const mask = (value) =>
  String(value)
    .replaceAll(work, '<work>')
    .replaceAll(work.replace(/\\/g, '/'), '<work>')
    .replace(/[0-9a-f]{24}/g, '<key>');
const seconds = (ms) => Math.round(ms / 1000);
const settle = async (promise) => {
  const started = Date.now();
  try {
    return { ok: true, value: await promise, started, ended: Date.now() };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message, started, ended: Date.now() };
  }
};
const expectTimeout = (id, result, limitMs, verb) => {
  const hung = spawnOf(id);
  if (hung.verb !== verb) throw new Error(`${id}: hung ${hung.verb}, expected ${verb}`);
  if (result.ok || result.code !== 'ETIMEDOUT') throw new Error(`${id}: expected ETIMEDOUT, got ${JSON.stringify(result)}`);
  if (!result.message.startsWith(`${GIT_COMMAND} `) || !result.message.includes(`timed out after ${limitMs}ms`) || !result.message.includes(verb)) throw new Error(`${id}: ${result.message}`);
  if (result.ended - hung.t < limitMs - 200) throw new Error(`${id}: ended ${result.ended - hung.t} ms after its start, before ${limitMs} ms`);
  return hung;
};
const hungRecord = (hung) => ({ verb: hung.verb, args: hung.args.map(mask) });

// ── A. the error a killed git rejects with ──────────────────────────────────
const timeoutCases = [];
for (const [n, [argv, timeoutMs, verb]] of [
  [['rev-parse', '--show-toplevel'], 300, 'rev-parse'],
  [['rev-parse', '--show-object-format'], 450, 'rev-parse'],
  [['check-ignore', '-z', '--stdin'], 600, 'check-ignore'],
  [['cat-file', '-t', 'abc123'], 250, 'cat-file'],
].entries()) {
  const result = await settle(runner.runGitOffThread(argv, { cwd: directDirs[n], timeoutMs, maxBytes: 1024 }));
  expectTimeout(`direct-${n}`, result, timeoutMs, verb);
  timeoutCases.push({ args: argv, timeoutMs, code: result.code, message: result.message });
}

// A real kill: the real git runs an alias whose shell command never ends and holds a file open.
// The run must time out only after the alias was reached (the file exists), and once the tree is
// killed nothing holds the file any more (on Windows it cannot be removed while a handle is open).
const killDir = join(work, 'real-kill');
mkdirSync(killDir);
const killArgs = ['-c', 'alias.wedge=!sleep 600 > held.marker', 'wedge'];
const killResult = await settle(runner.runGitOffThread(killArgs, { cwd: killDir, timeoutMs: 5000, maxBytes: 1024 }));
if (killResult.ok || killResult.code !== 'ETIMEDOUT') throw new Error(`real kill: ${JSON.stringify(killResult)}`);
if (!existsSync(join(killDir, 'held.marker'))) throw new Error('real kill: the alias was never reached');
rmSync(join(killDir, 'held.marker'));
if (!killResult.message.startsWith(`${GIT_COMMAND} `)) throw new Error(`real kill: ${killResult.message}`);
const realKill = { args: killArgs, timeoutMs: 5000, code: killResult.code, message: killResult.message, aliasReached: true, heldFileReleased: true };

// ── B. the limits, each against the one call it names ───────────────────────
// The files a turn writes: the edit a Undo reverses and a change record lists.
const edit = (sessionId, repo, content) => {
  const full = join(repo, 'a.txt');
  const before = readFileSync(full);
  writeFileSync(full, content);
  registerEditToolUiDiff({ callId: 'edit-1', sessionId, basePath: repo, fullPath: full, before, after: Buffer.from(content) });
};

// 1. Two captures of one worktree, started together: the first one's last command hangs, the
// one queued behind it waits for the lock, and runs once the first gave up.
const [first, second] = await Promise.all([
  settle(worktreeSnapshot.createTurnWorktreeSnapshot(repos.capture)),
  settle(worktreeSnapshot.createTurnWorktreeSnapshot(repos.capture)),
]);
const firstHung = expectTimeout('capture', first, 30_000, 'write-tree');
if (!second.ok || !second.value?.baselineTree) throw new Error(`the queued capture did not run: ${JSON.stringify(second)}`);
const inLock = entries().filter((e) => e.ev === 'spawn' && !e.hung && e.cwd === pathKey(repos.capture) && e.verb !== 'rev-parse' && e.t > firstHung.t);
if (inLock.length === 0) throw new Error('the queued capture ran no git after the first one hung');
if (inLock.some((e) => e.t < firstHung.t + 30_000 - 200)) throw new Error('the queued capture ran before the first one gave up');
const captures = {
  first: { hung: hungRecord(firstHung), code: first.code, message: mask(first.message), afterSeconds: seconds(first.ended - firstHung.t) },
  second: { resolved: true, hasBaselineTree: true, afterSeconds: seconds(second.ended - second.started), startedGitOnlyAfterFirstTimedOut: true },
};

// 2. A turn's baseline whose capture hangs: the turn still gets its token.
const beginStarted = Date.now();
const beginToken = await turnSnapshot.beginTurnSnapshot(repos.begin, 'bounds-begin', { checkpointId: 'cp-1' });
const beginHung = spawnOf('begin');
if (!beginToken || Date.now() - beginHung.t < 30_000 - 200) throw new Error(`begin: ${JSON.stringify(beginToken)}`);
const begin = { hung: hungRecord(beginHung), token: beginToken, afterSeconds: seconds(Date.now() - beginStarted) };

// 3. The `git apply` of an Undo hangs.
const applyPatch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n';
const apply = await settle(
  turnChanges.applyTurnChangeFiles({ root: repos.apply, kind: 'git', counts: 'own' }, [{ path: 'a.txt', status: 'M', patch: applyPatch, patchEncoding: 'utf8' }], { reverse: true })
);
const applyHung = expectTimeout('apply', apply, 60_000, 'apply');
const applied = { hung: hungRecord(applyHung), code: apply.code, message: mask(apply.message), afterSeconds: seconds(apply.ended - applyHung.t) };

// 4. The change record's ignored-path read hangs: the record is still answered, nothing flagged.
const ignoreSession = 'bounds-ignore';
await turnSnapshot.beginTurnSnapshot(repos.ignore, ignoreSession, { checkpointId: 'cp' });
edit(ignoreSession, repos.ignore, 'two\n');
await turnSnapshot.completeTurnSnapshot(ignoreSession);
const ignoreStarted = Date.now();
const changes = await turnSnapshot.getTurnChanges(ignoreSession, { checkpointId: 'cp' });
const ignoreHung = spawnOf('check-ignore');
if (changes.status !== 'ready' || changes.files.some((f) => f.ignored)) throw new Error(`check-ignore: ${JSON.stringify(changes)}`);
if (Date.now() - ignoreHung.t < 10_000 - 200) throw new Error('check-ignore ended before its limit');
const ignoredPaths = {
  hung: hungRecord(ignoreHung),
  status: changes.status,
  files: changes.files.map((f) => f.path),
  flaggedIgnored: 0,
  afterSeconds: seconds(Date.now() - ignoreStarted),
};

// 5. The shadow gc of the capture's repository, which the successful capture scheduled a minute
// after it: measured to its 300 s limit.
await untilLogged(() => exitOf('gc'));
const gcHung = spawnOf('gc');
const gc = {
  hung: hungRecord(gcHung),
  startedSecondsAfterCapture: seconds(gcHung.t - second.ended),
  killedAfterSeconds: seconds(exitOf('gc').t - gcHung.t),
};
if (gc.killedAfterSeconds < 299) throw new Error(`gc was killed after ${gc.killedAfterSeconds} s`);

// Every hung child was ended by the kill: its own exit event, not a pid probe (Windows reuses
// pids at once). The tree kill itself is proved by the real-kill case above.
for (const rule of rules) {
  spawnOf(rule.id);
  await untilLogged(() => exitOf(rule.id));
}
const measured = { captures, begin, apply: applied, ignoredPaths, gc, hungChildrenGone: rules.length };

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
for (const [name, ms] of [['gc', gc.killedAfterSeconds], ['capture', captures.first.afterSeconds], ['apply', applied.afterSeconds], ['ignore', ignoredPaths.afterSeconds]]) {
  const limit = { gc: sourceLimits.gcTimeoutMs, capture: sourceLimits.commandTimeoutMs, apply: sourceLimits.applyTimeoutMs, ignore: sourceLimits.ignoredPathsTimeoutMs }[name];
  if (Math.abs(ms * 1000 - limit) > 2500) throw new Error(`${name}: measured ${ms} s, source ${limit} ms`);
}

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
    getCurrentCwd: () => repos.capture,
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
if (realNodeOptions === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = realNodeOptions;
const stage = stageSet(join(FIXTURES_ROOT, 'turn-git-bounds'));
writeText(join(stage, 'bounds.json'), `${JSON.stringify({ gitCommand: GIT_COMMAND, timeoutCases, realKill, measured, sourceLimits, finish: { settleMs: SETTLE_MS, abortAtMs: ABORT_AT_MS, scenarios: finishScenarios } }, null, 1)}\n`);
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
