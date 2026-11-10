#!/usr/bin/env node
// What Node's host (b6f10295a) answers the paired phone for the 62 source-control calls, recorded from an exact export:
// the relay's own frame executor (`executeRemoteFrame` over `createRemoteMethods`, remote-methods.ts) on top of the real
// desktop operations (`createDesktopOperations`, desktop-operations.ts), run on scratch git repositories. Per call the
// recording holds the params the phone sent, the frame the relay sent back (value, or error with its `errorCode`), the
// desktop operations the call invoked (name, arguments, and what each returned or threw) and the processes that were scripted.
//
// `gh`, its package managers and `soffice.com` never run: they are answered from fixtures/phone-scm/gh-script.json
// (lib/phone-scm-world.mjs), the file the Rust side scripts its runner with. Nothing reaches the network: the remote of
// the repositories is a bare repository next to them.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-scm.mjs --tree <git archive of b6f10295a with node_modules>
//
// Scratch repositories live under D:\mixdog-build\tmp\phone-ph2-scm-rec and are deleted when the run ends.
//
// With `--replay <mixdogd.exe>` the same scenario is driven through the phone's adapter against a built daemon and everything the
// recording holds is compared with what the core did, in the recorded order: the frame the phone got, every desktop operation's
// request and result, every program the core tried to start (started or not, and how it ended), the settings events, the virtual
// clock's steps, and the ordering scenario.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { basename, join, posix, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { envDelta, installScriptedProcesses, scriptedPty, serveShims } from './lib/phone-scm-world.mjs';

const REAL_HOME = process.env.USERPROFILE;
const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const WORK = process.env.PHONE_SCM_WORK ?? 'D:\\mixdog-build\\tmp\\phone-ph2-scm-rec';
const FIXTURES = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'fixtures', 'phone-scm');
const args = parseArgs();
// `--replay <mixdogd.exe>`: the same scripted scenario, but each call goes through the phone's adapter to a built `mixdogd` and
// what happens is compared in full with the recording (fixtures/phone-scm/golden.json) instead of being recorded. The core spawns
// its own tools: they are the executables of lib/scripted-tool.rs on its PATH, answered by the same script as Node's.
const REPLAY = args.get('replay') ?? null;
// `--only <group>`: record or replay one group of cases and stop. A recording of one group is written to `--out <file>`, never to
// the fixture (the full run is what the fixture holds); a replay of one group compares that group's cases of the fixture.
const GROUPS = {
  // Every argument check of Node's host for the phone's source-control calls (the cases named `input-*` and `refused-*`).
  input: (name) => /^(input|refused)-/.test(name),
};
const ONLY = args.get('only') ?? null;
if (ONLY !== null && !GROUPS[ONLY]) throw new Error(`--only takes one of ${Object.keys(GROUPS).join(', ')}, not ${ONLY}`);
const ONLY_OUT = args.get('out') ?? null;
if (ONLY !== null && !REPLAY && !ONLY_OUT) throw new Error('--only records into --out <file>, never into the fixture');
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
// The recorder and every file of lib/ it runs, each by the hash of its committed (LF) text: the manifest names them, and a replay
// compares them with the files of the running recorder before it compares anything else.
const RECORDER_FILES = ['record-phone-scm.mjs', 'lib/common.mjs', 'lib/phone-scm-world.mjs', 'lib/scripted-tool.rs', 'lib/spawn-log.cjs'].map((file) => `benchmarks/rust-core/recorders/${file}`);
const recorderFiles = () => RECORDER_FILES.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n')).digest('hex') }));
{
  const own = readFileSync(join(REPO_ROOT, RECORDER_FILES[0]), 'utf8');
  const used = [...own.matchAll(/from '\.\/(lib\/[\w.-]+)'|'lib', '([\w.-]+)'/g)].map((match) => `benchmarks/rust-core/recorders/${match[1] ?? `lib/${match[2]}`}`);
  const unlisted = used.filter((path) => !RECORDER_FILES.includes(path));
  if (unlisted.length) throw new Error(`the recorder uses ${unlisted.join(', ')}, which RECORDER_FILES does not name`);
}
const script = JSON.parse(readFileSync(join(FIXTURES, 'gh-script.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const MACHINE_PATH = process.env.PATH;
rmSync(WORK, { recursive: true, force: true });
for (const dir of ['home', 'bin', 'data', 'ud', 'app', 'tmp']) mkdirSync(join(WORK, dir), { recursive: true });
// One fixed identity and clock, so a repository built twice has the same objects; the global git config is the scratch one.
Object.assign(process.env, {
  HOME: join(WORK, 'home'),
  USERPROFILE: join(WORK, 'home'),
  GIT_CONFIG_GLOBAL: join(WORK, 'home', '.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05+00:00',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05+00:00',
  // git's own clock for "10 months ago": 2026-11-02T03:04:05Z. The Rust side runs git with the same variable.
  GIT_TEST_DATE_NOW: '1793588645',
  MIXDOG_DATA_DIR: join(WORK, 'data'),
  // A commit's scratch index lives under the temp folder (git-commit-transaction.ts mkdtemp) and its path is in the recorded
  // environment of every git of the commit: the temp folder is this world's, not the one of whoever runs the recorder.
  TEMP: join(WORK, 'tmp'),
  TMP: join(WORK, 'tmp'),
  // Node's world is the core's world (the replay builds the same): this world's bin first, the Windows folders, and install places
  // that are folders of this world, so no tool of this machine is found by either.
  PATH: [join(WORK, 'bin'), join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';'),
  LOCALAPPDATA: join(WORK, 'lad'),
  APPDATA: join(WORK, 'appdata'),
  ProgramFiles: join(WORK, 'pf'),
  ProgramW6432: join(WORK, 'pf'),
  'ProgramFiles(x86)': join(WORK, 'pf86'),
});
delete process.env.MIXDOG_FEATURE_GIT;

// A wait that never ends is a defect to name, not a hang: every wait of this recorder is raced with a bound that only ever fails it.
// It is the real timer, taken before the virtual clock below replaces `setTimeout`.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const WAIT_BOUND_MS = 90_000;
function withDeadline(promise, message) {
  let timer;
  const stalled = new Promise((_, reject) => (timer = realSetTimeout(() => reject(new Error(message)), WAIT_BOUND_MS)));
  return Promise.race([promise, stalled]).finally(() => realClearTimeout(timer));
}

// A child of this recorder gets a bound, and a failure ends its whole process tree (taskkill /T), so nothing it started outlives it.
const CHILD_BOUND_MS = 120_000;
function endTree(pid) {
  if (!pid) return;
  const ended = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', timeout: 30_000 });
  // 128: no such process (it had already ended). Anything else left a tree running: that fails the run and names the process.
  if (ended.error || (ended.status !== 0 && ended.status !== 128)) {
    console.error(`the process tree of pid ${pid} could not be ended: ${ended.error?.message ?? `taskkill exit ${ended.status} ${ended.stderr ?? ''}`}`);
    process.exitCode = 1;
  }
}
/** `spawnSync` with the bound; a child that failed or ran out of time is ended with everything it started, and the failure is thrown. */
function boundedSync(file, args, options) {
  const result = spawnSync(file, args, { ...options, timeout: CHILD_BOUND_MS, killSignal: 'SIGKILL' });
  if (result.error || result.status !== 0) {
    endTree(result.pid);
    throw new Error(`${basename(file)} ${args.join(' ')} failed: ${result.error?.message ?? `exit ${result.status}`}\n${result.stderr ?? ''}`);
  }
  return result;
}
/** The same child run asynchronously under the recorder's deadline: when the wait fails the tree is still alive and is ended.
 *  The list `accept` names the exit statuses that are an answer rather than a failure. */
async function boundedTree(file, args, options, accept = [0]) {
  const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    const status = await withDeadline(closed, `${basename(file)} ${args.join(' ')} did not finish`);
    if (!accept.includes(status)) throw new Error(`${basename(file)} ${args.join(' ')} failed: exit ${status}\n${stderr}`);
    return { stdout, stderr };
  } catch (error) {
    endTree(child.pid);
    throw error;
  }
}
// Git resolves through PATH (git-launch.mjs gitCommand: the first absolute entry holding git.exe), and a deadline or an overflow
// names that resolved path in Node's message. Both products start with this world's bin first on PATH, and its git.exe is the
// scripted-tool executable (lib/scripted-tool.rs), which runs the real git: both name the same path, on any machine.
const shimExe = join(WORK, 'shim', 'scripted-tool.exe');
mkdirSync(join(WORK, 'shim'), { recursive: true });
await boundedTree('rustc', ['-O', '--edition', '2024', join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'scripted-tool.rs'), '-o', shimExe], { cwd: REPO_ROOT, env: { ...process.env, PATH: MACHINE_PATH, RUSTUP_HOME: join(REAL_HOME, '.rustup'), CARGO_HOME: join(REAL_HOME, '.cargo') } });
const realGit = MACHINE_PATH.split(';').filter((dir) => dir !== join(WORK, 'bin')).map((dir) => join(dir, 'git.exe')).find((file) => existsSync(file));
process.env.PHONE_SCM_REAL_GIT = realGit;
// The git that really runs on the scratch repositories, for Node and for the core alike. (The scripted `git --version` of
// gh-script.json is only what `gitCliStatus` is told.) It is recorded, and a replay with another git refuses to compare.
const realGitVersion = boundedSync(realGit, ['--version'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim();
if (!REPLAY) fs.copyFileSync(shimExe, join(WORK, 'bin', 'git.exe'));

// Node's clock is virtual: `Date.now` stays where it is until `advance` moves it, and so does Node's 60 s run limit of a git read
// (run-child.mjs arms it with `setTimeout(kill, 60000)`). While `limit` is set, a timer of exactly that many ms is on this
// clock: it fires when the clock reaches it, never by waiting. The built core gets the same clock through its debug-build seam
// (mixdog-scm src/seam.rs), advanced over one connection the recorder listens on, so the replay compares the core's own remote-list
// cache and run limit with Node's at the same instants.
const EPOCH_MS = 1_793_588_645_000;
const clock = {
  now: EPOCH_MS,
  limit: 0,
  tag: null,
  timers: new Set(),
  listeners: [],
  advance(ms) {
    clock.now += ms;
    const due = [...clock.timers].filter((timer) => timer.at <= clock.now).sort((a, b) => a.at - b.at);
    for (const timer of due) clock.timers.delete(timer);
    const fired = due.map((timer) => timer.child);
    const armed = [...clock.timers].map((timer) => timer.child);
    for (const timer of due) timer.fire();
    return { fired, armed };
  },
};
Date.now = () => clock.now;
// `new Date()` and `Date()` read the same clock (the prototype is the real one, so `instanceof Date` holds for every date).
const RealDate = Date;
globalThis.Date = new Proxy(RealDate, {
  construct: (target, given, newTarget) => Reflect.construct(target, given.length ? given : [clock.now], newTarget === globalThis.Date ? target : newTarget),
  apply: () => new RealDate(clock.now).toString(),
});
// Every other timer of the code under test runs on real time. They are counted by delay, armed and fired, and an interval at all
// is counted too: the recording prints them, so "no real timer decides anything recorded" is a measurement, not a belief.
const realTimers = new Map();
const countTimer = (delay, field) => {
  const key = String(delay ?? 0);
  const entry = realTimers.get(key) ?? { armed: 0, fired: 0 };
  entry[field] += 1;
  realTimers.set(key, entry);
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fire, delay, ...rest) => {
  countTimer(`interval ${delay}`, 'armed');
  return realSetInterval((...given) => (countTimer(`interval ${delay}`, 'fired'), fire(...given)), delay, ...rest);
};
globalThis.setTimeout = (fire, delay, ...rest) => {
  if (!(clock.limit > 0 && delay === clock.limit)) {
    countTimer(delay, 'armed');
    return realSetTimeout((...given) => (countTimer(delay, 'fired'), fire(...given)), delay, ...rest);
  }
  const timer = { at: clock.now + delay, child: clock.tag, fire: () => fire(...rest), unref() {}, ref() {} };
  clock.timers.add(timer);
  for (const listener of clock.listeners.splice(0)) listener();
  return timer;
};
globalThis.clearTimeout = (handle) => (clock.timers.delete(handle) ? undefined : realClearTimeout(handle));
// The attempts the core logs for programs of its JS workers (the LibreOffice probe, an installer): lib/spawn-log.cjs.
const JS_ATTEMPTS_FILE = join(WORK, 'js-attempts.jsonl');
// The shim's "git hangs" switch: while the file names a word, a git given that word as an argument never answers (the scripted
// world's git status that does not return), for Node's git and the core's alike.
const HANG_FILE = join(WORK, 'git-hangs.txt');
const FAIL_FILE = join(WORK, 'git-fails.txt');
process.env.PHONE_SCM_FAIL_FILE = FAIL_FILE;
// A git that fails with the given exit code and stderr (written `repeat` times) when it is given `word`, for the cases that follow.
const gitFailing = (word, code, message, repeat = 1) => writeFileSync(FAIL_FILE, [word, code, message, repeat].join('\n'));
process.env.PHONE_SCM_HANG_FILE = HANG_FILE;
// The shim's "another process stages" switch (lib/scripted-tool.rs): after the commit's index refresh has built its copy, inside
// the window the refresh holds index.lock, a second git runs and its exit code and stderr are written to AFTER_OUT.
const AFTER_FILE = join(WORK, 'git-after.txt');
const AFTER_OUT = join(WORK, 'git-after-out.txt');
process.env.PHONE_SCM_AFTER_FILE = AFTER_FILE;

// `ghlogin_<pid>_<n>` (github-cli.ts): the scripted host has a fixed pid.
Object.defineProperty(process, 'pid', { value: 4242 });
// A worktree file's revision token (git-history.ts worktreeRevision) is `size:mtimeNs:ctimeNs:ino` of the file system. The golden
// recording scripts the file system the same way (the identity of a path, and a time that moves with the content) so it is byte-
// reproducible; the replay reads the real one, and Node answers the revision-bearing calls again on that same file system.
if (!REPLAY) {
  const realStat = fs.promises.stat;
  const fnv = (text) => {
    let h = 0x811c9dc5n;
    for (const byte of Buffer.from(text)) h = ((h ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
    return h;
  };
  fs.promises.stat = async (path, options) => {
    const info = await realStat(path, options);
    if (!options?.bigint || !String(path).startsWith(WORK) || !info.isFile()) return info;
    const time = 1_767_323_045_000_000_000n + fnv(fs.readFileSync(path));
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { mtimeNs: time, ctimeNs: time, ino: fnv(String(path).slice(WORK.length)) });
  };
  syncBuiltinESMExports();
}
const processes = [];const scripted = installScriptedProcesses({ script, binDir: join(WORK, 'bin'), onSpawn: (spawn) => processes.push(spawn) });
const { world } = scripted;
const pty = scriptedPty({ onSpawn: (spawn) => processes.push(spawn) });

const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { createRemoteMethods, executeRemoteFrame } = await main('remote-methods');
const { createDesktopOperations } = await main('desktop-operations');
// The daemon that answers the phone starts git on its process-runner worker (desktop-service.ts:1052), so a failed command's text is\n// git-runner.ts gitFailure's (`Command failed: git commit ...`), not execFile's (which names the resolved git.exe).
const { setGitProcessRunner } = await main('git-runner');
// The runner the daemon's process pool runs in a worker thread (process-runner.mjs), here on the calling thread - the path its own comment
// gives for a bundle with no worker file - so that its run limit is a timer of this thread, on the virtual clock.
const { runChild } = await importFrom(tree, 'src/runtime/shared/run-child.mjs');
// Every git child of the host is an attempt, recorded at the moment it is issued (the order Node's code issues them in; the spawn
// itself is synchronous in the runner) with how it ended: its exit code, the runner's error code (ETIMEDOUT, EMAXBUFFER), or
// `code: -1` for a program that could not start (spawn ENOENT). The run limit is Node's own: no option is changed here.
// The git children of a call that are still running when it answers (a read that failed early leaves its siblings behind) are
// tracked, so the recorder waits for each one's own settling, not for a fixed time, before it takes the call's attempts.
const gitInFlight = new Set();
const pairsToEnv = (pairs) => (pairs ? Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf('=', 1)), pair.slice(pair.indexOf('=', 1) + 1)])) : undefined);
let inRunner = false;
setGitProcessRunner((command, runArgs, options) => {
  const attempt = { tool: 'git', argv: clone(runArgs), cwd: options.cwd ?? null, env: envDelta(options.env, process.env) };
  processes.push(attempt);
  // A virtual run limit armed while this child is started belongs to it.
  clock.tag = { tool: 'git', argv: clone(runArgs) };
  inRunner = true;
  const run = runChild({ command, args: runArgs, cwd: options.cwd, input: options.input ?? '', env: options.env ?? null, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
  inRunner = false;
  clock.tag = null;
  run.then(
    (result) => (attempt.reply = { code: result.code }),
    // A program the system refused to start (ENOENT, or UNKNOWN for a file no loader can run) never started.
    (error) => (attempt.reply = String(error?.syscall ?? '').startsWith('spawn') ? { code: -1, stderr: error.code } : { error: error?.code ?? 'error' }),
  );
  const entry = { settled: run.then(() => gitInFlight.delete(entry), () => gitInFlight.delete(entry)), argv: runArgs };
  gitInFlight.add(entry);
  return run;
});
// A git that Node starts without the runner above (a config read, a review's temporary index, ...) is an attempt too: it is taken
// where every child process starts, with how it ended. The runner's own children are recorded by the runner (with its limit's end).
{
  const { ChildProcess } = await import('node:child_process');
  const start = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function spawn(options) {
    const result = start.call(this, options);
    if (!inRunner && /(^|[\\/])git(\.exe)?$/i.test(String(options.file))) {
      const attempt = { tool: 'git', argv: (options.args ?? []).slice(1).map(String), cwd: options.cwd ?? null, env: envDelta(pairsToEnv(options.envPairs), process.env) };
      processes.push(attempt);
      if (this.pid === undefined) attempt.reply = { code: -1, stderr: 'ENOENT' };
      else {
        const entry = { settled: new Promise((settle) => this.once('close', settle)), argv: attempt.argv };
        gitInFlight.add(entry);
        entry.settled.then(() => gitInFlight.delete(entry));
        this.once('exit', (code) => (attempt.reply = { code }));
      }
    }
    return result;
  };
}/** Waits for the git children still running, except those `keep` says to leave (the one a scenario holds). */
async function drainGit(keep = () => false) {
  for (;;) {
    const waiting = [...gitInFlight].filter((entry) => !keep(entry.argv));
    if (!waiting.length) return;
    await withDeadline(Promise.all(waiting.map((entry) => entry.settled)), `git children of the call never settled: ${waiting.map((entry) => entry.argv.join(' ')).join(' | ')}`);
  }
}
const githubCli = await main('github-cli');
githubCli.githubCliLoginTestHooks.pty = pty.module;
// The sign-in ends when the continuation of its `gh auth setup-git` call has set the flow's state. Node has no event for that,
// so the hook hands its caller a thenable that resolves it and then queues the signal: the signal runs after the continuation.
const { run } = await main('cli-run');
let setupSettled;
githubCli.githubCliLoginTestHooks.run = (file, runArgs, timeout) => {
  const result = run(file, runArgs, timeout);
  if (runArgs[0] !== 'auth' || runArgs[1] !== 'setup-git') return result;
  return {
    then(resolve, reject) {
      result.then((value) => {
        resolve(value);
        queueMicrotask(setupSettled);
      }, reject);
    },
  };
};

let config = {};
const events = [];
const operations = createDesktopOperations({
  userDataPath: join(WORK, 'ud'),
  appPath: join(WORK, 'app'),
  packaged: false,
  loadConfig: async () => ({ readConfig: () => config }),
  emit: (event) => events.push(clone(event)),
});
const trace = [];
const failure = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  ...(typeof error?.code === 'string' ? { code: error.code } : {}),
  ...(error?.details !== undefined ? { details: clone(error.details) } : {}),
});
// While set, the next operation of this name waits for the gate before it runs (the ordering scenario below).
let hold = null;
const host = {
  invokeDesktopOperation: async (name, operationArgs) => {
    const entry = { name, args: clone(operationArgs) };
    trace.push(entry);
    try {
      if (hold?.name === name) {
        const { gate, reached } = hold;
        hold = null;
        reached();
        await gate;
      }
      const result = await operations.invoke(name, operationArgs);
      // JSON drops `undefined`: an operation that returned nothing has no `result` here.
      if (result !== undefined) entry.result = clone(result);
      return result;
    } catch (error) {
      entry.error = failure(error);
      throw error;
    }
  },
};
const methods = createRemoteMethods({ host });

// ── scratch repositories ──
const git = (cwd, ...gitArgs) => boundedSync(realGit, ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...gitArgs], { cwd, encoding: 'utf8', stdio: 'pipe' }).stdout;
/** What a call left in the repositories, read with the real git after the call ended: HEAD, every ref (by the commit's tree, author,
 *  message and history length: a commit's id carries its time, which differs between two runs), the staged index, the working tree
 *  (every file's content hash), the stashes, the local config, and the refs of the remote. Compared case by case: Node's answer is
 *  not the only thing a call leaves behind. */
