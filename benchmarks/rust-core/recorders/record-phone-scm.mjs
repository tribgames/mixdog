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
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { installScriptedProcesses, scriptedPty, serveShims } from './lib/phone-scm-world.mjs';

const REAL_HOME = process.env.USERPROFILE;
const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const WORK = process.env.PHONE_SCM_WORK ?? 'D:\\mixdog-build\\tmp\\phone-ph2-scm-rec';
const FIXTURES = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'fixtures', 'phone-scm');
const args = parseArgs();
// `--replay <mixdogd.exe>`: the same scripted scenario, but each call goes through the phone's adapter to a built `mixdogd` and its
// answer is compared in full with the recording (fixtures/phone-scm/golden.json) instead of being recorded. Only the calls that
// ran no scripted process (`gh`, `winget`, `soffice.com`, `git --version`) are replayed: the core spawns its own tools, and no
// scripted `gh` is put on its PATH. The replay ends where the scenario's GitHub half begins.
const REPLAY = args.get('replay') ?? null;const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const script = JSON.parse(readFileSync(join(FIXTURES, 'gh-script.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

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
  PATH: `${join(WORK, 'bin')};${process.env.PATH}`,
});
delete process.env.MIXDOG_FEATURE_GIT;

// Git resolves through PATH (git-launch.mjs gitCommand: the first absolute entry holding git.exe), and a deadline or an overflow
// names that resolved path in Node's message. Both products start with this world's bin first on PATH, and its git.exe is the
// scripted-tool executable (lib/scripted-tool.rs), which runs the real git: both name the same path, on any machine.
const shimExe = join(WORK, 'shim', 'scripted-tool.exe');
mkdirSync(join(WORK, 'shim'), { recursive: true });
const built = spawnSync('rustc', ['-O', '--edition', '2021', join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'scripted-tool.rs'), '-o', shimExe], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, RUSTUP_HOME: join(REAL_HOME, '.rustup'), CARGO_HOME: join(REAL_HOME, '.cargo') } });
assert.equal(built.status, 0, built.stderr);
const realGit = process.env.PATH.split(';').filter((dir) => dir !== join(WORK, 'bin')).map((dir) => join(dir, 'git.exe')).find((file) => existsSync(file));
process.env.PHONE_SCM_REAL_GIT = realGit;
if (!REPLAY) fs.copyFileSync(shimExe, join(WORK, 'bin', 'git.exe'));

