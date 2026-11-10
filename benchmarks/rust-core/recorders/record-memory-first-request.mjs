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
// Output: native/core/fixtures/memory-first-request/golden.json (+ MANIFEST.json): each answer as the client received it (HTTP status and body),
// and `answeredWithin`, the span between Node's deadlines (15, 30, 60, 90 s) the answer arrived in.
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

/** Every session-transport request is answered within this, or fails the run (a memory call waits up to Node's 90 s, `daemon-spawn.mjs:62,141`). */
const REQUEST_DEADLINE_MS = 120_000;

/**
 * Everything one run starts, each kept by its own handle from the moment it exists: `end` ends every one of them whatever the others do (the daemon's
 * process tree, the readiness watcher, the profile's postmaster, the held lock, the profile folder) and reports every failure together.
 */
class Run {
  constructor(sandbox) {
    this.sandbox = sandbox;
    this.env = null;
    this.child = null;
    this.watcher = null;
    this.doc = null;
    this.runtimeDir = null;
    this.releaseLock = null;
  }

  /** Ends the daemon of this run and the postmaster it left; the profile and the lock stay (a measured profile is started again). */
  async endDaemon() {
    const failures = [];
    await this.#daemonSteps(failures);
    if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
  }

  async end() {
    const failures = [];
    await this.#daemonSteps(failures);
    const step = Run.#step(failures);
    if (this.child) {
      // A daemon that could not be ended still uses the profile (its cluster, its lock): nothing it uses is touched.
      failures.push(new Error(`the daemon pid ${this.child.pid} is still running; the profile ${this.sandbox} is kept`));
      throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
    }
    await step('the spawn lock', async () => this.releaseLock?.());
    await step('the profile', async () => rmSync(this.sandbox, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
  }

  static #step(failures) {
    return async (what, fn) => {
      try {
        await fn();
      } catch (error) {
        failures.push(new Error(`${what}: ${error.message}`));
      }
    };
  }

  async #daemonSteps(failures) {
    const step = Run.#step(failures);
    await step('the readiness watcher', async () => this.watcher?.close());
    await step('the daemon', async () => {
      const child = this.child;
      if (!child) return;
      const gone = () => child.exitCode !== null || child.signalCode !== null;
      // The exit is awaited from before the stop request, so the deadline counts from the request.
      const exited = new Promise((resolve) => (gone() ? resolve() : child.once('exit', resolve)));
      if (!gone()) {
        if (this.doc) await post(this.doc, '/stop', { force: true }, 15_000).catch(() => {});
        try {
          await withDeadline(exited, 'the daemon to exit after its stop', 60_000);
        } catch (error) {
          // Its process tree (the memory child it forked) ends by its pid; the handle is kept until the exit is seen.
          const kill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
          if (kill.status !== 0) throw new Error(`${error.message}; taskkill of pid ${child.pid} failed (${kill.error?.message ?? `exit ${kill.status}`})`);
          await withDeadline(exited, `the daemon pid ${child.pid} to exit after taskkill`, 15_000);
          throw error;
        } finally {
          if (gone()) {
            this.child = null;
            this.doc = null;
          }
        }
      }
      this.child = null;
      this.doc = null;
    });
    await step('the postmaster', async () => {
      const pgdata = this.env && join(this.env.MIXDOG_DATA_DIR, 'pgdata');
      // A daemon still running owns its cluster: it is left alone with the daemon (the failure above names the pid).
      if (this.child || !this.runtimeDir || !existsSync(join(pgdata, 'postmaster.pid'))) return;
      const stop = spawnSync(join(this.runtimeDir, 'bin', 'pg_ctl.exe'), ['stop', '-m', 'fast', '-w', '-t', '30', '-D', pgdata], { stdio: 'ignore', timeout: 40_000, windowsHide: true });
      // pg_ctl has no children of its own; a postmaster it failed to end is named so the run fails instead of leaving it unnoticed.
      if (stop.status !== 0 && existsSync(join(pgdata, 'postmaster.pid'))) {
        throw new Error(`pg_ctl stop failed (${stop.error?.message ?? `exit ${stop.status}`}); the postmaster in ${pgdata} is still running`);
      }
    });
  }
}

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