function repoState(root, remote) {
  const read = (cwd, ...args) => git(cwd, '--no-optional-locks', ...args);
  // A status that is not an answer (unborn HEAD, detached HEAD) is an empty value, not a failure.
  const soft = (...args) => {
    const result = spawnSync(realGit, ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', timeout: CHILD_BOUND_MS, killSignal: 'SIGKILL' });
    assert.ok(!result.error, `${args.join(' ')}: ${result.error?.message}`);
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const refsOf = (cwd) =>
    read(cwd, 'for-each-ref', '--format=%(refname)%00%(objecttype)%00%(objectname)').split('\n').filter(Boolean).map((line) => {
      const [name, type, id] = line.split('\0');
      return type === 'commit'
        ? { name, tree: read(cwd, 'rev-parse', `${id}^{tree}`).trim(), message: read(cwd, 'log', '-1', '--format=%an%n%ae%n%B', id), length: read(cwd, 'rev-list', '--count', id).trim() }
        : { name, type };
    });
  return {
    headTree: soft('rev-parse', '--verify', '-q', 'HEAD^{tree}'),
    branch: soft('symbolic-ref', '-q', 'HEAD'),
    refs: refsOf(root),
    remoteRefs: refsOf(remote),
    index: read(root, 'ls-files', '-s').split('\n').filter(Boolean).map((line) => line.replace(/^(\d+) \S+ /, '$1 ')),
    tree: read(root, 'ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean).map((file) => {
      const path = join(root, file);
      return [file, existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null];
    }),
    stashes: read(root, 'stash', 'list', '--format=%gs').split('\n').filter(Boolean),
    config: read(root, 'config', '--local', '--list').split('\n').filter(Boolean),
  };
}const write = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const R = join(WORK, 'repo');
const ORIGIN = join(WORK, 'origin.git');
const OTHER = join(WORK, 'other');
const PLAIN = join(WORK, 'plain');
mkdirSync(PLAIN, { recursive: true });
mkdirSync(R, { recursive: true });
git(R, 'init', '-q', '-b', 'main');
write(R, 'a.txt', 'one\ntwo\nthree\n');
write(R, 'src/b.mjs', 'export const b = 1;\n');
git(R, 'add', '.');
git(R, 'commit', '-q', '-m', 'first');
// R has its remote from the start, so no status of it depends on how long Node keeps a remote list (see the cache cases on TEMP below).
git(WORK, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
git(R, 'remote', 'add', 'origin', ORIGIN);
write(R, 'a.txt', 'one\nTWO\nthree\nfour\n');
git(R, 'commit', '-q', '-am', 'second: edit a');
git(R, 'branch', 'feature');
const rev = (what) => git(R, 'rev-parse', what).trim();
const gitVersion = script.rules.find((rule) => rule.tool === 'git' && !rule.when).reply.stdout.trim();

const cases = [];
const covered = new Set();

// ── replay: a built mixdogd, driven by the phone's adapter ──
/**
 * The listener the core's debug seam connects to (mixdog-scm src/seam.rs). Everything the core tells arrives as one JSON line per
 * event, in the order it happened; `advance <ms>` moves its virtual clock, `sync` is answered after every event the core had
 * written before it, so what a finished call did is all here once the answer arrives.
 */
async function listenWire() {
  const events = [];
  let waiting = [];
  let socket = null;
  let connect;
  const connected = new Promise((resolve) => (connect = resolve));
  const server = net.createServer((peer) => {
    socket = peer;
    let received = '';
    peer.on('error', () => {});
    peer.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const lines = received.split('\n');
      received = lines.pop();
      for (const line of lines) events.push(JSON.parse(line));
      const recheck = waiting;
      waiting = [];
      for (const check of recheck) check();
    });
    connect();
  });
  await withDeadline(new Promise((resolve, reject) => (server.once('error', reject), server.listen(0, '127.0.0.1', resolve))), 'the clock-seam server did not start listening');
  const until = (find, message) =>
    withDeadline(
      new Promise((resolve) => {
        const check = () => {
          const found = find();
          if (found) resolve(found);
          else waiting.push(check);
        };
        check();
      }),
      message,
    );
  return {
    address: `127.0.0.1:${server.address().port}`,
    events,
    connected,
    until,
    /** Everything the core wrote before this call is in `events` when it resolves. */
    async sync() {
      const from = events.length;
      socket.write('sync\n');
      await until(() => events.slice(from).some((event) => event.event === 'synced'), 'the core never answered sync');
    },
    /** The virtual clock moves by `ms`; the children whose run limit that reached, and those still counting. */
    async advance(ms) {
      const from = events.length;
      socket.write(`advance ${ms}\n`);
      const advanced = await until(() => events.slice(from).find((event) => event.event === 'advanced'), `the core never answered advance ${ms}`);
      const child = ({ program, args }) => ({ tool: toolName(program), argv: args });
      return { advance: ms, fired: advanced.fired.map(child), armed: advanced.armed.map(child) };
    },
  };
}
/** The program's own name: no folder, no `.exe`. */
const toolName = (program) => basename(program).toLowerCase().replace(/\.exe$/, '');

let replay = null;
// However this run ends (a difference, a wait past its bound, an exception anywhere below), nothing it started outlives it: the
// core and everything under it, by the pid of the child this process still holds, and then the world's folder.
process.on('exit', () => {
  const core = replay?.core;
  if (core && core.exitCode === null && core.signalCode === null) endTree(core.pid);
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch (error) {
    console.error(`the world's folder ${WORK} could not be removed: ${error.message}`);
    process.exitCode = 1;
  }
});
const settingsChanges = [];
let settingsWaiting = [];
if (REPLAY) {
  // Nothing is compared with a recording its manifest does not vouch for: every file the manifest lists has the size and hash it
  // states and the folder holds no other, and the recording was made by this recorder (each of its files has the hash the
  // manifest names).
  const fixtureManifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'));
  const present = readdirSync(FIXTURES).filter((name) => name !== 'MANIFEST.json').sort();
  assert.deepEqual(present, fixtureManifest.files.map((file) => file.path).sort(), 'the fixture folder holds other files than its manifest lists: record again');
  for (const file of fixtureManifest.files) {
    const data = readFileSync(join(FIXTURES, file.path));
    assert.deepEqual({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }, { bytes: file.bytes, sha256: file.sha256 }, `${file.path} is not the file its manifest lists: record again`);
  }
  assert.deepEqual(fixtureManifest.recorderFiles, recorderFiles(), 'the recording was made by another recorder than this one (the hashes of its files differ): record again before comparing');
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  assert.equal(realGitVersion, golden.realGit, `the recording was made with "${golden.realGit}" and this machine's git is "${realGitVersion}": record again before comparing`);
  const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
  if (process.env.PHONE_SCM_VERBOSE) console.error('stage: imports');
  const { adapter, phoneCallError } = await here('apps/desktop/src/renderer/remote-protocol-scm.ts');
  const { runQueued, callQueueFor } = await here('apps/desktop/src/renderer/remote-protocol-queue.ts');
  const { SCM_OPERATION_ROUTES, SCM_REPLIES } = await here('apps/desktop/src/shared/scm-operation-route.ts');
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { scopeClient } = await here('apps/mobile/src/phone-send-scope.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const runtimeRoot = join(WORK, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  // The install layout: the manifest beside the binary names the JS runtime (a build output has none of its own).
  const manifest = join(REPLAY, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  // The tools the core spawns are executables of lib/scripted-tool.rs, answered by the same script as Node's (see serveShims).
  const lad = join(WORK, 'lad');
  const pf = join(WORK, 'pf');
  const shims = await serveShims({
    engine: scripted.engine,
    onSpawn: (spawn) => processes.push(spawn),
    shim: shimExe,
    places: {
      gh: join(lad, 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
      ghOnPath: join(WORK, 'bin', 'gh.exe'),
      winget: join(WORK, 'bin', 'winget.exe'),
      git: join(WORK, 'bin', 'git.exe'),
      // Node's probe tries the bare `soffice.com` first and finds it exactly when the world has LibreOffice; its other candidates
      // are files of this world, which has none. The core's world has the same: the one soffice.com is on its PATH.
      soffice: join(WORK, 'bin', 'soffice.com'),
    },
  });
  shims.sync();
  const wire = await listenWire();
  // Nothing the core spawns may reach this machine's own tools (an installer, an account tool, a browser). The environment is built,
  // not inherited: one Path (a second PATH key beside the inherited Path left the real one in force once), holding only this
  // world's bin folder and the Windows system folders; every install place the product probes is a folder of this world.
  const systemRoot = process.env.SystemRoot;
  const world86 = join(WORK, 'pf86');
  const coreEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(path|programfiles|programw6432|programfiles\(x86\)|localappdata|appdata)$/i.test(key)) coreEnv[key] = value;
  Object.assign(coreEnv, {
    Path: [join(WORK, 'bin'), join(systemRoot, 'System32'), systemRoot].join(';'),
    LOCALAPPDATA: lad,
    APPDATA: join(WORK, 'appdata'),
    ProgramFiles: pf,
    ProgramW6432: pf,
    'ProgramFiles(x86)': world86,
    PHONE_SCM_SHIM: shims.address,
    MIXDOG_HOME: join(WORK, 'home', '.mixdog'),
    MIXDOG_CONFIG_DIR: join(WORK, 'config'),
    MIXDOG_RUNTIME_ROOT: runtimeRoot,
    // The core's debug seam (mixdog-scm src/seam.rs): the connection its virtual clock and attempt events travel over, and the
    // scratch folder whose files have the scripted identity of the recording.
    MIXDOG_SCM_DEBUG_CLOCK: wire.address,
    MIXDOG_SCM_DEBUG_IDENTITY_ROOT: WORK,
    MIXDOG_SCM_DEBUG_ATTEMPTS: JS_ATTEMPTS_FILE,
    // The core's JS workers run Node's own code for some tools (the LibreOffice probe and install): their attempts go to the same log.
    NODE_OPTIONS: `--require ${join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'spawn-log.cjs').replaceAll('\\', '/')}`,
  });
  const inside = (file) => resolve(file).toLowerCase().startsWith(`${resolve(WORK).toLowerCase()}\\`);
  assert.equal(Object.keys(coreEnv).filter((key) => /^path$/i.test(key)).length, 1, 'the core gets exactly one Path');
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) assert.ok(inside(coreEnv[key]), `${key} is outside this world: ${coreEnv[key]}`);
  for (const tool of ['gh', 'winget', 'soffice', 'soffice.com', 'git']) {
    // The product's lookup is the child's own: where.exe resolves a name against the very environment the core will get.
    const found = await boundedTree(join(systemRoot, 'System32', 'where.exe'), [tool], { cwd: WORK, env: coreEnv }, [0, 1]); // where.exe answers 1 for a name it does not find
    assert.deepEqual(found.stdout.split(/\r?\n/).filter((line) => line && !inside(line)), [], `${tool} resolves outside this world`);
  }
  const core = spawn(REPLAY, ['serve'], {
    env: coreEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  core.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (process.env.PHONE_SCM_VERBOSE) console.error('[core]', String(chunk).trimEnd());
  });
  // The daemon publishes daemon.json when it serves: wait for that file to appear (a watch on its folder), or for the daemon to exit.
  const endpoint = await withDeadline(
    new Promise((resolve, reject) => {
      const watcher = fs.watch(runtimeRoot);
      const done = (fn, value) => (watcher.close(), fn(value));
      const look = () => {
        try {
          done(resolve, parseDiscovery(readFileSync(join(runtimeRoot, 'daemon.json'), 'utf8')));
        } catch (error) {
          if (process.env.PHONE_SCM_VERBOSE) console.error('look', error.message);
        }
      };
      watcher.on('change', look);
      core.once('exit', (code) => done(reject, new Error(`mixdogd exited ${code}:\n${stderr}`)));
      look();
    }),
    'the daemon never published daemon.json',
  );
  await withDeadline(wire.connected, 'the core never connected its debug seam (is mixdogd a debug build?)');
  if (process.env.PHONE_SCM_VERBOSE) console.error('endpoint', JSON.stringify(endpoint));
  const client = await withDeadline(connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => endpoint),
    clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    clock: { sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
    random: Math.random,
  }), 'the core never accepted the phone connection');
  // Node told the desktop's windows `settings-changed {scope: 'git'}` after a global git setting was written. The core publishes
  // that change itself, as the `hostState` section `gitConfig` of the app feed (service.rs GIT_CONFIG_KEY): the one thing a phone
  // watching the app feed can compare. Changes of the snapshot that subscribing folds are not events: the store announces the
  // whole snapshot (`appSnapshot`) after its sections, and counting starts there.
  let appLive = false;
  let appFolded;
  const appSnapshot = new Promise((resolve) => (appFolded = resolve));
  client.store.subscribe((change) => {
    if (change.type === 'appSnapshot') return appFolded();
    if (!appLive || change.type !== 'section' || change.section !== 'hostState' || change.key !== 'gitConfig') return;
    settingsChanges.push({ name: 'settings-changed', value: { scope: 'git' } });
    settingsWaiting = settingsWaiting.filter((waiter) => !waiter());
  });
  await withDeadline(client.subscribeApp(), 'the core never answered the app subscription');
  await withDeadline(appSnapshot, 'the core never sent the app snapshot');
  appLive = true;
  // Every request the adapter makes of the core, and what the core answered, in order: the desktop operations of the call, compared
  // with the ones Node ran. `hold`, when set, is told each request first and may keep it back (the ordering scenario's slow write).
  const wires = [];
  const holder = { hold: null };
  const traced = new Proxy(client, {
    get(target, key) {
      if (key !== 'call') return Reflect.get(target, key, target);
      return async (method, params, options) => {
        const entry = { method, ...(params === undefined ? {} : { params: clone(params) }) };
        wires.push(entry);
        await holder.hold?.(entry);
        try {
          const value = await target.call(method, params, options);
          entry.result = value === undefined ? null : clone(value);
          return value;
        } catch (error) {
          const data = error?.detail?.data;
          entry.error = {
            message: data?.message ?? error?.message ?? String(error),
            // A program the core could not start is `capabilityUnavailable{capability}` on the wire (the adapter reads the same).
            ...(data?.reason === 'capabilityUnavailable' && typeof data.capability === 'string' ? { capability: data.capability } : {}),
          };
          throw error;
        } finally {
          holder.ended?.(entry);
        }
      };
    },
  });
  // As the router gives it: the client scoped to the call, so every request frame carries the call's `sent` claim.
  const host = { ctx: {}, client: () => scopeClient(traced, () => {}) };
  const byName = new Map(golden.cases.map((entry) => [entry.name, entry]));
  replay = { core, client, host, adapter, phoneCallError, runQueued, callQueueFor, routes: SCM_OPERATION_ROUTES, replies: SCM_REPLIES, golden, byName, shims, wire, wires, holder, compared: [], differences: [], ptySeen: 0, jsSeen: 0, baseEnv: coreEnv };
}