// Node's clock, driven by the recorder: time passes only when the recording says so.
let clockSkew = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockSkew;
const PROVEN_BY_CLOCK_TEST = new Set(['gitStatus-remote-after-ttl']);
// The core's run limit is 60 s and it has no knob to shorten it, so a deadline is recorded from Node with a shortened one and proven on
// the core by a Rust test that reads this recording (mixdog-scm phone_parity_tests.rs, a_git_deadline_reads_as_the_recorded_one).
const PROVEN_BY_DEADLINE_TEST = new Set(['gitStatus-git-timeout']);

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
const { runProcessOffThread } = await importFrom(tree, 'src/runtime/shared/process-runner.mjs');
// A deadline Node's runner would wait 60 s for is shortened to shortDeadline ms while a case sets it: the same code kills the child and words the failure.
let shortDeadline = 0;
setGitProcessRunner((command, runArgs, options) => runProcessOffThread(command, runArgs, shortDeadline && options.timeoutMs > 0 ? { ...options, timeoutMs: shortDeadline } : options));
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
const git = (cwd, ...gitArgs) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...gitArgs], { cwd, encoding: 'utf8', stdio: 'pipe' });
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
let replay = null;
const settingsChanges = [];
let settingsWaiting = [];
if (REPLAY) {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
  if (process.env.PHONE_SCM_VERBOSE) console.error('stage: imports');
  const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-scm.ts');
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
      soffice: join(pf, 'LibreOffice', 'program', 'soffice.com'),
    },
  });
  shims.sync();
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
  });
  const inside = (file) => resolve(file).toLowerCase().startsWith(`${resolve(WORK).toLowerCase()}\\`);
  assert.equal(Object.keys(coreEnv).filter((key) => /^path$/i.test(key)).length, 1, 'the core gets exactly one Path');
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) assert.ok(inside(coreEnv[key]), `${key} is outside this world: ${coreEnv[key]}`);
  for (const tool of ['gh', 'winget', 'soffice', 'soffice.com', 'git']) {
    // The product's lookup is the child's own: where.exe resolves a name against the very environment the core will get.
    const found = spawnSync(join(systemRoot, 'System32', 'where.exe'), [tool], { cwd: WORK, env: coreEnv, encoding: 'utf8' });
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
  const endpoint = await new Promise((resolve, reject) => {
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
  });
  if (process.env.PHONE_SCM_VERBOSE) console.error('endpoint', JSON.stringify(endpoint));
  const client = await connect({
    target: { id: 'core' },
    connector: createWsConnector(async () => endpoint),
    clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    clock: { sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
    random: Math.random,
  });
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
  await client.subscribeApp();
  await appSnapshot;
  appLive = true;
  // As the router gives it: the client scoped to the call, so every request frame carries the call's `sent` claim.
  const host = { ctx: {}, client: () => scopeClient(client, () => {}) };
  const byName = new Map(golden.cases.map((entry) => [entry.name, entry]));
  replay = { core, client, host, adapter, byName, shims, compared: [], differences: [], ptySeen: 0 };
}

/** The phone's adapter against the core: the frame the relay would carry. */
async function replayCall(call, params) {
  try {
    // A call that never answers is a defect to name, not a hang to wait out.
    let timer;
    const stalled = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the core never answered ${call}`)), 120_000)));
    const value = await Promise.race([replay.adapter.calls[call](params, replay.host), stalled]).finally(() => clearTimeout(timer));
    return { ok: true, value: value === undefined ? null : clone(value) };
  } catch (error) {
    return { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}), ...(error.details === undefined ? {} : { errorParams: error.details }) };
  }
}

async function finishReplay() {
  replay.client.close?.();
  const exited = new Promise((resolve) => replay.core.once('exit', resolve));
  execFileSync('taskkill', ['/T', '/F', '/PID', String(replay.core.pid)], { stdio: 'ignore' });
  await exited;
  rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  console.log(`phone-scm replay over ${REPLAY}: ${replay.compared.length} compared, ${replay.differences.length} differ, ${replay.byName.size - replay.compared.length - PROVEN_BY_CLOCK_TEST.size - PROVEN_BY_DEADLINE_TEST.size} of the recording not replayed (${PROVEN_BY_CLOCK_TEST.size} proven by the core's injected-clock test, ${PROVEN_BY_DEADLINE_TEST.size} by its deadline test)`);
  for (const difference of replay.differences) console.log(`DIFF ${difference.name}\n  node: ${JSON.stringify(difference.node)}\n  core: ${JSON.stringify(difference.core)}`);
  process.exit(replay.differences.length ? 1 : 0);
}
// A login flow's id is `ghlogin_<pid>_<n>` in both products. Node's recording pins its pid (4242); the core's is its own process's,
// so the core's answer is read with that pid as the recording's. Nothing else is rewritten.
const coreParams = (params) => JSON.parse(JSON.stringify(params).replaceAll('ghlogin_4242_', `ghlogin_${replay.core.pid}_`));
const flowOf = (n) => (replay ? withDeadline(replay.shims.flow(n), `the core never ran gh auth login (flow ${n})`) : pty.spawned[n]);
function withDeadline(promise, message) {
  let timer;
  const stalled = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), 60_000)));
  return Promise.race([promise, stalled]).finally(() => clearTimeout(timer));
}
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
  await replay.client.call('feed/subscribe', { feedId });
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
function mapFlowIds(frame) {
  return JSON.parse(JSON.stringify(frame).replaceAll(`ghlogin_${replay.core.pid}_`, 'ghlogin_4242_'));
}
const LIVE_NODE = new Set(['gitReview', 'gitReview-uncommitted']);
async function nodeFrame(call, params) {
  const frame = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: call, params }));
  const { id: _id, ...answer } = JSON.parse(JSON.stringify(frame));
  return answer;
}
/** One phone call through the relay's frame executor. */
async function rec(name, call, params, note) {
  if (replay) {
    const recorded = replay.byName.get(name);
    assert.ok(recorded, `${name} is not in the recording`);
    if (PROVEN_BY_CLOCK_TEST.has(name) || PROVEN_BY_DEADLINE_TEST.has(name)) return;
    if (process.env.PHONE_SCM_VERBOSE) console.error('replay', name);
    replay.shims.sync();
    processes.length = 0;
    // The tools that were on no path of the core's world when the call began.
    const absentAtStart = ['gh', 'winget', 'git', 'soffice.com'].filter((tool) => replay.shims.absent(tool));
    const settingsBefore = settingsChanges.length;
    const core = mapFlowIds(await replayCall(call, coreParams(params)));
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
    const events = settingsChanges.slice(settingsBefore);
    if (!isDeepStrictEqual(events, recorded.events ?? [])) replay.differences.push({ name: `${name} (events)`, node: recorded.events ?? [], core: events });
    // The tools the core ran, as Node ran them: the same programs with the same arguments, in the same order.
    // A tool Node tried and could not start (spawn ENOENT) has no executable in the core's world, so the core's attempt leaves no
    // process to list: it is compared against the world instead. Node's attempt must have met a tool that was on no path of the
    // core's world when the call began, or the two products ran in different worlds.
    for (const attempt of (recorded.processes ?? []).filter((entry) => entry.reply?.code === -1)) {
      if (!absentAtStart.includes(attempt.tool)) replay.differences.push({ name: `${name} (${attempt.tool} attempted)`, node: 'spawn failed: the tool is absent', core: 'the tool was on a path of the core\'s world' });
    }
    // `ghPrList` starts its four category queries at once (Promise.all there, join_all in the core): which process the OS starts
    // first is not defined, so for that call alone the programs and arguments are compared as a set. Every other call is ordered.
    const concurrent = call === 'ghPrList';
    const ran = (list) => {
      const done = (list ?? []).filter((entry) => entry.reply?.code !== -1).map(({ tool, argv }) => ({ tool, argv }));
      return concurrent ? done.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : done;
    };
    if (!isDeepStrictEqual(ran(processes), ran(recorded.processes))) replay.differences.push({ name: `${name} (processes)`, node: ran(recorded.processes), core: ran(processes) });
    // A revision is the file system's own identity (size, times, inode): it differs per machine and per run, so Node answers these
    // again on the very files the core just read instead of the golden's scripted ones.
    const expected = LIVE_NODE.has(name) ? await nodeFrame(call, params) : recorded.frame;
    replay.compared.push(name);
    if (!isDeepStrictEqual(core, expected)) replay.differences.push({ name, node: expected, core });
    return core;
  }
  covered.add(call);
  trace.length = 0;
  events.length = 0;
  processes.length = 0;
  const wire = JSON.parse(JSON.stringify(params));
  const frame = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: call, params }));
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
// passed. Node's clock is virtual: the recorder moves Date.now past the TTL. The core's cache is proven at that point by its
// injected-clock test (remote_metadata_expires_by_clock); the real mixdogd keeps no clock to move, so these cases have a
// repository of their own and nothing else's status depends on the minute.
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
clockSkew += 61_000;
await rec('gitStatus-remote-after-ttl', 'gitStatus', [TEMP]);
clockSkew -= 61_000;
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
else await setupDone;
await rec('githubCliLoginStatus-success', 'githubCliLoginStatus', [second.value.flowId]);
const third = await rec('githubCliLoginStart-third', 'githubCliLoginStart', []);
await watchFlow(third.value.flowId);
const thirdFlow = await flowOf(2);
thirdFlow.print('error connecting to github.com\nplease try again later\n');
thirdFlow.exit(1);
await settled(third.value.flowId, (state) => !['pending', 'code'].includes(state?.state));
await rec('githubCliLoginStatus-error', 'githubCliLoginStatus', [third.value.flowId]);
await rec('githubCliLoginCancel-failed-flow', 'githubCliLoginCancel', [third.value.flowId]);

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
  await replay.client.call('config/setBuiltinToolEnabled', { name: 'git', enabled: true });
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
shortDeadline = 1;
await rec('gitStatus-git-timeout', 'gitStatus', [FAILING]);
shortDeadline = 0;

