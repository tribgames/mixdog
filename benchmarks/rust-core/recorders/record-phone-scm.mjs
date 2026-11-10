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
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const script = JSON.parse(readFileSync(join(FIXTURES, 'gh-script.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const MACHINE_PATH = process.env.PATH;
rmSync(WORK, { recursive: true, force: true });
for (const dir of ['home', 'bin', 'data', 'ud', 'app']) mkdirSync(join(WORK, dir), { recursive: true });
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
  if (pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 30_000 });
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
await boundedTree('rustc', ['-O', '--edition', '2021', join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'scripted-tool.rs'), '-o', shimExe], { cwd: REPO_ROOT, env: { ...process.env, PATH: MACHINE_PATH, RUSTUP_HOME: join(REAL_HOME, '.rustup'), CARGO_HOME: join(REAL_HOME, '.cargo') } });
const realGit = MACHINE_PATH.split(';').filter((dir) => dir !== join(WORK, 'bin')).map((dir) => join(dir, 'git.exe')).find((file) => existsSync(file));
process.env.PHONE_SCM_REAL_GIT = realGit;
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
globalThis.setTimeout = (fire, delay, ...rest) => {
  if (!(clock.limit > 0 && delay === clock.limit)) return realSetTimeout(fire, delay, ...rest);
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
process.env.PHONE_SCM_HANG_FILE = HANG_FILE;

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
    (error) => (attempt.reply = error?.code === 'ENOENT' ? { code: -1, stderr: 'ENOENT' } : { error: error?.code ?? 'error' }),
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
const write = (root, rel, text) => {
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
const settingsChanges = [];
let settingsWaiting = [];
if (REPLAY) {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
  if (process.env.PHONE_SCM_VERBOSE) console.error('stage: imports');
  const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-scm.ts');
  const { runQueued, callQueueFor } = await here('apps/desktop/src/renderer/remote-protocol-queue.ts');
  const { SCM_OPERATION_ROUTES } = await here('apps/desktop/src/shared/scm-operation-route.ts');
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
  replay = { core, client, host, adapter, runQueued, callQueueFor, routes: SCM_OPERATION_ROUTES, golden, byName, shims, wire, wires, holder, compared: [], differences: [], ptySeen: 0, jsSeen: 0, baseEnv: coreEnv };
}

/** The phone's adapter against the core: the frame the relay would carry. */
const frameOf = (value) => ({ ok: true, value: value === undefined ? null : clone(value) });
const failureFrame = (error) => ({ ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}), ...(error.details === undefined ? {} : { errorParams: error.details }) });
/** One phone call the way the router runs it: through the connection's one shared queue. */
function replayCall(call, params) {
  const answered = replay.runQueued(replay.host.ctx, call, params, async () => replay.adapter.calls[call](params, replay.host));
  return withDeadline(answered.then(frameOf, failureFrame), `the core never answered ${call}`);
}

async function finishReplay() {
  // Every sign-in terminal child, in the order started: its program, directory, environment and how it ended.
  const begun = new Map();
  for (const event of replay.wire.events) {
    if (event.event === 'begin' && event.pty) begun.set(event.seq, { argv: event.args, cwd: event.cwd, env: coreEnvDelta(event), ended: null });
    else if (event.event === 'done' && begun.has(event.seq)) begun.get(event.seq).ended = event.result;
  }
  if (!isDeepStrictEqual([...begun.values()], replay.golden.ptyEnds)) replay.differences.push({ name: 'sign-in terminal children (program, directory, environment, end)', node: replay.golden.ptyEnds, core: [...begun.values()] });
  replay.client.close?.();
  const exited = new Promise((resolve) => replay.core.once('exit', resolve));
  endTree(replay.core.pid);
  await withDeadline(exited, 'the core did not exit after taskkill');
  rmSync(WORK, { recursive: true, force: true });
  const cases = replay.compared.filter((name) => name !== 'ordering');
  console.log(`phone-scm replay over ${REPLAY}: ${cases.length} cases and the ordering scenario compared (${replay.compared.includes('ordering') ? 'replayed' : 'NOT replayed'}), ${replay.differences.length} differ, ${replay.byName.size - cases.length} of the recording not replayed`);
  for (const difference of replay.differences) console.log(`DIFF ${difference.name}\n  node: ${JSON.stringify(difference.node)}\n  core: ${JSON.stringify(difference.core)}`);
  process.exit(replay.differences.length ? 1 : 0);
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
    .map((op) => {
      const spawn = op.error?.code === 'ENOENT' ? /^spawn (\S+) ENOENT$/.exec(op.error.message) : null;
      const outcome = op.error
        ? { failed: spawn ? { capability: spawn[1] } : { message: op.error.message } }
        : { result: op.name === 'githubCliLoginStart' ? { flowId: op.result.flowId } : op.result === undefined ? null : op.result };
      return { ...clone(replay.routes[op.name](op.args)), outcome };
    });
}
/** What the core answered each request of the adapter: its result, or its failure (a missing program is a missing capability). */
function actualWires(wires) {
  return mapFlowIds(
    wires.map((wire) => {
      const outcome = wire.error
        ? { failed: wire.error.capability ? { capability: wire.error.capability } : { message: wire.error.message } }
        : { result: wire.method === 'github/login/start' ? { flowId: wire.result.flowId } : wire.result };
      return { method: wire.method, ...(wire.params === undefined ? {} : { params: wire.params }), outcome };
    }),
  );
}
// The sign-in start answers the flow's id; the adapter then reads the flow itself with `github/login/status` requests (DS 5.4), which no
// desktop operation of Node's recording stands for.
const loginReads = (wires) => wires.every((wire) => wire.method === 'github/login/status');
function opsDifference(ops, wires) {
  const expected = expectedWires(ops);
  const actual = actualWires(wires);
  const asked = actual.slice(0, expected.length);
  return isDeepStrictEqual(asked, expected) && loginReads(actual.slice(expected.length)) ? null : { node: expected, core: actual };
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
 * given, runs while the call is still going, with the list the call's clock steps are added to.
 */
async function rec(name, call, params, note, during) {
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
    const answered = replayCall(call, coreParams(params));
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
    const differ = (what, node, coreSide) => replay.differences.push({ name: `${name} (${what})`, node, core: coreSide });
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
    const operations = opsDifference(recorded.ops, replay.wires);
    if (operations) differ('operations', operations.node, operations.core);
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
  const wire = JSON.parse(JSON.stringify(params));
  const answered = executeRemoteFrame(methods, JSON.stringify({ id: 1, method: call, params }));
  if (during) await during(steps);
  const frame = await withDeadline(answered, `the call ${name} never answered`);
  await drainGit();
  const { id: _id, ...answer } = JSON.parse(JSON.stringify(frame));
  if (process.env.PHONE_SCM_VERBOSE) console.log(name, JSON.stringify(answer).slice(0, 300));
  cases.push({
    name,
    call,
    params: wire,
    ...(note ? { note } : {}),
    frame: answer,
    ops: clone(trace),
    ...(events.length ? { events: clone(events) } : {}),
    ...(processes.length ? { processes: clone(processes) } : {}),
    ...(steps.length ? { clock: clone(steps) } : {}),
    world: clone(world),
  });
  return answer;
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
await rec('ghPrCreate', 'ghPrCreate', [R, { base: 'main', head: 'phone', title: 'Phone PR', body: 'From the phone', draft: false }]);
await rec('ghPrCreate-same-branch', 'ghPrCreate', [R, { base: 'main', head: 'Main', title: 'Same' }]);
await rec('ghPrCreate-extra-field', 'ghPrCreate', [R, { base: 'main', head: 'phone', title: 'Extra', labels: [] }]);
await rec('ghPrCreate-no-input', 'ghPrCreate', [R]);
await rec('ghPrView', 'ghPrView', [R, 12]);
await rec('ghPrView-string-number', 'ghPrView', [R, '12']);
await rec('ghPrView-missing', 'ghPrView', [R, 404]);
await rec('ghPrView-bad-number', 'ghPrView', [R, 'x']);
await rec('ghPrView-no-number', 'ghPrView', [R]);
await rec('ghPrCheckout', 'ghPrCheckout', [R, 12]);
await rec('ghPrCheckout-missing', 'ghPrCheckout', [R, 404]);
await rec('ghPrCheckout-zero', 'ghPrCheckout', [R, 0]);
await rec('ghPrMerge-default-method', 'ghPrMerge', [R, 12]);
await rec('ghPrMerge-squash', 'ghPrMerge', [R, 12, 'squash']);
await rec('ghPrMerge-bad-method', 'ghPrMerge', [R, 12, 'fast-forward']);
await rec('ghPrMerge-missing', 'ghPrMerge', [R, 404, 'merge']);
await rec('ghPrDiff', 'ghPrDiff', [R, 12]);
await rec('ghPrDiff-missing', 'ghPrDiff', [R, 404]);

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
  process.env.PATH = path;
  world.gitMissing = false;
}
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
await operations.dispose();
scripted.restore();
rmSync(WORK, { recursive: true, force: true });

const stage = stageSet(FIXTURES, ['golden.json']);
writeJson(join(stage, 'golden.json'), {
  note: 'The relay frame Node (b6f10295a) sent the phone for each source-control call, with the desktop operations it invoked and what they returned. gh, winget, soffice.com and `git --version` are the scripted rules of gh-script.json (`world` is the state when the call ran).',
  platform: process.platform,
  git: gitVersion,
  // What Node's host (`path.isAbsolute`, main/git-contract.mjs:1-6 and every git path check) says of each spelling, on each platform's rule.
  pathRules: Object.fromEntries(
    [['windows', win32], ['unix', posix]].map(([family, rules]) => [family, PATH_SPELLINGS.map((spelling) => ({ spelling, absolute: rules.isAbsolute(spelling), trimmedAbsolute: rules.isAbsolute(spelling.trim()) }))]),
  ),
  cases,
  ptyEnds,
  ordering,
});
writeSetManifest(stage, {
  set: 'phone-scm',
  recorder: 'benchmarks/rust-core/recorders/record-phone-scm.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-scm.mjs --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: { cases: cases.length, calls: PH2_SCM_CALLS.length },
});
commitStage(stage, FIXTURES);
console.log(`phone-scm: ${cases.length} cases over ${PH2_SCM_CALLS.length} calls`);
process.exit(0);