/** The phone's adapter against the core: the frame the relay would carry. */
const frameOf = (value) => ({ ok: true, value: value === undefined ? null : clone(value) });
const failureFrame = (error) => ({ ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}), ...(error.details === undefined ? {} : { errorParams: error.details }) });
/** One phone call the way the router runs it: through the connection's one shared queue. */
function replayCall(call, params) {
  const answered = replay.runQueued(replay.host.ctx, call, params, async () => replay.adapter.calls[call](params, replay.host));
  return withDeadline(answered.then(frameOf, failureFrame), `the core never answered ${call}`);
}
/**
 * The arguments of a params text (`[cwd, "", 1.0, 40]`) with each argument kept as it is spelled: a primitive becomes
 * `JSON.rawJSON` of its own text, which `JSON.stringify` writes back unchanged, so the request frame carries the bytes Node read.
 * A list or an object is parsed; it must print back as the same text, or the bytes could not be kept.
 */
function spelledArgs(text) {
  const elements = [];
  let depth = 0;
  let quoted = false;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '\\') i += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) elements.push(text.slice(start, i));
    } else if (char === ',' && depth === 1) {
      elements.push(text.slice(start, i));
      start = i + 1;
    }
  }
  assert.equal(depth, 0, `params text ${text} is not one list`);
  return elements.map((element) => {
    if (/^[[{]/.test(element)) {
      const value = JSON.parse(element);
      assert.equal(JSON.stringify(value), element, `the argument ${element} would not be sent as it is spelled`);
      return value;
    }
    return JSON.rawJSON(element);
  });
}
/**
 * A call whose recording keeps its params text, sent to the core as those bytes: the operation's request (the page's route,
 * scm-operation-route.ts) made of the spelled arguments, without the page's argument checks, whose conversions (`Number(...)`)
 * would send other bytes. The core checks the arguments itself (mixdog-scm input.rs); its answer is read as the page reads it.
 */
function replaySpelled(call, text) {
  const args = spelledArgs(text);
  assert.ok(replay.routes[call] && replay.replies[call], `${call} is not one operation of the page's routes`);
  const route = replay.routes[call](args);
  const client = replay.host.client();
  const answered = replay.runQueued(replay.host.ctx, call, JSON.parse(text), async () => {
    try {
      const reply = await client.call(route.method, route.params);
      const value = await replay.replies[call](reply, { args, params: route.params, call: (method, params) => client.call(method, params) });
      return value === undefined ? null : value;
    } catch (error) {
      throw replay.phoneCallError(error);
    }
  });
  return { route: { method: route.method, params: JSON.parse(JSON.stringify(route.params)) }, answered: withDeadline(answered.then(frameOf, failureFrame), `the core never answered ${call}`) };
}

async function finishReplay() {
  // Every sign-in terminal child, in the order started: its program, directory, environment and how it ended. A one-group
  // replay starts none and compares none.
  const begun = new Map();
  for (const event of replay.wire.events) {
    if (event.event === 'begin' && event.pty) begun.set(event.seq, { argv: event.args, cwd: event.cwd, env: coreEnvDelta(event), ended: null });
    else if (event.event === 'done' && begun.has(event.seq)) begun.get(event.seq).ended = event.result;
  }
  if (ONLY === null && !isDeepStrictEqual([...begun.values()], replay.golden.ptyEnds)) replay.differences.push({ name: 'sign-in terminal children (program, directory, environment, end)', node: replay.golden.ptyEnds, core: [...begun.values()] });
  replay.client.close?.();
  const exited = new Promise((resolve) => replay.core.once('exit', resolve));
  endTree(replay.core.pid);
  await withDeadline(exited, 'the core did not exit after taskkill');
  rmSync(WORK, { recursive: true, force: true });
  const cases = replay.compared.filter((name) => name !== 'ordering');
  const expected = [...replay.byName.keys()].filter((name) => ONLY === null || GROUPS[ONLY](name));
  const unreplayed = expected.filter((name) => !cases.includes(name));
  const ordering = ONLY !== null ? 'not part of this group' : replay.compared.includes('ordering') ? 'replayed' : 'NOT replayed';
  console.log(`phone-scm replay over ${REPLAY}${ONLY === null ? '' : ` (group ${ONLY})`}: ${cases.length} cases and the ordering scenario compared (${ordering}), ${replay.differences.length} differ, ${unreplayed.length} of the recording not replayed${unreplayed.length ? `: ${unreplayed.join(', ')}` : ''}`);
  for (const difference of replay.differences) console.log(`DIFF ${difference.name}\n  node: ${JSON.stringify(difference.node)}\n  core: ${JSON.stringify(difference.core)}`);
  // A difference, a recorded case that was not replayed, or a tree that could not be ended (`endTree` set the code) fails the run.
  process.exit(replay.differences.length || unreplayed.length || (ONLY === null && !replay.compared.includes('ordering')) || process.exitCode ? 1 : 0);
}
// A login flow's id is `ghlogin_<pid>_<n>` in both products. Node's recording pins its pid (4242); the core's is its own process's,
// so the core's answer is read with that pid as the recording's. Nothing else is rewritten.
const coreParams = (params) => JSON.parse(JSON.stringify(params).replaceAll('ghlogin_4242_', `ghlogin_${replay.core.pid}_`));
const flowOf = (n) => (replay ? withDeadline(replay.shims.flow(n), `the core never ran gh auth login (flow ${n})`) : pty.spawned[n]);
// The core reads the gh output on its own time (Node's scripted pty is synchronous). Its sign-in flow is a scoped feed
// (`login:<flowId>`, service.rs login_start): the snapshot at subscription and every `login/updated` that follows carry the flow's
// state, so the replay learns what gh printed from the core's own notification rather than by asking again.
const loginFeeds = new Map();
async function watchFlow(flowId) {
  if (!replay) return;
  const coreId = coreParams([flowId])[0];
  const feedId = `login:${coreId}`;
  const feed = { state: null, waiting: [] };
  loginFeeds.set(flowId, feed);
  replay.client.on((event) => {
    if (event.type !== 'notification') return;
    const { params } = event.notification;
    if (params?.feedId !== feedId && params?.flowId !== coreId) return;
    feed.state = params.state;
    feed.waiting = feed.waiting.filter((waiter) => !waiter(feed.state));
  });
  await withDeadline(replay.client.call('feed/subscribe', { feedId }), `the core never answered the subscription to `);
}
function settled(flowId, ready) {
  if (!replay) return Promise.resolve();
  const feed = loginFeeds.get(flowId);
  return withDeadline(
    new Promise((resolve) => {
      if (feed.state && ready(feed.state)) return resolve();
      feed.waiting.push((state) => ready(state) && (resolve(), true));
    }),
    `flow ${flowId} never showed what gh printed`,
  );
}
// ── what the core did, as the replay sees it ──
/** An attempt as it is compared: the program's own name, its arguments, whether it started, and (a program that started, not the
 *  sign-in's terminal) how it ended: its exit code, or the error the runner reports (ETIMEDOUT, EMAXBUFFER). */
// A child started without a cwd runs where its parent runs: for the core, where the replay started it. The scratch index of a commit is
// named for its process and a random suffix (git-commit-transaction.ts mkdtemp); only that name differs between two runs.
const scratchIndex = (env) => ({ ...env, set: Object.fromEntries(Object.entries(env.set).map(([name, value]) => [name, name === 'GIT_INDEX_FILE' ? value.replace(/mixdog-commit-\d+-[A-Za-z0-9]+/, 'mixdog-commit-*') : value])) });
const attemptOf = ({ tool, argv, cwd, env, started, ended }) => ({ tool, argv, cwd: cwd ?? process.cwd(), env: scratchIndex(env), started, ...(started && ended ? ended : {}) });
/** The environment the core gave a child: what its request sets or removes on top of the one the core inherited, as a delta. */
function coreEnvDelta({ envSet, envRemove }) {
  const key = (name) => (process.platform === 'win32' ? name.toUpperCase() : name);
  const drop = new Set((envRemove ?? []).map(key));
  const set = new Set((envSet ?? []).map(([name]) => key(name)));
  const full = Object.fromEntries(Object.entries(replay.baseEnv).filter(([name]) => !drop.has(key(name)) && !set.has(key(name))));
  for (const [name, value] of envSet ?? []) full[name] = value;
  return envDelta(full, replay.baseEnv);
}
/** The attempts Node recorded for a call, in the order Node made them. */
const nodeAttempts = (list) =>
  (list ?? []).map(({ tool, argv, cwd, env, reply, ended }) =>
    attemptOf({
      tool,
      argv,
      cwd,
      env,
      started: reply?.code !== -1,
      ended: tool === 'pty' ? ended : reply?.error !== undefined ? { error: reply.error } : reply?.code !== undefined ? { code: reply.code } : null,
    }),
  );
/** The attempts of the core's own spawns since `mark`, in the order it issued them (the seam tells each at the moment it is made). */
function coreAttempts(mark) {
  const attempts = new Map();
  const order = [];
  for (const event of replay.wire.events.slice(mark)) {
    if (event.event === 'begin') {
      const attempt = { tool: event.pty ? 'pty' : toolName(event.program), argv: event.args, cwd: event.cwd, env: coreEnvDelta(event) };
      attempts.set(event.seq, attempt);
      order.push(attempt);
    } else if (event.event === 'spawned' && attempts.has(event.seq)) attempts.get(event.seq).started = event.started;
    // A sign-in terminal child ends on the scenario's own time: its end is compared once, in the list of all of them.
    else if (event.event === 'done' && attempts.has(event.seq) && attempts.get(event.seq).tool !== 'pty') attempts.get(event.seq).ended = event.result;
  }
  return order.map(attemptOf);
}
/** The attempts of the core's JS workers (the LibreOffice probe, the winget installs) since the last look: lib/spawn-log.cjs. */
let jsRead = 0;
function jsAttempts() {
  const lines = existsSync(JS_ATTEMPTS_FILE) ? readFileSync(JS_ATTEMPTS_FILE, 'utf8').split('\n').filter(Boolean) : [];
  const fresh = lines.slice(jsRead).map((line) => JSON.parse(line));
  jsRead = lines.length;
  const attempts = new Map();
  const order = [];
  for (const line of fresh) {
    if (line.program !== undefined) {
      const attempt = { tool: toolName(line.program), argv: line.args, cwd: line.cwd, env: envDelta(line.env, replay.baseEnv), started: line.started };
      attempts.set(line.id, attempt);
      order.push(attempt);
    } else if (attempts.has(line.id)) attempts.get(line.id).ended = { code: line.exit };
  }
  return order.map(attemptOf);
}
function mapFlowIds(frame) {
  return JSON.parse(JSON.stringify(frame).replaceAll(`ghlogin_${replay.core.pid}_`, 'ghlogin_4242_'));
}

/** The desktop operations of a recording as the wire requests and outcomes the adapter must make of the core. */
function expectedWires(ops) {
  return ops
    .filter((op) => op.name !== 'notifySettingsChanged')
    .flatMap((op) => {
      const spawn = op.error?.code === 'ENOENT' ? /^spawn (\S+) ENOENT$/.exec(op.error.message) : null;
      const failed = op.error && { failed: spawn ? { capability: spawn[1] } : { message: op.error.message } };
      const request = clone(replay.routes[op.name](op.args));
      // Node's sign-in start answered the started flow. The adapter takes the flow's id from the core's start and reads the flow
      // with exactly one `github/login/status` of that id (scm-operation-route.ts SCM_REPLIES): both requests are expected, whole,
      // and each answers the flow Node answered.
      if (op.name === 'githubCliLoginStart' && !failed) {
        return [
          { ...request, outcome: { result: op.result } },
          { method: 'github/login/status', params: { flowId: op.result.flowId }, outcome: { result: op.result } },
        ];
      }
      return [{ ...request, outcome: failed || { result: op.result === undefined ? null : op.result } }];
    });
}
/** What the core answered each request of the adapter: its result, or its failure (a missing program is a missing capability). */
function actualWires(wires) {
  return mapFlowIds(
    wires.map((wire) => {
      const outcome = wire.error
        ? { failed: wire.error.capability ? { capability: wire.error.capability } : { message: wire.error.message } }
        : { result: wire.result };
      return { method: wire.method, ...(wire.params === undefined ? {} : { params: wire.params }), outcome };
    }),
  );
}
function opsDifference(ops, wires) {
  const expected = expectedWires(ops);
  const actual = actualWires(wires);
  return isDeepStrictEqual(actual, expected) ? null : { node: expected, core: actual };
}
/** A call sent as its spelled bytes makes one request of the core, `route`, the request its text stands for: it is answered
 *  with what Node's one operation answered, or refused with Node's text where Node's host refused before acting. */
function spelledDifference(recorded, route, wires) {
  assert.ok(recorded.ops.length <= 1, `${recorded.name}: a call sent as its bytes stands for one operation`);
  const outcome = recorded.ops.length ? expectedWires(recorded.ops)[0].outcome : { failed: { message: recorded.frame.error } };
  const expected = [{ ...route, outcome }];
  const actual = actualWires(wires);
  return isDeepStrictEqual(actual, expected) ? null : { node: expected, core: actual };
}

// The clock steps taken since the last call: they belong to the next call recorded (a status after the remote-list minute went by).
const pendingClock = [];
async function advanceClock(ms) {
  pendingClock.push(replay ? await replay.wire.advance(ms) : { advance: ms, ...clock.advance(ms) });
}
/** What a scenario waits for while a call is still running, with a bound on each wait: the same for Node (its virtual timers and
 *  git children) and for the core (its seam's events). */
const timeline = {
  /** A run limit of a child `match` accepts is counting. */
  armed(match, message) {
    if (!replay) {
      return withDeadline(
        new Promise((resolve) => {
          const check = () => ([...clock.timers].some((timer) => match(timer.child)) ? resolve() : clock.listeners.push(check));
          check();
        }),
        message,
      );
    }
    const { mark } = replay.current;
    return replay.wire.until(() => replay.wire.events.slice(mark).some((event) => event.event === 'armed' && match({ tool: toolName(event.child.program), argv: event.child.args })), message);
  },
  /** Every child of the call that `match` does not accept has ended (the one held is left running). */
  others(match, message) {
    if (!replay) return drainGit((argv) => match({ tool: 'git', argv }));
    const { mark, recorded } = replay.current;
    const expected = (recorded.processes ?? []).filter((entry) => !match({ tool: entry.tool, argv: entry.argv })).length;
    return replay.wire.until(() => {
      const begun = new Map();
      let ended = 0;
      for (const event of replay.wire.events.slice(mark)) {
        if (event.event === 'begin') begun.set(event.seq, { tool: toolName(event.program), argv: event.args });
        else if (event.event === 'done' && !match(begun.get(event.seq))) ended += 1;
      }
      return ended >= expected;
    }, message);
  },
};

/**
 * The ordering scenario against the core: the calls enter the connection's one shared queue together, the slow write is held
 * before its request reaches the core, and what the recording kept is compared: the calls that had started while it was held, for
 * every request what had ended before it started, the frames, and the desktop operations the adapter requested.
 */
async function replayOrdering(scenario, heldWrite) {
  const { ordering } = replay.golden;
  const known =ordering.ops.map((op) => ({ name: op.name, ...clone(replay.routes[op.name](op.args)) }));
  const nameOf = (entry) => known.find((wire) => wire.method === entry.method && JSON.stringify(wire.params) === JSON.stringify(entry.params))?.name;
  const order = [];
  const ended = [];
  let release;
  let held;
  const gate = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (held = resolve));
  replay.wires.length = 0;
  replay.holder.hold = async (entry) => {
    const name = nameOf(entry);
    assert.ok(name, `the adapter requested ${entry.method} ${JSON.stringify(entry.params)}, which no operation of the ordering recording stands for`);
    order.push({ started: name, endedBefore: [...ended] });
    if (name === heldWrite) {
      held();
      await gate;
    }
  };
  replay.holder.ended = (entry) => ended.push(nameOf(entry));
  const answers = [];
  const ctx = {};
  const calls = scenario.map(([call, params], index) =>
    replay
      .runQueued(ctx, call, clone(params), async () => replay.adapter.calls[call](clone(params), { ctx, client: replay.host.client }))
      .then(frameOf, failureFrame)
      .then((frame) => (answers[index] = frame)),
  );
  const outcome = await withDeadline(
    Promise.race([reached.then(() => 'held'), Promise.allSettled(calls).then(() => 'every call finished')]),
    `the write ${heldWrite} did not start: the shared queue stalled before reaching it`,
  );
  assert.equal(outcome, 'held', `the write ${heldWrite} never started: every call finished without reaching it`);
  const heldStarts = order.map((entry) => entry.started);
  if (!isDeepStrictEqual(heldStarts, ordering.heldStarts)) replay.differences.push({ name: 'ordering (started while the write was held)', node: ordering.heldStarts, core: heldStarts });
  release();
  await withDeadline(Promise.all(calls), `the calls behind the held write ${heldWrite} never finished`);
  replay.holder.hold = null;
  replay.holder.ended = null;
  replay.callQueueFor(ctx).close();
  // Both recorded runs of Node showed this one order (the recorder fails otherwise), so it is the order Node has.
  if (!isDeepStrictEqual(order, ordering.order)) replay.differences.push({ name: 'ordering (order of starts and ends)', node: ordering.order, core: order });
  if (!isDeepStrictEqual(answers, ordering.answers)) replay.differences.push({ name: 'ordering (frames)', node: ordering.answers, core: answers });
  const operations = opsDifference(ordering.ops, replay.wires);
  if (operations) replay.differences.push({ name: 'ordering (operations)', node: operations.node, core: operations.core });
  replay.compared.push('ordering');
}

