#!/usr/bin/env node
// The first memory requests a client makes of Node's daemon (b6f10295a) while the memory database cannot open: the daemon is started as a
// child process (`src/standalone/daemon.mjs`) over a throwaway profile with memory enabled, and driven over its session transport the way a
// desktop drives it (`POST /client/register`, then `POST /call` `session.configure` with the actions `recall` and `memoryControl`).
//
// What keeps the opening from completing is the profile's own state, read by a real start. Held: the PostgreSQL runtime is installed (the
// bundled manifest's asset, stamped as `ensureRuntime` leaves it, so the install is a cache hit), and the cluster's spawn lock
// `<profile>/pg-spawn.lock` (`supervisor.mjs:618`) is held by this recorder through Node's own lock (`file-lock.mjs` `withFileLock`), a live
// foreign owner: Node's start waits 30 s for it and fails with its timeout text (`supervisor.mjs:619-627`); both requests are made while it
// waits. Failed: the runtime's install folder `<profile>/runtime` is a regular file, so the install fails at its first step.
//
//   node benchmarks/rust-core/recorders/record-memory-first-request.mjs --tree <exact export of b6f10295a with node_modules> --runtime <unpacked
//     PostgreSQL runtime of the manifest's asset> [--only <scenario>] [--measure]
//
// `--measure` records nothing: it times Node's ready (`daemon.json` published with its session endpoint) and its first memory answer on a fresh
// profile and then on the same profile again (an existing cluster), and prints them.
//
// Output: native/core/fixtures/memory-first-request/golden.json (+ MANIFEST.json).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, exactProductIdentity, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-memory-first-request.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const runtimeSource = args.get('runtime') ?? process.env.MIXDOG_PG_RUNTIME;
if (!runtimeSource || !existsSync(join(runtimeSource, 'bin'))) throw new Error('--runtime <unpacked PostgreSQL runtime> (or MIXDOG_PG_RUNTIME) is required');
const identity = exactProductIdentity(tree, NODE_COMMIT);
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { SESSION_PROTOCOL, SESSION_REVISION } = await imp('src/standalone/session-wire.mjs');
const { withFileLock } = await imp('src/runtime/shared/file-lock.mjs');

const withDeadline = (promise, label, ms) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: not done after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