if (replay) await finishReplay();
// ═══ 11. ordering: a read behind a slow write ═══
// Node's per-connection barrier (remote-call-queue.ts): the calls ride the queue the relay clients use. The write is held on a
// gate until every later call was submitted and the write signalled that it is inside the operation; the recording keeps which calls had started while it was
// held, and for each operation what had ended before it started (reads: only the writes among them, readers overlap).
const { createRemoteCallQueue } = await main('remote-call-queue');
const queue = createRemoteCallQueue();
const WRITES = new Set(['gitStage', 'gitUnstage']);
const orderLog = [];
const ended = [];
const tracing = host.invokeDesktopOperation;
host.invokeDesktopOperation = async (name, operationArgs) => {
  const priors = WRITES.has(name) ? [...ended].sort() : ended.filter((done) => WRITES.has(done)).sort();
  orderLog.push({ started: name, endedBefore: priors });
  try {
    return await tracing(name, operationArgs);
  } finally {
    ended.push(name);
  }
};
const scenario = [
  ['gitStage', [R, ['ordering.txt']]],
  ['gitStatus', [R]],
  ['gitLog', [R]],
  ['gitUnstage', [R, ['ordering.txt']]],
  ['gitDiff', [R, 'a.txt', false]],
];
write(R, 'ordering.txt', 'staged behind a slow write\n');
trace.length = 0;
let release;
let held;
const reached = new Promise((resolve) => (held = resolve));
hold = { name: 'gitStage', gate: new Promise((resolve) => (release = resolve)), reached: held };
const answers = [];
const running = scenario.map(([call, params], index) => queue.run(call, async () => {
  const frame = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: call, params }));
  const { id: _id, ...answer } = JSON.parse(JSON.stringify(frame));
  answers[index] = answer;
}));
// Every call is submitted: the write is the one the queue ran. It signals when it is inside the operation and held.
await reached;
const heldStarts = orderLog.map((entry) => entry.started);
if (heldStarts.join() !== 'gitStage') throw new Error(`calls started while the write was held: ${heldStarts}`);
release();
await Promise.all(running);
queue.close();
const ordering = {
  name: 'read-behind-a-slow-write',
  calls: scenario.map(([call, params]) => ({ call, params: clone(params) })),
  heldStarts,
  order: clone(orderLog),
  answers,
  ops: clone(trace),
};

// ── every one of the 62 calls was recorded ──
const PH2_SCM_CALLS = readFileSync(join(FIXTURES, 'calls.txt'), 'utf8').split(/\s+/).filter(Boolean);
const missing = PH2_SCM_CALLS.filter((call) => !covered.has(call));
if (missing.length || PH2_SCM_CALLS.length !== 62) throw new Error(`calls not recorded: ${missing.join(', ')} (${PH2_SCM_CALLS.length} listed)`);

if (scripted.unscripted.length) throw new Error(`processes no rule of gh-script.json answers:\n${JSON.stringify(scripted.unscripted, null, 1)}`);
await operations.dispose();
scripted.restore();
rmSync(WORK, { recursive: true, force: true });

const stage = stageSet(FIXTURES, ['golden.json']);
writeJson(join(stage, 'golden.json'), {
  note: 'The relay frame Node (b6f10295a) sent the phone for each source-control call, with the desktop operations it invoked and what they returned. gh, winget, soffice.com and `git --version` are the scripted rules of gh-script.json (`world` is the state when the call ran).',
  platform: process.platform,
  git: gitVersion,
  cases,
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