/**
 * One phone call through the relay's frame executor (the recording) or the phone's adapter to the core (the replay). `during`, when
 * given, runs while the call is still going, with the list the call's clock steps are added to. `text`, when given, is the params'
 * own JSON text, sent as it is (a number spelled `1.0` or `1e0`, which `JSON.stringify` would print as `1`); the case keeps it as
 * `paramsText` beside the params Node parsed from it.
 */
async function rec(name, call, params, note, during, text) {
  if (replay) {
    const recorded = replay.byName.get(name);
    assert.ok(recorded, `${name} is not in the recording`);
    if (process.env.PHONE_SCM_VERBOSE) console.error('replay', name);
    replay.shims.sync();
    processes.length = 0;
    const mark = replay.wire.events.length;
    replay.current = { mark, recorded };
    replay.wires.length = 0;
    jsAttempts();
    const settingsBefore = settingsChanges.length;
    const steps = [...pendingClock];
    pendingClock.length = 0;
    // A params text is sent as its own bytes (replaySpelled); every other call goes through the phone's page.
    const spelled = text === undefined ? null : replaySpelled(call, text);
    const answered = spelled ? spelled.answered : replayCall(call, coreParams(params));
    if (during) await during(steps);
    const core = mapFlowIds(await answered);
    // The core starts gh on its own time (Node's scripted pty is synchronous): wait for each sign-in the recording started.
    replay.ptySeen += (recorded.processes ?? []).filter((entry) => entry.tool === 'pty').length;
    if (replay.ptySeen) await withDeadline(replay.shims.flow(replay.ptySeen - 1), `the core never ran gh auth login for ${name}`);
    replay.shims.sync();
    // What the core published for the desktop's windows: the events Node recorded for the call, as many as it recorded.
    const wantEvents = (recorded.events ?? []).length;
    if (wantEvents) {
      await withDeadline(
        new Promise((resolve) => {
          const seen = () => settingsChanges.length - settingsBefore >= wantEvents;
          if (seen()) return resolve();
          settingsWaiting.push(() => seen() && (resolve(), true));
        }),
        `the core never published the ${wantEvents} settings change(s) of ${name}`,
      );
    }
    // Everything the core told about the call is in by now; a read it left running when another failed first (Promise.all
    // does not cancel it) has ended, as Node's recorder waits for the git children of a call.
    await replay.wire.sync();
    await replay.wire.until(() => {
      const since = replay.wire.events.slice(mark);
      const done = new Set(since.filter((event) => event.event === 'done').map((event) => event.seq));
      const started = since.filter((event) => event.event === 'spawned' && event.started).map((event) => event.seq);
      return started.every((seq) => done.has(seq) || since.some((event) => event.event === 'begin' && event.seq === seq && event.pty));
    }, `the core left a child of ${name} running`);
    const differ = (what, node, coreSide) => {
      replay.differences.push({ name: `${name} (${what})`, node, core: coreSide });
      // A later wait that never ends loses the list printed at the end; the first difference is the one to read.
      console.error(`DIFF ${name} (${what})\n  node: ${JSON.stringify(node)}\n  core: ${JSON.stringify(coreSide)}`);
    };
    const events = settingsChanges.slice(settingsBefore);
    if (!isDeepStrictEqual(events, recorded.events ?? [])) differ('events', recorded.events ?? [], events);
    if (!isDeepStrictEqual(steps, recorded.clock ?? [])) differ('clock', recorded.clock ?? [], steps);
    // Every program the core tried to start, as Node tried them, one for one and in the order they were issued: the same
    // program, arguments and outcome (started, or could not start: spawn ENOENT) and the same end (exit code or runner error).
    const rust = coreAttempts(mark);
    const js = jsAttempts();
    assert.ok(!(rust.length && js.length), `${name}: attempts of both the core's own spawns and its JS workers are not told apart in order`);
    const wanted = nodeAttempts(recorded.processes);
    if (!isDeepStrictEqual([...rust, ...js], wanted)) differ('attempts', wanted, [...rust, ...js]);
    // The body each REST call fed the tool on stdin (`--input -`): what reached GitHub.
    const bodies = (list) => (list ?? []).filter((entry) => entry.stdin !== undefined).map(({ tool, argv, stdin }) => ({ tool, argv, stdin }));
    if (!isDeepStrictEqual(bodies(processes), bodies(recorded.processes))) differ('bodies fed to the tools', bodies(recorded.processes), bodies(processes));
    const operations = spelled ? spelledDifference(recorded, spelled.route, replay.wires) : opsDifference(recorded.ops, replay.wires);
    if (operations) differ('operations', operations.node, operations.core);
    // What the call left in the repository, read after the core's answer and every child it started ended.
    const left = repoState(R, ORIGIN);
    if (!isDeepStrictEqual(left, recorded.repository)) differ('repository', recorded.repository, left);
    const competing = takeCompeting();
    if (!isDeepStrictEqual(competing, recorded.competing ?? null)) differ('another process staging inside the refresh', recorded.competing ?? null, competing);
    replay.compared.push(name);
    if (!isDeepStrictEqual(core, recorded.frame)) replay.differences.push({ name, node: recorded.frame, core });
    return core;
  }
  if (process.env.PHONE_SCM_VERBOSE) console.error('record', name);
  covered.add(call);
  trace.length = 0;
  events.length = 0;
  processes.length = 0;
  const steps = [...pendingClock];
  pendingClock.length = 0;
  const wire = text === undefined ? JSON.parse(JSON.stringify(params)) : JSON.parse(text);
  const frameText = text === undefined ? JSON.stringify({ id: 1, method: call, params }) : `{"id":1,"method":${JSON.stringify(call)},"params":${text}}`;
  const answered = executeRemoteFrame(methods, frameText);
  if (during) await during(steps);
  const frame = await withDeadline(answered, `the call ${name} never answered`);
  await drainGit();
  const { id: _id, ...answer } = JSON.parse(JSON.stringify(frame));
  if (process.env.PHONE_SCM_VERBOSE) console.log(name, JSON.stringify(answer).slice(0, 300));
  cases.push({
    name,
    call,
    params: wire,
    ...(text === undefined ? {} : { paramsText: text }),
    ...(note ? { note } : {}),
    frame: answer,
    ops: clone(trace),
    ...(events.length ? { events: clone(events) } : {}),
    ...(processes.length ? { processes: clone(processes) } : {}),
    ...(steps.length ? { clock: clone(steps) } : {}),
    repository: repoState(R, ORIGIN),
    ...(afterOut() ? { competing: takeCompeting() } : {}),
    world: clone(world),
  });
  return answer;
}
function afterOut() {
  return existsSync(AFTER_OUT);
}
/** What the git started inside the refresh's lock window answered (exit code, stderr); null when none ran. Reading it clears it. */
function takeCompeting() {
  if (!afterOut()) return null;
  const [code, ...stderr] = readFileSync(AFTER_OUT, 'utf8').split('\n');
  rmSync(AFTER_OUT, { force: true });
  return { code: Number(code), stderr: stderr.join('\n') };
}
// ═══ 0. the argument checks of Node's host (remote-methods.ts:396-587 over ipc-validation.ts and git-contract.mjs) ═══
// The phone's page applies the same checks (the replay), and the core applies them for a caller that skips the page
// (mixdog-scm src/input.rs, whose test sends each of these cases to the core as the request the page would have made of it and
// compares its refusal, or the arguments it acts on, with Node's). A repository of their own, so no other case depends on them.
const INPUT = join(WORK, 'input');
mkdirSync(INPUT, { recursive: true });
git(INPUT, 'init', '-q', '-b', 'main');
for (const n of [1, 2, 3]) {
  write(INPUT, 'f.txt', `f${n}\n`);
  git(INPUT, 'add', '.');
  git(INPUT, 'commit', '-q', '-m', `input ${n}`);
}
const INPUT_HEAD = git(INPUT, 'rev-parse', 'HEAD').trim();
/** Records under Node's JSON text as given (a lone surrogate cannot be read by the core's JSON at all, mixdog-scm input.rs):
 *  what Node answered and the operation it invoked, kept as their JSON text so every reader of the fixture can parse it. */