/** A throwaway profile: every root the daemon resolves points inside it. */
function profile(sandbox) {
  const at = (name) => join(sandbox, name);
  const env = {
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    PATH: [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(';'),
    TEMP: at('tmp'),
    TMP: at('tmp'),
    APPDATA: at('appdata'),
    LOCALAPPDATA: at('localappdata'),
    HOME: at('home'),
    USERPROFILE: at('home'),
    MIXDOG_HOME: join(at('home'), '.mixdog'),
    MIXDOG_DATA_DIR: at('data'),
    MIXDOG_CONFIG_DIR: at('config'),
    MIXDOG_RUNTIME_ROOT: at('runtime-root'),
    MIXDOG_DESKTOP_USER_DATA: at('desktop'),
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    MIXDOG_DISABLE_MCP: '1',
    // As the desktop starts it: a daemon spawned for session views starts the channels (and their PostgreSQL stores) only when a channels client
    // registers (`daemon.mjs:1277-1281`).
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
  };
  for (const key of ['TEMP', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_RUNTIME_ROOT']) mkdirSync(env[key], { recursive: true });
  return env;
}

/** The runtime as `ensureRuntime` leaves an installed one (`runtime-fetcher.mjs:510-528`): `runtime-<version>-<sha12>` stamped with the asset's
 *  digest and named by `active-version`. */
function installRuntime(data) {
  const manifest = JSON.parse(readFileSync(join(tree, 'src/runtime/memory/data/runtime-manifest.json'), 'utf8'));
  const asset = manifest.assets[`${process.platform}-${process.arch}`];
  const key = `pg${manifest.pg.major}.${manifest.pg.minor}+pgvector-${manifest.pgvector.version}-${asset.sha256.slice(0, 12)}`;
  const target = join(data, 'runtime', `runtime-${key}`);
  cpSync(runtimeSource, target, { recursive: true });
  writeFileSync(join(target, '.version-sha256'), asset.sha256);
  writeFileSync(join(data, 'runtime', 'active-version'), key);
  return target;
}

/** Starts the daemon; resolves once it published `daemon.json` with its session endpoint (its own readiness record), with the time it took. */
async function startDaemon(env) {
  const started = performance.now();
  const discovery = join(env.MIXDOG_RUNTIME_ROOT, 'daemon.json');
  const child = spawn(process.execPath, [join(tree, 'src/standalone/daemon.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise((resolve, reject) => {
    const read = () => {
      try {
        const doc = JSON.parse(readFileSync(discovery, 'utf8'));
        if (doc.pid === child.pid && doc.endpoints?.session?.port) return doc;
      } catch {}
      return null;
    };
    const watcher = watch(env.MIXDOG_RUNTIME_ROOT, () => {
      const doc = read();
      if (doc) {
        watcher.close();
        resolve(doc);
      }
    });
    child.once('exit', (code) => {
      watcher.close();
      reject(new Error(`the daemon exited ${code} before it was ready: ${stderr}`));
    });
    const doc = read();
    if (doc) {
      watcher.close();
      resolve(doc);
    }
  });
  const doc = await withDeadline(ready, 'the daemon to publish daemon.json', 60_000);
  return { child, doc, readyMs: performance.now() - started, started, stderr: () => stderr };
}

/** One session-transport request: the HTTP status and the JSON body, as a client receives them. */
async function post(doc, path, body) {
  const response = await fetch(`http://127.0.0.1:${doc.endpoints.session.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': doc.endpoints.session.token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function register(doc) {
  const registered = await post(doc, '/client/register', { protocol: SESSION_PROTOCOL, revision: SESSION_REVISION, clientKind: 'desktop', lifecycle: false });
  if (registered.status !== 200) throw new Error(`register: ${JSON.stringify(registered)}`);
  return registered.body.token;
}

const configure = (doc, token, sessionId, action, actionArgs) =>
  post(doc, '/call', { token, name: 'session.configure', args: { sessionId, action, args: actionArgs } });

/** A new, empty session (the actions run on a session's runtime); its provider is never called. */
async function createSession(doc, token, env) {
  const cwd = join(env.HOME, 'work');
  mkdirSync(cwd, { recursive: true });
  const created = await post(doc, '/call', { token, name: 'session.create', args: { cwd, provider: 'openai', model: 'gpt-4o-mini', toolMode: 'full', remote: false, desktopSession: null } });
  const sessionId = created.body?.result?.sessionId;
  if (!sessionId) throw new Error(`session.create: ${JSON.stringify(created)}`);
  return sessionId;
}

/** The daemon's own stop (`POST /stop`), then its exit; a cluster still running for the profile is stopped by its data directory. */
async function stopDaemon({ child, doc }, env, runtimeDir) {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await post(doc, '/stop', { force: true }).catch(() => {});
    await withDeadline(exited, 'the daemon to exit after its stop', 60_000);
  }
  const pgdata = join(env.MIXDOG_DATA_DIR, 'pgdata');
  if (runtimeDir && existsSync(join(pgdata, 'postmaster.pid'))) {
    spawnSync(join(runtimeDir, 'bin', 'pg_ctl.exe'), ['stop', '-m', 'fast', '-w', '-t', '30', '-D', pgdata], { stdio: 'ignore', timeout: 40_000, windowsHide: true });
  }
}

const REQUESTS = [
  ['recall', ['build target', {}]],
  ['memoryControl', [{ action: 'status' }]],
];

/** Holds Node's own spawn lock until the returned release is called. */
async function holdSpawnLock(env) {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let locked;
  const lockTaken = new Promise((resolve) => {
    locked = resolve;
  });
  const holding = withFileLock(join(env.MIXDOG_DATA_DIR, 'pg-spawn.lock'), () => {
    locked();
    return released;
  }, { timeoutMs: 5_000 });
  await lockTaken;
  return async () => {
    release();
    await holding;
  };
}

const SCENARIOS = [
  {
    name: 'recall then memoryControl while the spawn lock is held by another live process',
    requests: REQUESTS,
    setup: async (env) => ({ runtimeDir: installRuntime(env.MIXDOG_DATA_DIR), release: await holdSpawnLock(env) }),
  },
  {
    name: 'recall then memoryControl when the runtime install fails',
    requests: REQUESTS,
    setup: async (env) => {
      writeFileSync(join(env.MIXDOG_DATA_DIR, 'runtime'), 'not a folder');
      return { runtimeDir: null, release: async () => {} };
    },
  },
];

const scratch = process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir();
if (args.get('measure')) {
  const sandbox = mkdtempSync(join(scratch, 'rec-memory-first-measure-'));
  const env = profile(sandbox);
  const runtimeDir = installRuntime(env.MIXDOG_DATA_DIR);
  try {
    for (const run of ['fresh', 'existing', 'existing']) {
      const daemon = await startDaemon(env);
      try {
        const token = await register(daemon.doc);
        const sessionId = await createSession(daemon.doc, token, env);
        const answer = await withDeadline(configure(daemon.doc, token, sessionId, 'recall', ['build target', {}]), 'the first memory answer', 120_000);
        console.log(JSON.stringify({ run, readyMs: Math.round(daemon.readyMs), firstAnswerMs: Math.round(performance.now() - daemon.started), answer }));
      } finally {
        await stopDaemon(daemon, env, runtimeDir);
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
} else {
  const only = args.get('only');
  const recorded = [];
  for (const scenario of SCENARIOS.filter((s) => !only || s.name === only)) {
    const sandbox = mkdtempSync(join(scratch, 'rec-memory-first-'));
    const env = profile(sandbox);
    const { runtimeDir, release } = await scenario.setup(env);
    let daemon;
    try {
      daemon = await startDaemon(env);
      const token = await register(daemon.doc);
      const sessionId = await createSession(daemon.doc, token, env);
      const answers = [];
      for (const [action, actionArgs] of scenario.requests) {
        const started = performance.now();
        const answer = await withDeadline(configure(daemon.doc, token, sessionId, action, actionArgs), action, 120_000);
        // How long the request waited is a measured clock value: printed, never recorded.
        console.log(`${action} answered after ${Math.round(performance.now() - started)} ms`);
        answers.push({ action, args: actionArgs, answer });
      }
      recorded.push({ name: scenario.name, requests: answers });
      console.log(JSON.stringify(recorded.at(-1), null, 2));
    } catch (error) {
      console.error(`daemon exit code: ${daemon?.child.exitCode}\ndaemon stderr:\n${daemon?.stderr()}`);
      const log = join(env.MIXDOG_DATA_DIR, 'daemon.log');
      if (existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf8').split('\n').slice(-60).join('\n')}`);
      throw error;
    } finally {
      // The daemon (and the memory child it forked, which ends with it) goes first, while the lock still keeps any start from beginning.
      if (daemon) await stopDaemon(daemon, env, runtimeDir);
      await release();
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
  if (!only) {
    const setDir = join(FIXTURES_ROOT, 'memory-first-request');
    mkdirSync(setDir, { recursive: true });
    writeJson(join(setDir, 'golden.json'), { scenarios: recorded });
    writeSetManifest(setDir, { set: 'memory-first-request', recorder: RECORDER, command: `node ${RECORDER} --tree <b6f10295a export> --runtime <runtime>`, identity });
  }
}