/** Starts the daemon under `run` (which owns the child and the watcher from their creation); resolves once it published `daemon.json` with its session
 *  endpoint (its own readiness record), with the time it took. */
async function startDaemon(run) {
  const { env } = run;
  const started = performance.now();
  const discovery = join(env.MIXDOG_RUNTIME_ROOT, 'daemon.json');
  const child = spawn(process.execPath, [join(tree, 'src/standalone/daemon.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  run.child = child;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  run.stderr = () => stderr;
  const read = () => {
    try {
      const doc = JSON.parse(readFileSync(discovery, 'utf8'));
      if (doc.pid === child.pid && doc.endpoints?.session?.port) return doc;
    } catch {}
    return null;
  };
  const ready = new Promise((resolve, reject) => {
    run.watcher = watch(env.MIXDOG_RUNTIME_ROOT, () => {
      const doc = read();
      if (doc) resolve(doc);
    });
    child.once('exit', (code) => reject(new Error(`the daemon exited ${code} before it was ready: ${stderr}`)));
    const doc = read();
    if (doc) resolve(doc);
  });
  try {
    run.doc = await withDeadline(ready, 'the daemon to publish daemon.json', 60_000);
  } finally {
    run.watcher.close();
    run.watcher = null;
  }
  return { readyMs: performance.now() - started, started };
}

/** One session-transport request: the HTTP status and the JSON body, as a client receives them, within `deadlineMs`. */
async function post(doc, path, body, deadlineMs = REQUEST_DEADLINE_MS) {
  const response = await fetch(`http://127.0.0.1:${doc.endpoints.session.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': doc.endpoints.session.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deadlineMs),
  });
  return { status: response.status, body: await withDeadline(response.json(), `the body of ${path}`, deadlineMs) };
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

const REQUESTS = [
  ['recall', ['build target', {}]],
  ['memoryControl', [{ action: 'status' }]],
];

/** Holds Node's own spawn lock for `run` until its end; resolves once the lock is held, rejects when it could not be taken. */
async function holdSpawnLock(run) {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let locked;
  const lockTaken = new Promise((resolve) => {
    locked = resolve;
  });
  const holding = withFileLock(join(run.env.MIXDOG_DATA_DIR, 'pg-spawn.lock'), () => {
    locked();
    return released;
  }, { timeoutMs: 5_000 });
  // The release is owned before the outcome is known: a lock taken late is still released by the run's end.
  run.releaseLock = async () => {
    release();
    await withDeadline(holding, 'the spawn lock to be released', 15_000);
  };
  await withDeadline(Promise.race([lockTaken, holding.then(() => Promise.reject(new Error('the lock ended before it was held')))]), 'the spawn lock to be taken', 15_000);
}

const SCENARIOS = [
  {
    name: 'recall then memoryControl while the spawn lock is held by another live process',
    requests: REQUESTS,
    setup: async (run) => {
      run.runtimeDir = installRuntime(run.env.MIXDOG_DATA_DIR);
      await holdSpawnLock(run);
    },
  },
  {
    // The memory database opens (the installed runtime, `initdb`, the postmaster) and holds nothing: the answer of an empty memory.
    name: 'recall on a fresh profile whose runtime is installed',
    requests: [REQUESTS[0]],
    setup: async (run) => {
      run.runtimeDir = installRuntime(run.env.MIXDOG_DATA_DIR);
    },
  },
  {
    name: 'recall then memoryControl when the runtime install fails',
    requests: REQUESTS,
    setup: async (run) => {
      writeFileSync(join(run.env.MIXDOG_DATA_DIR, 'runtime'), 'not a folder');
    },
  },
];

/** Node's deadlines a memory call can end at (`daemon-spawn.mjs:62,141,153`, `discovery.mjs`): the span an answer arrived in is recorded, not its time. */
const BUCKET_EDGES_S = [15, 30, 60, 90];
function bucket(ms) {
  const s = ms / 1000;
  const upper = BUCKET_EDGES_S.findIndex((edge) => s < edge);
  if (upper === 0) return `before ${BUCKET_EDGES_S[0]} s`;
  if (upper === -1) return `after ${BUCKET_EDGES_S.at(-1)} s`;
  return `${BUCKET_EDGES_S[upper - 1]}-${BUCKET_EDGES_S[upper]} s`;
}

/** Owns `run` from its creation: `body` runs under it, and its end runs whatever `body` did. */
async function owned(prefix, body) {
  const run = new Run(mkdtempSync(join(scratch, prefix)));
  let failed = null;
  try {
    run.env = profile(run.sandbox);
    return await body(run);
  } catch (error) {
    failed = error;
    console.error(`daemon exit code: ${run.child?.exitCode}\ndaemon stderr:\n${run.stderr?.() ?? ''}`);
    const log = run.env && join(run.env.MIXDOG_DATA_DIR, 'daemon.log');
    if (log && existsSync(log)) console.error(`daemon.log:\n${readFileSync(log, 'utf8').split('\n').slice(-60).join('\n')}`);
    throw error;
  } finally {
    try {
      await run.end();
    } catch (ended) {
      if (!failed) throw ended;
      console.error(`ending the run also failed: ${ended.message}`);
    }
  }
}

const scratch = process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir();
if (args.get('measure')) {
  await owned('rec-memory-first-measure-', async (run) => {
    run.runtimeDir = installRuntime(run.env.MIXDOG_DATA_DIR);
    for (const kind of ['fresh', 'existing', 'existing']) {
      const daemon = await startDaemon(run);
      const token = await register(run.doc);
      const sessionId = await createSession(run.doc, token, run.env);
      const answer = await configure(run.doc, token, sessionId, 'recall', ['build target', {}]);
      console.log(JSON.stringify({ run: kind, readyMs: Math.round(daemon.readyMs), firstAnswerMs: Math.round(performance.now() - daemon.started), answer }));
      await run.endDaemon();
    }
  });
} else {
  const only = args.get('only');
  const recorded = [];
  // `--only` runs one scenario by its name (nothing is compared or written then); without it every scenario runs.
  for (const scenario of SCENARIOS.filter((s) => !only || s.name === only)) {
    await owned('rec-memory-first-', async (run) => {
      await scenario.setup(run);
      await startDaemon(run);
      const token = await register(run.doc);
      const sessionId = await createSession(run.doc, token, run.env);
      const answers = [];
      for (const [action, actionArgs] of scenario.requests) {
        const started = performance.now();
        const answer = await configure(run.doc, token, sessionId, action, actionArgs);
        const waited = performance.now() - started;
        console.log(`${action} answered after ${Math.round(waited)} ms`);
        // An action's result carries the session's whole view (`full`: ids, times, the process's pid) beside the action's `value`; the memory answer is
        // the `value`, so only it is kept (an error answer is kept whole).
        const kept = answer.body?.result ? { status: answer.status, body: { result: { value: answer.body.result.value } } } : answer;
        answers.push({ action, args: actionArgs, answer: kept, answeredWithin: bucket(waited) });
      }
      recorded.push({ name: scenario.name, requests: answers });
      console.log(JSON.stringify(recorded.at(-1), null, 2));
    });
  }
  if (!only) {
    const setDir = join(FIXTURES_ROOT, 'memory-first-request');
    mkdirSync(setDir, { recursive: true });
    writeJson(join(setDir, 'golden.json'), { scenarios: recorded });
    writeSetManifest(setDir, { set: 'memory-first-request', recorder: RECORDER, command: `node ${RECORDER} --tree <b6f10295a export> --runtime <runtime>`, identity });
  }
}