const limits = [];
async function recordLimit(name, call, text, note) {
  trace.length = 0;
  processes.length = 0;
  const frame = await withDeadline(executeRemoteFrame(methods, `{"id":1,"method":${JSON.stringify(call)},"params":${text}}`), `the call ${name} never answered`);
  await drainGit();
  const { id: _id, ...answer } = frame;
  limits.push({ name, call, paramsText: text, note, recordedText: JSON.stringify({ frame: answer, ops: trace, processes }) });
}
async function recordInputChecks() {
  const I = INPUT;
  const H = INPUT_HEAD;
  // ── each argument alone given a JSON value of another type (a number where a string, a list or an object is taken, a string
  //    where a list, an object or a flag is taken); Node coerces some (a flag is `=== true`), so those calls act ──
  const wrongType = [
    ['gitStatus', [I, {}], [[0, 7]]],
    ['gitDiff', [I, 'f.txt', false, false, false], [[0, 7], [1, 7], [2, 'yes'], [3, 'yes'], [4, 'yes']]],
    ['gitApplyPatch', [I, 'f.txt', 'x', false], [[0, 7], [1, 7], [2, 7], [3, 'yes']]],
    ['gitStage', [I, ['f.txt']], [[0, 7], [1, 'f.txt']]],
    ['gitUnstage', [I, ['f.txt']], [[0, 7], [1, 'f.txt']]],
    ['gitIgnore', [I, 'f.txt', 'file'], [[0, 7], [1, 7], [2, 7]]],
    ['gitCommit', [I, 'm'], [[0, 7], [1, 7]]],
    ['gitCommitPaths', [I, 'm', ['f.txt']], [[0, 7], [1, 7], [2, 'f.txt']]],
    ['gitAmend', [I, 'm'], [[0, 7], [1, 7]]],
    ['gitUndoLastCommit', [I], [[0, 7]]],
    ['gitRevert', [I, 'f.txt', false, 'all'], [[0, 7], [1, 7], [2, 'yes'], [3, 7]]],
    ['gitReview', [I, 'branch'], [[0, 7], [1, 7]]],
    ['gitReviewDiff', [I, 'f.txt', false, 'uncommitted'], [[0, 7], [1, 7], [2, 'yes'], [3, 7]]],
    ['gitReviewDiffs', [I, [{ path: 'f.txt' }], 'uncommitted'], [[0, 7], [1, 'f.txt'], [2, 7]]],
    ['gitStash', [I, 'm'], [[0, 7], [1, 7]]],
    ['gitStashPop', [I], [[0, 7]]],
    ['gitStashList', [I], [[0, 7]]],
    ['gitStashApply', [I, 'stash@{0}'], [[0, 7], [1, 7]]],
    ['gitStashDrop', [I, 'stash@{0}'], [[0, 7], [1, 7]]],
    ['gitBranches', [I], [[0, 7]]],
    ['gitRenameBranch', [I, 'a', 'b'], [[0, 7], [1, 7], [2, 7]]],
    ['gitDeleteBranch', [I, 'a'], [[0, 7], [1, 7]]],
    ['gitCreateTag', [I, 'v', H], [[0, 7], [1, 7], [2, 7]]],
    ['gitDeleteTag', [I, 'v'], [[0, 7], [1, 7]]],
    ['gitPush', [I], [[0, 7]]],
    ['gitFetch', [I], [[0, 7]]],
    ['gitPull', [I], [[0, 7]]],
    ['gitSync', [I], [[0, 7]]],
    ['gitContinue', [I], [[0, 7]]],
    ['gitAbortOperation', [I], [[0, 7]]],
    ['gitLog', [I, '', 0, 40], [[0, 7], [1, 7], [2, {}], [3, {}]]],
    ['gitShow', [I, H], [[0, 7], [1, 7]]],
    ['gitShowDiff', [I, H, 'f.txt'], [[0, 7], [1, 7], [2, 7]]],
    ['gitRequestContext', [I, { paths: [] }], [[0, 7], [1, 'x']]],
    ['gitShowFile', [I, 'HEAD', 'f.txt'], [[0, 7], [1, 7], [2, 7]]],
    ['gitResetToCommit', [I, H, 'soft', false], [[0, 7], [1, 7], [2, 7], [3, 'yes']]],
    ['gitRevertCommit', [I, H], [[0, 7], [1, 7]]],
    ['gitCherryPickCommit', [I, H], [[0, 7], [1, 7]]],
    ['setGitGlobalConfig', ['user.name', 'v'], [[0, 7], [1, 7]]],
    ['githubRequest', [I, { action: 'pr.list', repo: 'octo/demo' }], [[0, 7], [1, 'x']]],
    ['ghPrList', [I], [[0, 7]]],
    ['ghPrDefaultBranch', [I], [[0, 7]]],
    ['ghPrView', [I, 12], [[0, 7]]],
    ['ghPrDiff', [I, 12], [[0, 7]]],
    ['ghPrCheckout', [I, 12], [[0, 7]]],
    ['ghPrCreate', [I, { base: 'main', head: 'x', title: 't' }], [[0, 7]]],
    ['ghPrMerge', [I, 12, 'merge'], [[0, 7]]],
    ['githubCliLoginStatus', ['ghlogin_unknown'], [[0, 7]]],
    ['githubCliLoginCancel', ['ghlogin_unknown'], [[0, 7]]],
    ['githubCliLoginOpenBrowser', ['ghlogin_unknown'], [[0, 7]]],
  ];
  for (const [call, valid, wrongs] of wrongType) {
    for (const [index, value] of wrongs) {
      const params = clone(valid);
      params[index] = value;
      await rec(`input-wrong-type-${call}-${index}`, call, params);
    }
  }
  // An entry of the review's file list of another type, a path of another type, an entry that is a list, a flag Node coerces.
  await rec('input-wrong-type-gitReviewDiffs-entry', 'gitReviewDiffs', [I, [7]]);
  await rec('input-wrong-type-gitReviewDiffs-entry-path', 'gitReviewDiffs', [I, [{ path: 7 }]]);
  await rec('input-wrong-type-gitReviewDiffs-entry-list', 'gitReviewDiffs', [I, [['f.txt']]]);
  await rec('input-wrong-type-gitReviewDiffs-entry-untracked', 'gitReviewDiffs', [I, [{ path: 'f.txt', untracked: 'yes' }], 'uncommitted']);
  await rec('input-wrong-type-gitRequestContext-paths', 'gitRequestContext', [I, { paths: 'x' }]);
  await rec('input-wrong-type-gitRequestContext-base', 'gitRequestContext', [I, { paths: [], base: 7 }]);
  await rec('input-wrong-type-gitRequestContext-list', 'gitRequestContext', [I, ['f.txt']]);
  // ── two invalid arguments: the first one Node's call evaluated answers (gitApplyPatch's direction and setGitGlobalConfig's value
  //    come first, remote-methods.ts:417-419, :529-532) ──
  const twoInvalid = [
    ['gitDiff', ['repo', 7]],
    ['gitApplyPatch', ['repo', 7, 7, false]],
    ['gitApplyPatch-direction', 'gitApplyPatch', ['repo', 'f.txt', '', 'yes']],
    ['gitStage', ['repo', 'f.txt']],
    ['gitUnstage', ['repo', 'f.txt']],
    ['gitIgnore', [I, '../x', 7]],
    ['gitCommit', ['repo', 7]],
    ['gitCommitPaths', [I, ' ', 'f.txt']],
    ['gitAmend', ['repo', 7]],
    ['gitRevert', [I, '../x', false, 7]],
    ['gitReview', ['repo', 7]],
    ['gitReviewDiff', [I, '../x', false, 7]],
    ['gitReviewDiffs', [I, [{ path: '../x' }], 7]],
    ['gitStash', ['repo', 7]],
    ['gitStashApply', ['repo', 7]],
    ['gitStashDrop', ['repo', 7]],
    ['gitRenameBranch', [I, '-x', 7]],
    ['gitDeleteBranch', ['repo', 7]],
    ['gitCreateTag', [I, ' ', 7]],
    ['gitDeleteTag', ['repo', 7]],
    ['gitLog', [I, 'q'.repeat(201), {}, {}]],
    ['gitLog-offset', 'gitLog', [I, '', -1, {}]],
    ['gitShow', ['repo', 7]],
    ['gitShowDiff', [I, 'zz', 7]],
    ['gitRequestContext', [I, { paths: ['../x'], base: 7 }]],
    ['gitShowFile', [I, 'main', 7]],
    ['gitResetToCommit', [I, 'zz', 7]],
    ['gitRevertCommit', ['repo', 7]],
    ['gitCherryPickCommit', ['repo', 7]],
    ['setGitGlobalConfig', [7, 7]],
    ['setGitGlobalConfig-value-first', 'setGitGlobalConfig', ['core.editor', 7]],
    ['githubRequest', ['repo', 'x']],
  ];
  for (const entry of twoInvalid) {
    const [label, call, params] = entry.length === 3 ? entry : [entry[0], entry[0], entry[1]];
    await rec(`input-two-invalid-${label}`, call, params);
  }
  // ── an explicit null where Node takes a missing argument as the default and refuses null; the missing ones beside them ──
  await rec('input-null-gitRevert-mode', 'gitRevert', [I, 'f.txt', false, null]);
  await rec('input-missing-gitRevert-mode', 'gitRevert', [I, 'f.txt', false]);
  await rec('input-null-gitIgnore-scope', 'gitIgnore', [I, 'f.txt', null]);
  await rec('input-null-gitReview-source', 'gitReview', [I, null]);
  await rec('input-missing-gitReview-source', 'gitReview', [I]);
  await rec('input-null-gitReviewDiff-source', 'gitReviewDiff', [I, 'f.txt', false, null]);
  await rec('input-missing-gitReviewDiff-source', 'gitReviewDiff', [I, 'f.txt', false]);
  await rec('input-null-gitReviewDiffs-source', 'gitReviewDiffs', [I, [{ path: 'f.txt' }], null]);
  await rec('input-missing-gitReviewDiffs-source', 'gitReviewDiffs', [I, [{ path: 'f.txt' }]]);
  await rec('input-null-gitRequestContext-base', 'gitRequestContext', [I, { paths: [], base: null }]);
  await rec('input-missing-gitRequestContext-base', 'gitRequestContext', [I, { paths: [] }]);
  await rec('input-null-gitLog-arguments', 'gitLog', [I, null, null, null]);
  // ── numbers: `Number(value)`, then the integer and range checks ──
  const numbers = [
    ['offset-string', '"1"', '40'],
    ['offset-true', 'true', '40'],
    ['offset-list', '[1]', '40'],
    ['offset-list-of-string', '["1"]', '40'],
    ['limit-list-of-string', '0', '["2"]'],
    ['offset-false', 'false', '40'],
    ['offset-empty', '""', '40'],
    ['offset-space', '" "', '40'],
    ['offset-empty-list', '[]', '40'],
    ['offset-hex', '"0x1"', '40'],
    ['offset-decimal-point', '1.0', '40'],
    ['offset-exponent', '1e0', '40'],
    ['offset-minus-zero', '-0', '40'],
    ['limit-string', '0', '"2"'],
    ['limit-true', '0', 'true'],
    ['limit-list', '0', '[2]'],
    ['limit-hex', '0', '"0x10"'],
    ['limit-decimal-point', '0', '2.0'],
    ['limit-exponent', '0', '2e0'],
    ['offset-fraction', '1.5', '40'],
    ['offset-word', '"abc"', '40'],
    ['offset-object', '{}', '40'],
    ['offset-two-items', '[1,2]', '40'],
    ['offset-past-the-limit-string', '"1e7"', '40'],
    ['offset-infinity', '"Infinity"', '40'],
    ['limit-zero-string', '0', '"0"'],
    ['limit-empty-list', '0', '[]'],
    ['limit-false', '0', 'false'],
    ['limit-empty', '0', '""'],
    ['limit-fraction', '0', '2.5'],
  ];
  for (const [label, skip, limit] of numbers) {
    const text = `[${JSON.stringify(I)},"",${skip},${limit}]`;
    await rec(`input-number-gitLog-${label}`, 'gitLog', JSON.parse(text), undefined, undefined, text);
  }
  // ── the global config key: one of three exact strings ──
  for (const [label, key] of [['number', 7], ['null', null], ['padded', ' user.name '], ['upper-case', 'USER.NAME'], ['unknown', 'core.editor']]) {
    await rec(`input-config-key-${label}`, 'setGitGlobalConfig', [key, 'v']);
  }
  // ── the directory: a string, trimmed of JavaScript white space, absolute by Windows' rule. A directory that passes is followed
  //    by a path that does not, so no call acts; the text says which of the two was refused ──
  const spellings = [
    ['drive-relative', 'C:foo'],
    ['drive-only', 'C:'],
    ['backslash-rooted', '\\foo'],
    ['slash-rooted', '/foo'],
    ['unc', '\\\\host\\share'],
    ['unc-slashes', '//host/share'],
    ['verbatim', '\\\\?\\C:\\x'],
    ['relative', 'foo'],
    ['dot-relative', './foo'],
    ['spaces-around', '  /foo  '],
    ['tab-and-newline', '\t/foo\n'],
    ['no-break-space', '\u00a0/foo'],
    ['byte-order-mark', '\ufeff/foo'],
    ['next-line', '\u0085/foo'],
    ['line-separator', '\u2028/foo'],
    ['blank', '   '],
    ['empty', ''],
    ['null', null],
  ];
  for (const [label, cwd] of spellings) await rec(`input-cwd-${label}`, 'gitDiff', [cwd, '../x']);
  await rec('input-cwd-trimmed-and-acted-on', 'gitStatus', [`  ${I}\t`]);
  // A write, whose request the core serializes per repository: on the directory Node acted on, the trimmed one.
  await rec('input-cwd-trimmed-and-staged', 'gitStage', [` ${I} `, ['f.txt']]);
  // ── the flow id of a sign-in: a string of at most 200 units, trimmed ──
  for (const [label, flowId] of [['blank', ' '], ['long', 'x'.repeat(201)], ['null', null], ['padded-unknown', ' ghlogin_unknown ']]) {
    await rec(`input-flow-id-${label}`, 'githubCliLoginStatus', [flowId]);
  }
  // ── the GitHub request is checked before the Git & GitHub gate (which is shut here) ──
  await rec('input-githubRequest-unknown-action-gate-off', 'githubRequest', [I, { action: 'repo.delete' }]);
  await rec('input-githubRequest-relative-cwd-gate-off', 'githubRequest', ['repo', { action: 'pr.list', repo: 'octo/demo' }]);
  // ── what the reviews found earlier (arguments Node's host refuses before it acts) ──
  const refused = [
    ['gitReviewDiff-path-climbs-out', 'gitReviewDiff', [I, '../outside.txt', true]],
    ['gitReviewDiffs-path-climbs-out', 'gitReviewDiffs', [I, [{ path: 'sub\\..\\..\\outside.txt', untracked: true }]]],
    ['gitReviewDiffs-entry-not-an-object', 'gitReviewDiffs', [I, ['f.txt']]],
    ['gitDiff-absolute-path', 'gitDiff', [I, 'C:\\outside\\x.txt', false, false, true]],
    ['gitDiff-path-with-nul', 'gitDiff', [I, 'f\0.txt', false, false, false]],
    ['gitStage-no-paths', 'gitStage', [I, []]],
    ['gitStage-path-climbs-out', 'gitStage', [I, ['a/../../b.txt']]],
    ['gitUnstage-absolute-path', 'gitUnstage', [I, ['/etc/passwd']]],
    ['gitCommitPaths-path-climbs-out', 'gitCommitPaths', [I, 'message', ['..']]],
    ['gitCommit-blank-message', 'gitCommit', [I, '   ']],
    ['gitRevert-path-climbs-out', 'gitRevert', [I, '../outside.txt', true, 'all']],
    ['gitRevert-unknown-mode', 'gitRevert', [I, 'f.txt', false, 'everything']],
    ['gitApplyPatch-empty-patch', 'gitApplyPatch', [I, 'f.txt', '']],
    ['gitIgnore-unknown-scope', 'gitIgnore', [I, 'f.txt', 'folder']],
    ['gitIgnore-path-climbs-out', 'gitIgnore', [I, '../x', 'file']],
    ['gitRenameBranch-option-as-name', 'gitRenameBranch', [I, 'main', '-D']],
    ['gitDeleteBranch-option-as-name', 'gitDeleteBranch', [I, '--force']],
    ['gitDeleteBranch-two-lines', 'gitDeleteBranch', [I, 'a\nb']],
    ['gitCreateTag-blank-tag', 'gitCreateTag', [I, ' ', H]],
    ['gitCreateTag-not-a-hash', 'gitCreateTag', [I, 'v1', 'HEAD']],
    ['gitShow-not-a-hash', 'gitShow', [I, 'main']],
    ['gitShowDiff-not-a-hash', 'gitShowDiff', [I, 'zzzz', 'f.txt']],
    ['gitShowDiff-path-climbs-out', 'gitShowDiff', [I, H, '../x']],
    ['gitShowFile-not-a-revision', 'gitShowFile', [I, 'HEAD~1', 'f.txt']],
    ['gitShowFile-blank-revision', 'gitShowFile', [I, ' ', 'f.txt']],
    ['gitResetToCommit-unknown-mode', 'gitResetToCommit', [I, H, 'keep']],
    ['gitRevertCommit-not-a-hash', 'gitRevertCommit', [I, '--no-edit']],
    ['gitCherryPickCommit-not-a-hash', 'gitCherryPickCommit', [I, 'abc']],
    ['gitLog-long-query', 'gitLog', [I, 'q'.repeat(201)]],
    ['gitLog-offset-over-the-limit', 'gitLog', [I, '', 1_000_001]],
    ['gitLog-limit-over-the-limit', 'gitLog', [I, '', 0, 101]],
    ['gitLog-limit-zero', 'gitLog', [I, '', 0, 0]],
    ['gitReview-unknown-source', 'gitReview', [I, 'staged']],
    ['gitStash-message-with-nul', 'gitStash', [I, 'wip\0']],
    ['gitAmend-long-message', 'gitAmend', [I, 'm'.repeat(20_001)]],
    ['gitStashApply-long-ref', 'gitStashApply', [I, 's'.repeat(65)]],
    ['gitStashDrop-blank-ref', 'gitStashDrop', [I, '']],
    ['gitRequestContext-path-climbs-out', 'gitRequestContext', [I, { paths: ['../x'] }]],
    ['gitRequestContext-option-as-base', 'gitRequestContext', [I, { paths: [], base: '-x' }]],
    ['setGitGlobalConfig-long-value', 'setGitGlobalConfig', ['user.name', 'v'.repeat(501)]],
  ];
  for (const [name, call, params] of refused) await rec(`refused-${name}`, call, params);
  // ── a lone surrogate in a string: Node's string checks take it; the core cannot decode it into a string at all ──
  if (!replay) await recordLimit('lone-surrogate-gitLog-query', 'gitLog', `[${JSON.stringify(I)},"\\ud800"]`, 'A JSON string escape of a lone surrogate (\\ud800) is a string to Node, which checks it as any other and acts on it; the core reads every frame into Rust strings, which cannot hold it, so its frame decoder closes the connection (1007) before any check runs. An open difference of the whole core.');
}
await recordInputChecks();
if (ONLY !== null) {
  if (replay) await finishReplay();
  writeJson(ONLY_OUT, { group: ONLY, realGit: realGitVersion, cases, limits });
  await withDeadline(operations.dispose(), "Node's desktop operations never finished disposing");
  scripted.restore();
  console.log(`phone-scm --only ${ONLY}: ${cases.length} cases written to ${ONLY_OUT}`);
  process.exit(0);
}

// ═══ 1. status and diff ═══
write(R, 'a.txt', 'one\nTWO\nthree\nfour\nfive\n');
write(R, 'src/b.mjs', 'export const b = 2;\n');
git(R, 'add', 'src/b.mjs');
write(R, 'new.txt', 'untracked\n');
const HEAD = rev('HEAD');
await rec('gitStatus', 'gitStatus', [R]);
await rec('gitStatus-skipLineStats', 'gitStatus', [R, { skipLineStats: true }]);
await rec('gitStatus-reuseLineStats', 'gitStatus', [R, { reuseLineStats: true, skipLineStats: false }]);
await rec('gitStatus-options-not-object', 'gitStatus', [R, 'x']);
await rec('gitStatus-not-a-repository', 'gitStatus', [PLAIN]);
// A destructive step in a folder that is no repository stops at its first git command; the clean-tree guard is never reached.
await rec('gitReviewDiff-not-a-repository', 'gitReviewDiff', [PLAIN, 'a.txt', false, 'uncommitted']);
await rec('gitBranches-not-a-repository', 'gitBranches', [PLAIN]);
await rec('gitStash-not-a-repository', 'gitStash', [PLAIN, 'wip']);
await rec('gitStashList-not-a-repository', 'gitStashList', [PLAIN]);
await rec('gitFetch-not-a-repository', 'gitFetch', [PLAIN]);
await rec('gitUndoLastCommit-not-a-repository', 'gitUndoLastCommit', [PLAIN]);
await rec('gitResetToCommit-not-a-repository', 'gitResetToCommit', [PLAIN, '0123456789abcdef', 'hard', false]);
await rec('gitCherryPickCommit-not-a-repository', 'gitCherryPickCommit', [PLAIN, '0123456789abcdef']);
await rec('gitStatus-relative-cwd', 'gitStatus', ['repo']);
await rec('gitStatus-no-params', 'gitStatus', []);
await rec('gitDiff-unstaged', 'gitDiff', [R, 'a.txt', false]);
await rec('gitDiff-staged', 'gitDiff', [R, 'src/b.mjs', true]);
await rec('gitDiff-untracked', 'gitDiff', [R, 'new.txt', false, false, true]);
await rec('gitDiff-worktree-only', 'gitDiff', [R, 'src/b.mjs', false, true]);
await rec('gitDiff-parent-path', 'gitDiff', [R, '../x', false]);
await rec('gitDiff-absolute-path', 'gitDiff', [R, 'C:\\x', false]);
await rec('gitDiff-no-path', 'gitDiff', [R]);
await rec('gitLog', 'gitLog', [R]);
await rec('gitLog-query', 'gitLog', [R, 'second', 0, 40]);
await rec('gitLog-paged', 'gitLog', [R, '', 1, 1]);
await rec('gitLog-bad-limit', 'gitLog', [R, '', 0, 0]);
await rec('gitLog-bad-offset', 'gitLog', [R, '', -1, 10]);
await rec('gitLog-bad-query', 'gitLog', [R, 5]);
await rec('gitShow', 'gitShow', [R, HEAD]);
await rec('gitShow-short-hash', 'gitShow', [R, HEAD.slice(0, 7)]);
await rec('gitShow-bad-hash', 'gitShow', [R, 'zz']);
await rec('gitShow-unknown-hash', 'gitShow', [R, '0123456789abcdef']);
await rec('gitShowDiff', 'gitShowDiff', [R, HEAD, 'a.txt']);
await rec('gitShowDiff-bad-path', 'gitShowDiff', [R, HEAD, '..\\a.txt']);
await rec('gitShowFile-head', 'gitShowFile', [R, 'HEAD', 'a.txt']);
await rec('gitShowFile-index', 'gitShowFile', [R, ':0', 'src/b.mjs']);
await rec('gitShowFile-parent', 'gitShowFile', [R, `${HEAD}^`, 'a.txt']);
await rec('gitShowFile-missing', 'gitShowFile', [R, 'HEAD', 'nope.txt']);
await rec('gitShowFile-bad-rev', 'gitShowFile', [R, 'main', 'a.txt']);
await rec('gitReview', 'gitReview', [R]);
await rec('gitReview-uncommitted', 'gitReview', [R, 'uncommitted']);
await rec('gitReview-bad-source', 'gitReview', [R, 'turn']);
await rec('gitReviewDiff', 'gitReviewDiff', [R, 'a.txt', false, 'uncommitted']);
await rec('gitReviewDiff-untracked', 'gitReviewDiff', [R, 'new.txt', true, 'uncommitted']);
await rec('gitReviewDiff-branch', 'gitReviewDiff', [R, 'a.txt', false]);
await rec('gitReviewDiffs', 'gitReviewDiffs', [R, [{ path: 'a.txt' }, { path: 'new.txt', untracked: true }], 'uncommitted']);
await rec('gitReviewDiffs-bad-files', 'gitReviewDiffs', [R, 'a.txt']);
// Names no patch can be served for (a quote and a backslash in a file name) among a file that has one.
await rec('gitReviewDiffs-odd-names', 'gitReviewDiffs', [R, [{ path: 'we"ird.txt' }, { path: 'a.txt' }, { path: 'back\\slash.txt' }], 'uncommitted']);
await rec('gitRequestContext', 'gitRequestContext', [R, { paths: ['a.txt', 'src/b.mjs'], base: 'feature' }]);
await rec('gitRequestContext-no-base', 'gitRequestContext', [R, { paths: [] }]);
await rec('gitRequestContext-bad-input', 'gitRequestContext', [R, ['a.txt']]);
await rec('gitGlobalConfig-empty', 'gitGlobalConfig', []);
await rec('setGitGlobalConfig-name', 'setGitGlobalConfig', ['user.name', ' Phone Dev ']);
await rec('setGitGlobalConfig-email', 'setGitGlobalConfig', ['user.email', 'phone@example.invalid']);
await rec('setGitGlobalConfig-default-branch', 'setGitGlobalConfig', ['init.defaultBranch', 'trunk']);
await rec('setGitGlobalConfig-unset', 'setGitGlobalConfig', ['init.defaultBranch', '']);
await rec('setGitGlobalConfig-unset-twice', 'setGitGlobalConfig', ['init.defaultBranch', '']);
await rec('setGitGlobalConfig-bad-key', 'setGitGlobalConfig', ['core.editor', 'vim']);
await rec('setGitGlobalConfig-bad-value', 'setGitGlobalConfig', ['user.name', 7]);
await rec('setGitGlobalConfig-long-value', 'setGitGlobalConfig', ['user.name', 'x'.repeat(501)]);
await rec('gitGlobalConfig', 'gitGlobalConfig', []);
await rec('gitCliStatus', 'gitCliStatus', []);

// ═══ 2. staging and commit ═══
await rec('gitStage', 'gitStage', [R, ['a.txt']]);
await rec('gitStage-empty', 'gitStage', [R, []]);
await rec('gitStage-bad-path', 'gitStage', [R, ['../a.txt']]);
await rec('gitUnstage', 'gitUnstage', [R, ['a.txt']]);
await rec('gitUnstage-not-an-array', 'gitUnstage', [R, 'a.txt']);
await rec('gitIgnore-file', 'gitIgnore', [R, 'new.txt', 'file']);
await rec('gitIgnore-extension', 'gitIgnore', [R, 'cache.tmp', 'extension']);
await rec('gitIgnore-default-scope', 'gitIgnore', [R, 'other.txt']);
await rec('gitIgnore-bad-scope', 'gitIgnore', [R, 'new.txt', 'dir']);
git(R, 'add', '.gitignore');
git(R, 'commit', '-q', '-m', 'ignore rules', '--', '.gitignore');
await rec('gitCommit-blank-message', 'gitCommit', [R, '   ']);
await rec('gitCommit', 'gitCommit', [R, 'Commit the staged b']);
await rec('gitCommit-nothing-staged', 'gitCommit', [R, 'Nothing to commit']);
await rec('gitCommitPaths', 'gitCommitPaths', [R, 'Edit a through paths', ['a.txt']]);
await rec('gitCommitPaths-no-paths', 'gitCommitPaths', [R, 'No paths', []]);
// The repository named in its verbatim (`\\?\`) spelling: Node compares the paths as strings after resolve().
await rec('gitCommitPaths-verbatim-cwd', 'gitCommitPaths', ['\\\\?\\' + R, 'Verbatim cwd', ['a.txt']]);
// Another process stages a file while the commit refreshes the index: git refuses it (index.lock is held until the refresh
// publishes), so the commit and the staged index both stay whole. The competing git is the shim's (lib/scripted-tool.rs).
write(R, 'compete.txt', 'committed\n');
write(R, 'other.txt', 'staged by another process\n');
writeFileSync(AFTER_FILE, `reset --quiet\nadd other.txt\n${AFTER_OUT}\n`);
await rec('gitCommitPaths-competing-stage', 'gitCommitPaths', [R, 'Commit while another process stages', ['compete.txt']]);
rmSync(AFTER_FILE, { force: true });
write(R, 'a.txt', 'one\nTWO\nthree\nfour\nfive\nsix\n');
git(R, 'add', 'a.txt');
await rec('gitAmend-message', 'gitAmend', [R, 'Edit a through paths (amended)']);
await rec('gitAmend-keep-message', 'gitAmend', [R]);
await rec('gitAmend-bad-message', 'gitAmend', [R, 5]);
await rec('gitUndoLastCommit', 'gitUndoLastCommit', [R]);
await rec('gitRevert-file', 'gitRevert', [R, 'a.txt', false, 'all']);
write(R, 'scratch.txt', 'scratch\n');
await rec('gitRevert-untracked', 'gitRevert', [R, 'scratch.txt', true]);
write(R, 'a.txt', 'one\nTWO\nthree\nfour\nseven\n');
git(R, 'add', 'a.txt');
write(R, 'a.txt', 'one\nTWO\nthree\nfour\nseven\neight\n');
await rec('gitRevert-worktree-only', 'gitRevert', [R, 'a.txt', false, 'worktree']);
await rec('gitRevert-bad-mode', 'gitRevert', [R, 'a.txt', false, 'index']);
git(R, 'reset', '-q', '--hard', 'HEAD');
write(R, 'a.txt', 'one\nTWO\nthree\nfour\npatched\n');
const patch = git(R, 'diff', '--', 'a.txt');
git(R, 'checkout', '--', 'a.txt');
await rec('gitApplyPatch', 'gitApplyPatch', [R, 'a.txt', patch, false]);
await rec('gitApplyPatch-reverse', 'gitApplyPatch', [R, 'a.txt', patch, true]);
await rec('gitApplyPatch-garbage', 'gitApplyPatch', [R, 'a.txt', 'not a patch\n', false]);
await rec('gitApplyPatch-bad-direction', 'gitApplyPatch', [R, 'a.txt', patch, 'yes']);
await rec('gitApplyPatch-empty', 'gitApplyPatch', [R, 'a.txt', '', false]);
git(R, 'reset', '-q', '--hard', 'HEAD');
write(R, 'm.txt', 'm1\n');
git(R, 'add', 'm.txt');
git(R, 'commit', '-q', '-m', 'add m');
const C1 = rev('HEAD');
write(R, 'm.txt', 'm1\nm2\n');
git(R, 'commit', '-q', '-am', 'edit m');
const C2 = rev('HEAD');
await rec('gitResetToCommit-soft', 'gitResetToCommit', [R, C1, 'soft', false]);
git(R, 'commit', '-q', '-m', 'edit m again');
const C3 = rev('HEAD');
write(R, 'src/b.mjs', 'export const b = 3;\n');
await rec('gitResetToCommit-hard-dirty-unconfirmed', 'gitResetToCommit', [R, C1, 'hard', false]);
await rec('gitResetToCommit-hard-dirty-confirmed', 'gitResetToCommit', [R, C1, 'hard', true]);
await rec('gitResetToCommit-bad-mode', 'gitResetToCommit', [R, C1, 'keep', false]);
write(R, 'src/b.mjs', 'export const b = 4;\n');
await rec('gitResetToCommit-mixed-dirty-unconfirmed', 'gitResetToCommit', [R, C3, 'mixed', false]);
await rec('gitResetToCommit-mixed-dirty-confirmed', 'gitResetToCommit', [R, C3, 'mixed', true]);
git(R, 'reset', '-q', '--hard', C3);
await rec('gitRevertCommit', 'gitRevertCommit', [R, C3]);
await rec('gitRevertCommit-unknown', 'gitRevertCommit', [R, '0123456789abcdef']);
git(R, 'checkout', '-q', 'feature');
write(R, 'f.txt', 'from feature\n');
git(R, 'add', 'f.txt');
git(R, 'commit', '-q', '-m', 'feature file');
const F1 = rev('HEAD');
write(R, 'a.txt', 'feature edits a\n');
git(R, 'commit', '-q', '-am', 'feature edits a');
const F2 = rev('HEAD');
git(R, 'checkout', '-q', 'main');
await rec('gitCherryPickCommit', 'gitCherryPickCommit', [R, F1]);
write(R, 'a.txt', 'main edits a\n');
git(R, 'commit', '-q', '-am', 'main edits a');
await rec('gitCherryPickCommit-conflict', 'gitCherryPickCommit', [R, F2]);
await rec('gitContinue-unresolved', 'gitContinue', [R]);
await rec('gitAbortOperation', 'gitAbortOperation', [R]);
await rec('gitAbortOperation-nothing', 'gitAbortOperation', [R]);
await rec('gitContinue-nothing', 'gitContinue', [R]);
await rec('gitCherryPickCommit-conflict-again', 'gitCherryPickCommit', [R, F2]);
write(R, 'a.txt', 'resolved\n');
git(R, 'add', 'a.txt');
await rec('gitContinue-resolved', 'gitContinue', [R]);

// ═══ 3. branches and tags ═══
git(R, 'branch', 'topic');
git(R, 'branch', 'unmerged', F1);
git(R, 'checkout', '-q', 'unmerged');
write(R, 'u.txt', 'unmerged work\n');
git(R, 'add', 'u.txt');
git(R, 'commit', '-q', '-m', 'unmerged work');
git(R, 'checkout', '-q', 'main');
await rec('gitBranches', 'gitBranches', [R]);
await rec('gitRenameBranch', 'gitRenameBranch', [R, 'topic', 'topic2']);
await rec('gitRenameBranch-bad-name', 'gitRenameBranch', [R, 'topic2', '-x']);
await rec('gitRenameBranch-existing', 'gitRenameBranch', [R, 'topic2', 'feature']);
await rec('gitDeleteBranch', 'gitDeleteBranch', [R, 'topic2']);
await rec('gitDeleteBranch-current', 'gitDeleteBranch', [R, 'main']);
await rec('gitDeleteBranch-unmerged', 'gitDeleteBranch', [R, 'unmerged']);
await rec('gitDeleteBranch-missing', 'gitDeleteBranch', [R, 'nope']);
const TAGGED = rev('HEAD');
await rec('gitCreateTag', 'gitCreateTag', [R, 'v1.0', TAGGED]);
await rec('gitCreateTag-duplicate', 'gitCreateTag', [R, 'v1.0', TAGGED]);
await rec('gitCreateTag-bad-hash', 'gitCreateTag', [R, 'v2.0', 'main']);
await rec('gitDeleteTag', 'gitDeleteTag', [R, 'v1.0']);
await rec('gitDeleteTag-missing', 'gitDeleteTag', [R, 'v1.0']);
await rec('gitBranches-after', 'gitBranches', [R]);

// ═══ 4. stash ═══
write(R, 'a.txt', 'stash me\n');
write(R, 'stashed-new.txt', 'new\n');
git(R, 'add', 'stashed-new.txt');
await rec('gitStash', 'gitStash', [R, 'wip from phone']);
await rec('gitStashList', 'gitStashList', [R]);
await rec('gitStash-nothing', 'gitStash', [R]);
await rec('gitStashApply', 'gitStashApply', [R, 'stash@{0}']);
await rec('gitStashApply-bad-ref', 'gitStashApply', [R, 'stash@{9}']);
await rec('gitStashApply-not-a-string', 'gitStashApply', [R, 3]);
git(R, 'reset', '-q', '--hard', 'HEAD');
git(R, 'clean', '-q', '-fd');
await rec('gitStashPop', 'gitStashPop', [R]);
await rec('gitStashPop-empty', 'gitStashPop', [R]);
git(R, 'stash', 'push', '-q', '-m', 'second stash');
await rec('gitStashDrop', 'gitStashDrop', [R, 'stash@{0}']);
await rec('gitStashDrop-missing', 'gitStashDrop', [R, 'stash@{0}']);
await rec('gitStashList-empty', 'gitStashList', [R]);
git(R, 'reset', '-q', '--hard', 'HEAD');
git(R, 'clean', '-q', '-fd');

// ═══ 5. the remote ═══
// The repository without a remote: Node answers 'remote' from a read it keeps for 60 s per directory and never drops earlier
// (git-status.ts:179-207, TTL git-read-utils.ts:6), so a remote added right after a status shows only once that minute has
// passed. Node's clock is virtual: the recorder moves Date.now past the TTL, and moves the built core's cache clock by the same
// amount through its debug seam. These cases have a repository of their own, so nothing else's status depends on the minute.
const TEMP = join(WORK, 'bare-repo');
mkdirSync(TEMP, { recursive: true });
git(TEMP, 'init', '-q', '-b', 'main');
write(TEMP, 't.txt', 't\n');
git(TEMP, 'add', '.');
git(TEMP, 'commit', '-q', '-m', 'first');
await rec('gitPush-no-remote', 'gitPush', [TEMP]);
await rec('gitFetch-no-remote', 'gitFetch', [TEMP]);
await rec('gitPull-no-remote', 'gitPull', [TEMP]);
await rec('gitSync-no-remote', 'gitSync', [TEMP]);
await rec('gitStatus-before-remote-add', 'gitStatus', [TEMP]);
git(TEMP, 'remote', 'add', 'origin', ORIGIN);
await rec('gitStatus-remote-just-added', 'gitStatus', [TEMP]);
// Node keeps a remote list while `expiresAt > Date.now()`: one ms short of the minute it is still the old list, at the minute it is read again.
await advanceClock(59_999);
await rec('gitStatus-remote-before-ttl', 'gitStatus', [TEMP]);
await advanceClock(1);
await rec('gitStatus-remote-at-ttl', 'gitStatus', [TEMP]);
// And past it, on a repository whose first read is that far behind.
const LATE = join(WORK, 'late-remote');
mkdirSync(LATE, { recursive: true });
git(LATE, 'init', '-q', '-b', 'main');
write(LATE, 't.txt', 't\n');
git(LATE, 'add', '.');
git(LATE, 'commit', '-q', '-m', 'first');
await rec('gitStatus-late-before-remote-add', 'gitStatus', [LATE]);
git(LATE, 'remote', 'add', 'origin', ORIGIN);
await advanceClock(60_001);
await rec('gitStatus-remote-after-ttl', 'gitStatus', [LATE]);
await rec('gitPush-no-upstream', 'gitPush', [R]);
git(R, 'push', '-q', '-u', 'origin', 'main');
await rec('gitPush-up-to-date', 'gitPush', [R]);
write(R, 'local1.txt', 'local one\n');
git(R, 'add', 'local1.txt');
git(R, 'commit', '-q', '-m', 'local one');
await rec('gitPush-ahead', 'gitPush', [R]);
git(WORK, 'clone', '-q', ORIGIN, OTHER);
write(OTHER, 'remote1.txt', 'remote one\n');
git(OTHER, 'add', 'remote1.txt');
git(OTHER, 'commit', '-q', '-m', 'remote one');
git(OTHER, 'push', '-q', 'origin', 'main');
await rec('gitFetch', 'gitFetch', [R]);
await rec('gitStatus-behind', 'gitStatus', [R]);
await rec('gitPull', 'gitPull', [R]);
write(R, 'local2.txt', 'local two\n');
git(R, 'add', 'local2.txt');
git(R, 'commit', '-q', '-m', 'local two');
write(OTHER, 'remote2.txt', 'remote two\n');
git(OTHER, 'add', 'remote2.txt');
git(OTHER, 'commit', '-q', '-m', 'remote two');
git(OTHER, 'push', '-q', 'origin', 'main');
await rec('gitPush-rejected', 'gitPush', [R]);
await rec('gitSync', 'gitSync', [R]);
await rec('gitSync-up-to-date', 'gitSync', [R]);
write(R, 'local3.txt', 'local three\n');
git(R, 'add', 'local3.txt');
git(R, 'commit', '-q', '-m', 'local three');
write(OTHER, 'local3.txt', 'conflicting three\n');
git(OTHER, 'add', 'local3.txt');
git(OTHER, 'commit', '-q', '-m', 'remote three');
git(OTHER, 'pull', '-q', '--no-rebase', 'origin', 'main', '--no-edit', '--allow-unrelated-histories');
git(OTHER, 'push', '-q', 'origin', 'main');
await rec('gitPull-conflict', 'gitPull', [R]);
await rec('gitAbortOperation-merge', 'gitAbortOperation', [R]);
await rec('gitPull-bad-cwd', 'gitPull', ['']);

// ═══ 6. GitHub: the CLI is not installed yet ═══
await rec('githubCliStatus-not-installed', 'githubCliStatus', []);
await rec('githubStarStatus-no-gh', 'githubStarStatus', []);
await rec('githubCliAccount-not-installed', 'githubCliAccount', []);
await rec('githubCliLogout-not-installed', 'githubCliLogout', []);
await rec('githubCliLoginStart-not-installed', 'githubCliLoginStart', []);
await rec('ghPrList-not-installed', 'ghPrList', [R]);
await rec('ghPrDefaultBranch-not-installed', 'ghPrDefaultBranch', [R]);
await rec('githubCliLoginCancel-not-installed', 'githubCliLoginCancel', ['no-such-flow']);
await rec('starGithub-no-gh', 'starGithub', []);
world.wingetMissing = true;
await rec('installGithubCli-no-winget', 'installGithubCli', []);
world.wingetMissing = false;
world.wingetFails = true;
await rec('installGithubCli-winget-fails', 'installGithubCli', []);
world.wingetFails = false;
world.wingetInstallsGh = false;
await rec('installGithubCli-not-found-after', 'installGithubCli', []);
world.wingetInstallsGh = true;
await rec('installGithubCli', 'installGithubCli', []);
await rec('githubCliStatus-signed-out', 'githubCliStatus', []);
await rec('githubCliAccount-signed-out', 'githubCliAccount', []);
await rec('githubCliLogout-signed-out', 'githubCliLogout', []);
await rec('githubStarStatus-not-starred', 'githubStarStatus', []);
await rec('starGithub', 'starGithub', []);
await rec('githubStarStatus-starred', 'githubStarStatus', []);
world.ghApiDown = true;
await rec('starGithub-api-down', 'starGithub', []);
await rec('githubStarStatus-api-down', 'githubStarStatus', []);
world.ghApiDown = false;

// Sign-in: gh's device flow through a PTY (a scripted one). A flow's code appears when gh prints it; a flow ends when gh exits.
const started = await rec('githubCliLoginStart', 'githubCliLoginStart', []);
if (replay && !started.ok) throw new Error(`the core did not start the sign-in: ${JSON.stringify(started)}`);
const flowId = started.value.flowId;
await watchFlow(flowId);
await rec('githubCliLoginStatus-pending', 'githubCliLoginStatus', [flowId]);
const first = await flowOf(0);
first.print('! First copy your one-time code: ABCD-1234\nPress Enter to open github.com in your browser...\n');
await settled(flowId, (state) => state?.code);
await rec('githubCliLoginStatus-code', 'githubCliLoginStatus', [flowId]);
// The flow id is trimmed before it is looked up (requiredString, remote-methods.ts:571-572).
await rec('githubCliLoginStatus-padded-flow-id', 'githubCliLoginStatus', [` ${flowId}\t`]);
first.print('Open https://github.com/login/device in your browser\n');
await settled(flowId, (state) => state?.url);
await rec('githubCliLoginOpenBrowser', 'githubCliLoginOpenBrowser', [flowId, { openBrowser: false }]);
await rec('githubCliLoginOpenBrowser-no-options', 'githubCliLoginOpenBrowser', [flowId]);
await rec('githubCliLoginOpenBrowser-bad-options', 'githubCliLoginOpenBrowser', [flowId, 'yes']);
await rec('githubCliLoginOpenBrowser-unknown-flow', 'githubCliLoginOpenBrowser', ['ghlogin_unknown']);
await rec('githubCliLoginStatus-unknown-flow', 'githubCliLoginStatus', ['ghlogin_unknown']);
await rec('githubCliLoginStatus-bad-flow-id', 'githubCliLoginStatus', [7]);
await rec('githubCliLoginCancel', 'githubCliLoginCancel', [flowId]);
await rec('githubCliLoginStatus-cancelled', 'githubCliLoginStatus', [flowId]);
await rec('githubCliLoginCancel-unknown-flow', 'githubCliLoginCancel', [flowId]);

const second = await rec('githubCliLoginStart-again', 'githubCliLoginStart', []);
await watchFlow(second.value.flowId);
const secondFlow = await flowOf(1);
secondFlow.print('First copy your one-time code: WXYZ-9876\nhttps://github.com/login/device\n');
// gh exits 0 once the browser step is done; Node then reads `gh auth status` and runs `gh auth setup-git`. The sign-in is
// complete when that command returns: the scripted runner is Node's `exec()` seam and says so by the scripted rule's own reply.
world.ghAuth = true;
const setupDone = new Promise((resolve) => {
  setupSettled = resolve;
});
secondFlow.exit(0);
if (replay) await settled(second.value.flowId, (state) => !['pending', 'code'].includes(state?.state));
else await withDeadline(setupDone, 'the sign-in never finished gh auth setup-git');
await rec('githubCliLoginStatus-success', 'githubCliLoginStatus', [second.value.flowId]);
const third = await rec('githubCliLoginStart-third', 'githubCliLoginStart', []);
await watchFlow(third.value.flowId);
const thirdFlow = await flowOf(2);
thirdFlow.print('error connecting to github.com\nplease try again later\n');
thirdFlow.exit(1);
await settled(third.value.flowId, (state) => !['pending', 'code'].includes(state?.state));
await rec('githubCliLoginStatus-error', 'githubCliLoginStatus', [third.value.flowId]);
await rec('githubCliLoginCancel-failed-flow', 'githubCliLoginCancel', [third.value.flowId]);
// A sign-in that showed its code and then failed: what the phone reads afterwards.
const fourth = await rec('githubCliLoginStart-fourth', 'githubCliLoginStart', []);
await watchFlow(fourth.value.flowId);
const fourthFlow = await flowOf(3);
fourthFlow.print('First copy your one-time code: QRST-5678\nhttps://github.com/login/device\n');
fourthFlow.exit(1);
await settled(fourth.value.flowId, (state) => !['pending', 'code'].includes(state?.state));
await rec('githubCliLoginStatus-error-after-code', 'githubCliLoginStatus', [fourth.value.flowId]);

await rec('githubCliStatus-signed-in', 'githubCliStatus', []);
await rec('githubCliAccount', 'githubCliAccount', []);
world.ghApiDown = true;
await rec('githubCliAccount-api-down', 'githubCliAccount', []);
world.ghApiDown = false;

// ═══ 7. pull requests ═══
await rec('ghPrList', 'ghPrList', [R]);
await rec('ghPrList-bad-cwd', 'ghPrList', ['repo']);
await rec('ghPrDefaultBranch', 'ghPrDefaultBranch', [R]);
await rec('ghPrDefaultBranch-bad-cwd', 'ghPrDefaultBranch', ['repo']);
await rec('ghPrDefaultBranch-not-a-repository', 'ghPrDefaultBranch', [PLAIN]);
await rec('ghPrCreate', 'ghPrCreate', [R, { base: 'main', head: 'phone', title: 'Phone PR', body: 'From the phone', draft: false }]);
await rec('ghPrCreate-same-branch', 'ghPrCreate', [R, { base: 'main', head: 'Main', title: 'Same' }]);
await rec('ghPrCreate-extra-field', 'ghPrCreate', [R, { base: 'main', head: 'phone', title: 'Extra', labels: [] }]);
await rec('ghPrCreate-no-input', 'ghPrCreate', [R]);
await rec('ghPrView', 'ghPrView', [R, 12]);
await rec('ghPrView-string-number', 'ghPrView', [R, '12']);
await rec('ghPrView-missing', 'ghPrView', [R, 404]);
await rec('ghPrView-bad-number', 'ghPrView', [R, 'x']);
await rec('ghPrView-no-number', 'ghPrView', [R]);
// The pull request's head on the origin (what gh fetches), then the checkout it makes in the repository.
git(R, 'push', '-q', 'origin', 'unmerged:refs/pull/12/head');
await rec('ghPrCheckout', 'ghPrCheckout', [R, 12]);
git(R, 'checkout', '-q', 'main');
git(R, 'branch', '-q', '-D', 'retry');
await rec('ghPrCheckout-missing', 'ghPrCheckout', [R, 404]);
await rec('ghPrCheckout-zero', 'ghPrCheckout', [R, 0]);
await rec('ghPrMerge-default-method', 'ghPrMerge', [R, 12]);
await rec('ghPrMerge-squash', 'ghPrMerge', [R, 12, 'squash']);
await rec('ghPrMerge-bad-method', 'ghPrMerge', [R, 12, 'fast-forward']);
await rec('ghPrMerge-missing', 'ghPrMerge', [R, 404, 'merge']);
await rec('ghPrDiff', 'ghPrDiff', [R, 12]);
await rec('ghPrDiff-missing', 'ghPrDiff', [R, 404]);
// ── what gh-cli.ts reads through a coercion and then uses coerced: the number (`Number(value)`, then `String(number)` on gh's
//    command line) and the merge method (`String(method ?? 'merge')`, checked before the number and put on the command line) ──
await rec('coerced-ghPrMerge-method-list', 'ghPrMerge', [R, 12, ['squash']]);
await rec('coerced-ghPrMerge-method-null', 'ghPrMerge', [R, 12, null]);
await rec('coerced-ghPrMerge-method-number', 'ghPrMerge', [R, 12, 7]);
await rec('coerced-ghPrMerge-method-boolean', 'ghPrMerge', [R, 'x', true]);
await rec('coerced-ghPrMerge-number-list', 'ghPrMerge', [R, [12], 'merge']);
await rec('coerced-ghPrView-number-list-of-string', 'ghPrView', [R, ['12']]);
await rec('coerced-ghPrDiff-number-boolean', 'ghPrDiff', [R, true]);
await rec('coerced-ghPrDiff-number-padded-string', 'ghPrDiff', [R, ' 12 ']);
await rec('coerced-ghPrCheckout-number-list', 'ghPrCheckout', [R, [404]]);

// ═══ 8. githubRequest: the feature gate, then the allowlisted action ═══
await rec('githubRequest-gate-off', 'githubRequest', [R, { action: 'pr.list', repo: 'octo/demo' }]);
config = { builtins: { git: { installed: true } } };
if (replay) {
  // The same document, written through the core's own config call (a file write waits on a file watch the core may not have).
  await withDeadline(replay.client.call('config/setBuiltinToolEnabled', { name: 'git', enabled: true }), 'the core never answered the git gate switch');
  assert.ok(!/Enable Git & GitHub/.test((await replayCall('githubRequest', [R, { action: 'pr.list', repo: 'octo/demo' }])).error ?? ''), 'the core kept the Git & GitHub gate shut');
}
await rec('githubRequest-pr-list', 'githubRequest', [R, { action: 'pr.list', repo: 'octo/demo', state: 'open', limit: 5 }]);
await rec('githubRequest-unknown-action', 'githubRequest', [R, { action: 'repo.delete' }]);
await rec('githubRequest-extra-field', 'githubRequest', [R, { action: 'pr.view', repo: 'octo/demo', number: 1, bogus: 1 }]);
await rec('githubRequest-bad-cwd', 'githubRequest', ['repo', { action: 'pr.list', repo: 'octo/demo' }]);
await rec('githubRequest-not-an-object', 'githubRequest', [R, 'pr.list']);
// ── what validateGithubRequest reads through a coercion (contract.mjs): the action as a property key (`Object.hasOwn`,
//    `GITHUB_ACTIONS[action]`), used as a string only at `out.action.endsWith`; the head sha through `/^[a-f0-9]{40}$/i.test`, put into
//    the REST body as given (commands.mjs:100, :109). Beside them, fields it reads strictly ──
const SHA = 'a'.repeat(40);
await rec('coerced-githubRequest-sha-list-merge', 'githubRequest', [R, { action: 'pr.merge', repo: 'octo/demo', number: 1, sha: [SHA] }]);
await rec('coerced-githubRequest-sha-list-review', 'githubRequest', [R, { action: 'pr.review', repo: 'octo/demo', number: 1, event: 'APPROVE', sha: [SHA] }]);
await rec('coerced-githubRequest-sha-number', 'githubRequest', [R, { action: 'pr.merge', repo: 'octo/demo', number: 1, sha: 1234 }]);
await rec('coerced-githubRequest-sha-boolean', 'githubRequest', [R, { action: 'pr.merge', repo: 'octo/demo', number: 1, sha: true }]);
await rec('coerced-githubRequest-sha-two-items', 'githubRequest', [R, { action: 'pr.merge', repo: 'octo/demo', number: 1, sha: [SHA, SHA] }]);
await rec('coerced-githubRequest-action-list', 'githubRequest', [R, { action: ['pr.view'], repo: 'octo/demo', number: 1 }]);
await rec('coerced-githubRequest-action-list-missing-field', 'githubRequest', [R, { action: ['pr.view'], repo: 'octo/demo' }]);
await rec('coerced-githubRequest-action-list-extra-field', 'githubRequest', [R, { action: ['pr.view'], repo: 'octo/demo', number: 1, bogus: 1 }]);
await rec('coerced-githubRequest-action-number', 'githubRequest', [R, { action: 7, repo: 'octo/demo' }]);
await rec('coerced-githubRequest-action-boolean', 'githubRequest', [R, { action: true, repo: 'octo/demo' }]);
await rec('coerced-githubRequest-method-list', 'githubRequest', [R, { action: 'pr.merge', repo: 'octo/demo', number: 1, sha: SHA, method: ['squash'] }]);
await rec('coerced-githubRequest-number-string', 'githubRequest', [R, { action: 'pr.view', repo: 'octo/demo', number: '1' }]);
await rec('coerced-githubRequest-number-list', 'githubRequest', [R, { action: 'pr.view', repo: 'octo/demo', number: [1] }]);
await rec('coerced-githubRequest-number-boolean', 'githubRequest', [R, { action: 'pr.view', repo: 'octo/demo', number: true }]);
await rec('coerced-githubRequest-repo-list', 'githubRequest', [R, { action: 'pr.view', repo: ['octo/demo'], number: 1 }]);

// ═══ 9. installers ═══
await rec('gitCliStatus-installed', 'gitCliStatus', []);
await rec('installGitCli-present', 'installGitCli', []);
world.gitMissing = true;
world.wingetFails = true;
await rec('installGitCli-winget-fails', 'installGitCli', []);
world.wingetFails = false;
world.wingetInstallsGit = false;
await rec('installGitCli-not-found-after', 'installGitCli', []);
world.wingetInstallsGit = true;
await rec('gitCliStatus-missing', 'gitCliStatus', [], 'cached answer: the probe ran before git went missing');
await rec('installGitCli', 'installGitCli', []);
await rec('libreOfficeStatus-missing', 'libreOfficeStatus', []);
await rec('libreOfficeStatus-refresh-missing', 'libreOfficeStatus', [true]);
world.wingetMissing = true;
await rec('installLibreOffice-no-winget', 'installLibreOffice', []);
world.wingetMissing = false;
world.wingetInstallsSoffice = false;
await rec('installLibreOffice-not-found-after', 'installLibreOffice', []);
world.wingetInstallsSoffice = true;
await rec('installLibreOffice', 'installLibreOffice', []);
await rec('installLibreOffice-present', 'installLibreOffice', []);
await rec('libreOfficeStatus-installed', 'libreOfficeStatus', []);
await rec('libreOfficeStatus-refresh', 'libreOfficeStatus', [true]);

// ═══ 10. the git runner's own failures: a program that cannot start, an output past its limit, a deadline ═══
// Node's runner codes them (git-runner.ts, run-child.mjs): the spawn error itself (`spawn git ENOENT`, code ENOENT), EMAXBUFFER, and
// EGITTIMEOUT. Each runs in a repository of its own, so no earlier read of it is cached.
const FAILING = join(WORK, 'failing');
mkdirSync(FAILING, { recursive: true });
git(FAILING, 'init', '-q', '-b', 'main');
write(FAILING, 'f.txt', 'f\n');
git(FAILING, 'add', '.');
git(FAILING, 'commit', '-q', '-m', 'first');
{
  // Git is on no path of either world: the shim of the core's bin is gone with `gitMissing`, and Node's PATH holds the Windows folders only.
  world.gitMissing = true;
  const path = process.env.PATH;
  process.env.PATH = [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
  await rec('gitStatus-git-missing', 'gitStatus', [FAILING]);
  await rec('gitLog-git-missing', 'gitLog', [FAILING]);
  await rec('gitStage-git-missing', 'gitStage', [FAILING, ['f.txt']]);
  await rec('gitBranches-git-missing', 'gitBranches', [FAILING]);
  await rec('gitStash-git-missing', 'gitStash', [FAILING, 'wip']);
  await rec('gitStashList-git-missing', 'gitStashList', [FAILING]);
  await rec('gitFetch-git-missing', 'gitFetch', [FAILING]);
  await rec('gitUndoLastCommit-git-missing', 'gitUndoLastCommit', [FAILING]);
  await rec('gitReviewDiff-git-missing', 'gitReviewDiff', [FAILING, 'f.txt', false, 'uncommitted']);
  await rec('gitGlobalConfig-git-missing', 'gitGlobalConfig', []);
  process.env.PATH = path;
  world.gitMissing = false;
}
{
  // A git the loader cannot run: Node's spawn throws spawn UNKNOWN (libuv has no name for the system's bad-image error).
  const BADGIT = join(WORK, 'badgit');
  mkdirSync(BADGIT, { recursive: true });
  writeFileSync(join(BADGIT, 'git.exe'), 'not an executable');
  world.gitBroken = true;
  const path = process.env.PATH;
  process.env.PATH = [BADGIT, join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';');
  await rec('gitStatus-git-broken', 'gitStatus', [FAILING]);
  await rec('gitStash-git-broken', 'gitStash', [FAILING, 'wip']);
  await rec('gitFetch-git-broken', 'gitFetch', [FAILING]);
  process.env.PATH = path;
  world.gitBroken = false;
}
{
  // ═══ what one git command answers when it fails: its stderr whole, its exit code when silent, the fallbacks a failure triggers ═══
  const failsWith = async (name, call, params, word, code, message, repeat) => {
    gitFailing(word, code, message, repeat);
    try {
      await rec(name, call, params);
    } finally {
      rmSync(FAIL_FILE, { force: true });
    }
  };
  await failsWith('gitStash-long-stderr', 'gitStash', [FAILING, 'wip'], 'stash', 1, 'fatal: stash failed ', 6000);
  await failsWith('gitStash-silent-failure', 'gitStash', [FAILING, 'wip'], 'stash', 3, '', 1);
  write(FAILING, 'g.txt', 'g\n');
  git(FAILING, 'add', 'g.txt');
  // The message goes through `git stripspace` on git's stdin, whose failure Node words by the exit code.
  await failsWith('gitCommit-stripspace-silent', 'gitCommit', [FAILING, 'Stage g'], 'stripspace', 7, '', 1);
  await failsWith('gitUnstage-restore-fails', 'gitUnstage', [FAILING, ['g.txt']], 'restore', 1, 'git: restore is not a git command', 1);
  write(FAILING, 'f.txt', 'changed\n');
  await failsWith('gitRevertFile-worktree-restore-fails', 'gitRevert', [FAILING, 'f.txt', false, 'worktree'], 'restore', 1, 'git: restore is not a git command', 1);
  const head = git(FAILING, 'rev-parse', 'HEAD').trim();
  await failsWith('gitCherryPickCommit-conflict-text', 'gitCherryPickCommit', [FAILING, head], 'cherry-pick', 1, 'error: could not apply: CONFLICT (content) in f.txt', 1);
  await failsWith('gitCherryPickCommit-plain-failure', 'gitCherryPickCommit', [FAILING, head], 'cherry-pick', 1, 'fatal: bad object', 1);
  // The repository is the one the cases after this block expect.
  git(FAILING, 'checkout', '--', 'f.txt');
  rmSync(join(FAILING, 'g.txt'), { force: true });
}
// A repository whose only commit has no parent to go back to.
await rec('gitUndoLastCommit-only-commit', 'gitUndoLastCommit', [FAILING]);
const BIG = join(WORK, 'big');
mkdirSync(BIG, { recursive: true });
git(BIG, 'init', '-q', '-b', 'main');
const bigText = (tag) => Array.from({ length: 800_000 }, (_, n) => `${tag} line ${String(n).padStart(8, '0')} ......\n`).join('');
write(BIG, 'big.txt', bigText('before'));
git(BIG, 'add', '.');
git(BIG, 'commit', '-q', '-m', 'first');
write(BIG, 'big.txt', bigText('after'));
await rec('gitDiff-output-too-large', 'gitDiff', [BIG, 'big.txt', false]);
// Node's production limit (GIT_READ_TIMEOUT_MS, 60 s) on its virtual clock. The status listing is the one git that never answers
// (the shim hangs while HANG_FILE names `status`); its siblings (numstat, remote, the work-tree root) run to their ends first, so
// the only child the limit can reach is the hung one. The clock stops one ms short of the limit (still running), then passes it.
const RUN_LIMIT_MS = 60_000;
const isStatusListing = (child) => child.argv.includes('status');
writeFileSync(HANG_FILE, 'status');
clock.limit = RUN_LIMIT_MS;
await rec('gitStatus-git-timeout', 'gitStatus', [FAILING], null, async (steps) => {
  await timeline.armed(isStatusListing, 'the run limit of the hung git status never started counting');
  await timeline.others(isStatusListing, 'the siblings of the hung git status never ended');
  steps.push(replay ? await replay.wire.advance(RUN_LIMIT_MS - 1) : { advance: RUN_LIMIT_MS - 1, ...clock.advance(RUN_LIMIT_MS - 1) });
  assert.deepEqual(steps.at(-1).fired, [], 'the limit fired one ms before it was reached');
  assert.equal(steps.at(-1).armed.filter(isStatusListing).length, 1, 'the hung status is not counting');
  steps.push(replay ? await replay.wire.advance(2) : { advance: 2, ...clock.advance(2) });
  assert.equal(steps.at(-1).fired.filter(isStatusListing).length, 1, 'the limit did not fire past the boundary');
});
clock.limit = 0;
rmSync(HANG_FILE, { force: true });

// ═══ 11. ordering: a read behind a slow write ═══
const scenario = [
  ['gitStage', [R, ['ordering.txt']]],
  ['gitStatus', [R]],
  ['gitLog', [R]],
  ['gitUnstage', [R, ['ordering.txt']]],
  ['gitDiff', [R, 'a.txt', false]],
];
write(R, 'ordering.txt', 'staged behind a slow write\n');
const HELD_WRITE = 'gitStage';
if (replay) {
  await replayOrdering(scenario, HELD_WRITE);
  await finishReplay();
}
// Node's per-connection barrier (remote-call-queue.ts): the calls ride the queue the relay clients use. The write is held on a
// gate until every later call was submitted and the write signalled that it is inside the operation; the recording keeps which calls had started while it was
// held, and for each operation what had ended before it started (reads: only the writes among them, readers overlap).
const { createRemoteCallQueue } = await main('remote-call-queue');
const tracing = host.invokeDesktopOperation;
// The scenario runs twice in this recording, each time on a queue of its own. `orders` keeps what each run saw, in the order it
// happened (for every start: every operation that had ended before it, in the order they ended), so a reader of the recording can
// see which of Node's orders are the same in both runs and which are not.
async function recordOrderingRun() {
  const queue = createRemoteCallQueue();
  const orderLog = [];
  const ended = [];
  host.invokeDesktopOperation = async (name, operationArgs) => {
    orderLog.push({ started: name, endedBefore: [...ended] });
    try {
      return await tracing(name, operationArgs);
    } finally {
      ended.push(name);
    }
  };
  trace.length = 0;
  let release;
  let held;
  const reached = new Promise((resolve) => (held = resolve));
  hold = { name: HELD_WRITE, gate: new Promise((resolve) => (release = resolve)), reached: held };
  const answers = [];
  const running = scenario.map(([call, params], index) => queue.run(call, async () => {
    const frame = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: call, params }));
    const { id: _id, ...answer } = JSON.parse(JSON.stringify(frame));
    answers[index] = answer;
  }));
  // Every call is submitted: the write is the one the queue ran. It signals when it is inside the operation and held. A write that
  // never started leaves nothing to signal: then every call finishes without reaching it, or the queue stalls and the bound fails the wait.
  const outcome = await withDeadline(
    Promise.race([reached.then(() => 'held'), Promise.allSettled(running).then(() => 'every call finished')]),
    `the write ${HELD_WRITE} did not start: the queue stalled before reaching it`,
  );
  if (outcome !== 'held') throw new Error(`the write ${HELD_WRITE} never started: every call finished without reaching it`);
  const heldStarts = orderLog.map((entry) => entry.started);
  if (heldStarts.join() !== HELD_WRITE) throw new Error(`calls started while the write was held: ${heldStarts}`);
  release();
  await withDeadline(Promise.all(running), `the calls behind the held write ${HELD_WRITE} never finished`);
  queue.close();
  host.invokeDesktopOperation = tracing;
  return { heldStarts, order: clone(orderLog), answers, ops: clone(trace) };
}
const firstRun = await recordOrderingRun();
const secondRun = await recordOrderingRun();
// The order of every start and end is part of what is recorded: the two runs must show the same one, or the comparison is not ordered.
for (const key of ['heldStarts', 'order', 'answers', 'ops']) {
  if (JSON.stringify(firstRun[key]) !== JSON.stringify(secondRun[key])) throw new Error(`the two runs of the ordering scenario differ in ${key}`);
}
const ordering = {
  name: 'read-behind-a-slow-write',
  calls: scenario.map(([call, params]) => ({ call, params: clone(params) })),
  heldStarts: firstRun.heldStarts,
  order: firstRun.order,
  answers: firstRun.answers,
  ops: firstRun.ops,
};
const PATH_SPELLINGS = ['C:\\repo', '\\repo', '/repo', 'C:/repo', '\\\\host\\share', '//host/share', 'repo', './repo', 'C:repo', ' /repo ', '../x', 'C:\\x'];
// ── every one of the 62 calls was recorded ──
const PH2_SCM_CALLS = readFileSync(join(FIXTURES, 'calls.txt'), 'utf8').split(/\s+/).filter(Boolean);
const missing = PH2_SCM_CALLS.filter((call) => !covered.has(call));
if (missing.length || PH2_SCM_CALLS.length !== 62) throw new Error(`calls not recorded: ${missing.join(', ')} (${PH2_SCM_CALLS.length} listed)`);

if (scripted.unscripted.length) throw new Error(`processes no rule of gh-script.json answers:\n${JSON.stringify(scripted.unscripted, null, 1)}`);
// How each sign-in terminal child ended, taken before the host is disposed (which ends any left running).
const ptyEnds = pty.spawned.map((entry) => ({ argv: entry.record.argv, cwd: entry.record.cwd, env: entry.record.env, ended: entry.record.record.ended }));
await withDeadline(operations.dispose(), "Node's desktop operations never finished disposing");
scripted.restore();
rmSync(WORK, { recursive: true, force: true });

const stage = stageSet(FIXTURES, ['golden.json']);
writeJson(join(stage, 'golden.json'), {
  note: 'The relay frame Node (b6f10295a) sent the phone for each source-control call, with the desktop operations it invoked and what they returned. gh, winget, soffice.com and `git --version` are the scripted rules of gh-script.json (`world` is the state when the call ran).',
  platform: process.platform,
  git: gitVersion,
  realGit: realGitVersion,
  // What Node's host (`path.isAbsolute`, main/git-contract.mjs:1-6 and every git path check) says of each spelling, on each platform's rule.
  pathRules: Object.fromEntries(
    [['windows', win32], ['unix', posix]].map(([family, rules]) => [family, PATH_SPELLINGS.map((spelling) => ({ spelling, absolute: rules.isAbsolute(spelling), trimmedAbsolute: rules.isAbsolute(spelling.trim()) }))]),
  ),
  cases,
  // Calls the core cannot be compared on, each recorded from Node and kept as JSON text (`recordedText`): see the manifest's notes.
  limits,
  ptyEnds,
  ordering,
});
writeSetManifest(stage, {
  set: 'phone-scm',
  recorder: 'benchmarks/rust-core/recorders/record-phone-scm.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-scm.mjs --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    cases: cases.length,
    calls: PH2_SCM_CALLS.length,
    // The recorder that made this recording, by the hash of each of its files' committed (LF) text; a replay refuses to compare
    // when the running recorder's files differ.
    recorderFiles: recorderFiles(),
    // What of Node's path from the phone's socket to the method table this recording runs, and what it does not.
    entry: {
      runs: 'executeRemoteFrame over createRemoteMethods (remote-methods.ts:1256, :828): the frame parse, the method lookup, every argument check and the desktop operation',
      notRun:
        'the relay above it, which reads no source-control method or argument: the payload cap (remote-relay.ts:75,190), frame admission (remote-relay-clients.ts:215-217), the handshake and decryption (remote-relay-client-lifecycle.ts:86-99), the transport registrations and the state-resync frame of remote-relay-client-calls.ts:181-455',
      git: 'runChild on the calling thread. The daemon runs the same runChild in its process-runner worker pool (desktop-service.ts:1049-1053, process-runner.mjs:19-37, four threads): the same limits and errors; the spawns of one thread queue, which this recording does not reproduce',
      featureGit: 'MIXDOG_FEATURE_GIT is unset, as in the product: no production code sets it (read at builtin-features.mjs:70,219)',
      clock: 'Date.now, new Date() and the run-limit timeouts are virtual; every other timer of the code under test is real and is printed, by delay, at the end of a recording',
    },
    notes: {
      loneSurrogate:
        'An open difference, not parity. A JSON string holding an escaped lone surrogate ("\\ud800") is a string to Node: its string checks take it and the call acts on it (golden.json limits[lone-surrogate-gitLog-query]; Node\'s spawn writes it on git\'s command line as U+FFFD, bytes EF BF BD). The core reads every inbound frame into Rust strings (mixdog-app-protocol rpc.rs decode_inbound_text), which cannot hold one: the frame is invalid and the connection is closed with 1007, for every method, before any check runs. The case is not replayed.',
      posixCwd:
        'The directory rule is the platform\'s path.isAbsolute (git-contract.mjs:3), and so is the core\'s (mixdog-scm input.rs is_absolute): on POSIX only a leading "/" is absolute, so a backslash-rooted, a drive (C:\\x) or a UNC spelling is refused there where Windows (this recording) takes it. The trim is JavaScript\'s on both platforms.',
      reviewWithoutFiles:
        'The core request of the phone\'s gitReviewDiff and gitReviewDiffs is one method (review/diff/get, scope repo, patch true): one with neither `path` nor `files` cannot say which call it stands for, and is checked as gitReviewDiff. A request that names either is checked as its own call; the page always names one.',
      loginOptions:
        'githubCliLoginOpenBrowser\'s second argument (optionalGithubLoginOptions) has no core param: the page checks it and leaves it out (scm-operation-route.ts), so no core request carries it.',
      githubStatusRefresh:
        'githubCliStatus took no arguments over the relay (remote-methods.ts:562); the core ignores `refresh` on a relay connection and honours it for the desktop\'s own calls.',
    },
    // The stand-in's rules are input to both products, not recorded answers: say so, and what each imitates.
    syntheticInput: {
      file: 'gh-script.json',
      reason: 'no authenticated gh (and no winget or soffice.com) on the recording machine; Node and the core run against the same rules and are compared with each other',
      rules: script.rules.map((rule) => ({ tool: rule.tool, argv: rule.argv, when: rule.when ?? null, imitates: rule.imitates })),
    },
  },
});
commitStage(stage, FIXTURES);
console.log(`phone-scm: ${cases.length} cases over ${PH2_SCM_CALLS.length} calls`);
console.log(`real timers of the code under test, by delay (ms): ${JSON.stringify(Object.fromEntries([...realTimers].sort()))}`);
process.exit(0);
