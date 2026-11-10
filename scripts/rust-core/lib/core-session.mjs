// A `mixdogd serve` on an isolated profile and a protocol-2 connection to it, for the scripts that replace the
// Node-core CI, release and benchmark steps (K1). Nothing here reaches the user's profile, daemon or credentials:
// every profile variable points under `root`, the parent's proxy/provider/MIXDOG_* variables are dropped, and the
// only process ever stopped is the one this module started.

import { copyFileSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { endTree, spawnTree } from './process-tree.mjs';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;

/** Every profile path of an isolated core, under `root`. */
export function isolatedPaths(root) {
  const home = join(root, 'home');
  return {
    root,
    home,
    mixdogHome: join(home, '.mixdog'),
    dataDir: join(home, '.mixdog', 'data'),
    runtimeRoot: join(root, 'runtime'),
    appData: join(home, 'AppData', 'Roaming'),
    localAppData: join(home, 'AppData', 'Local'),
    tmp: join(root, 'tmp'),
    workspace: join(root, 'ws'),
    bin: join(root, 'bin'),
  };
}

/** The core's environment: the parent's, minus what could leave the box, plus the nine isolation variables. */
export function isolatedEnv(paths, extra = {}, parent = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(parent)) if (!DROP.test(name)) env[name] = value;
  return {
    ...env,
    MIXDOG_DATA_DIR: paths.dataDir,
    MIXDOG_HOME: paths.mixdogHome,
    MIXDOG_CONFIG_DIR: paths.mixdogHome,
    MIXDOG_DESKTOP_USER_DATA: join(paths.appData, 'Mixdog'),
    MIXDOG_RUNTIME_ROOT: paths.runtimeRoot,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    TMPDIR: paths.tmp,
    NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  };
}

/** Lays out the profile and the workspace, and stages `bin` with the `js-runtime.json` the core reads beside itself. */
export function stageProfile(paths, { bin, config = {}, packageRoot = REPO_ROOT }) {
  for (const dir of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace, paths.bin]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const staged = join(paths.bin, process.platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');
  copyFileSync(bin, staged);
  writeFileSync(join(paths.bin, 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot }));
  return staged;
}

/** Resolves with the discovery document once the core is `serving` (watches the runtime root; no polling). */
export function waitServing(runtimeRoot, { timeoutMs = 120_000 } = {}) {
  const file = join(runtimeRoot, 'daemon.json');
  return new Promise((resolveDoc, reject) => {
    let watcher;
    const timer = setTimeout(() => finish(new Error(`the core was not serving after ${timeoutMs} ms`)), timeoutMs);
    const finish = (error, doc) => {
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolveDoc(doc);
    };
    const check = () => {
      let doc;
      try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return;
      }
      if (doc?.core?.state === 'blocked') finish(new Error(`the core is blocked: ${JSON.stringify(doc.core.blocked)}`));
      else if (doc?.core?.state === 'serving' && doc.core.rpc?.port) finish(null, doc);
    };
    watcher = watch(runtimeRoot, check);
    check();
  });
}

let libraries;
/** The protocol client (TypeScript source) and `ws`, loaded once. `@mixdog/protocol` is a workspace file dependency
 *  that is not installed, so the specifier is mapped to its source. */
async function loadLibraries() {
  libraries ??= (async () => {
    const target = pathToFileURL(join(REPO_ROOT, 'packages', 'protocol', 'src', 'index.ts')).href;
    register(
      `data:text/javascript,${encodeURIComponent(
        `export async function resolve(s, c, next) { return s === '@mixdog/protocol' ? { url: ${JSON.stringify(target)}, shortCircuit: true } : next(s, c); }`,
      )}`,
    );
    const { default: WebSocket } = await import('ws');
    const client = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'protocol-client', 'src', 'index.ts')).href);
    return { WebSocket, client };
  })();
  return libraries;
}

function connectorFor(WebSocket, doc) {
  const port = doc.core.rpc.port;
  const token = doc.endpoints.session.token;
  return {
    async open(_target, sink) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: false });
      const writer = { send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason) };
      return new Promise((resolveWriter, reject) => {
        let opened = false;
        socket.on('open', () => {
          opened = true;
          resolveWriter(writer);
        });
        socket.on('message', (data, isBinary) => {
          if (isBinary) return socket.close(1007, 'binary frame');
          sink.frame(data.toString('utf8'));
        });
        socket.on('close', (code, reason) => {
          if (opened) sink.closed(code, reason.toString('utf8'));
        });
        socket.on('error', (error) => {
          if (!opened) reject(error);
        });
        socket.on('unexpected-response', (_request, response) => {
          reject(new Error(`core refused the connection (HTTP ${response.statusCode})`));
          socket.terminate();
        });
      });
    },
  };
}

async function connectTo(doc, clientName) {
  const { WebSocket, client: lib } = await loadLibraries();
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  return lib.connect({
    target: { id: 'local' },
    connector: connectorFor(WebSocket, doc),
    clientInfo: { name: clientName, title: clientName, version: String(version), kind: 'tui' },
    capabilities: {},
    threadReducer: lib.sessionReducer,
    clock: { sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) },
    random: Math.random,
  });
}

/** Resolves with the next value of `read()` that is not undefined, as the store changes (no polling). */
export function waitStore(client, read) {
  return new Promise((resolveValue) => {
    let stop = () => {};
    const check = () => {
      const value = read();
      if (value === undefined) return false;
      stop();
      resolveValue(value);
      return true;
    };
    stop = client.store.subscribe(check);
    if (check()) stop();
  });
}

/** A connection to the core already serving under `runtimeRoot` (the user's own: never started or stopped here). */
export async function attachCore({ runtimeRoot, clientName = 'k1-ci', timeoutMs }) {
  const doc = await waitServing(runtimeRoot, { timeoutMs });
  const client = await connectTo(doc, clientName);
  return { discovery: doc, client, call: (method, params) => client.call(method, params), close: () => client.close() };
}

/** `promise`, or a rejection saying what `what` did not finish within `ms` (a deadline, not a wait). */
export function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Ends the process this module started and everything it started, by its own handle only (never a name or pattern), and waits for its exit. */
async function endChild(child, exited, ms = 15_000) {
  await endTree(child);
  await within(exited, ms, `the killed core (pid ${child.pid}) exiting`);
}
/**
 * Starts `bin serve` on the profile under `root` and connects to it.
 * @param {object} options
 * @param {string} options.bin     the `mixdogd` binary to stage (never run in place: it needs `js-runtime.json` beside it)
 * @param {string} options.root    an empty directory the whole profile lives under
 * @param {object} [options.config] the profile's `mixdog-config.json`
 * @param {(paths: object) => void} [options.prepare] runs after the profile is laid out and before the core starts
 */
export async function startCore({ bin, root, config, prepare, extraEnv = {}, readyTimeoutMs, clientName = 'k1-ci' }) {
  const paths = isolatedPaths(root);
  const exe = stageProfile(paths, { bin, config });
  prepare?.(paths);
  const tail = [];
  // The process-start instant: the boot budget runs from here, not from the staging copy above.
  const spawnedAt = performance.now();
  const child = spawnTree(exe, ['serve'], { env: isolatedEnv(paths, extraEnv), cwd: paths.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      tail.push(...chunk.split(/\r?\n/).filter(Boolean).map((line) => `[${stream}] ${line}`));
      tail.splice(0, Math.max(0, tail.length - 40));
    });
  }
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const failIfExited = exited.then(({ code, signal }) => {
    throw new Error(`the core exited (code=${code} signal=${signal}) before it was ready:\n${tail.join('\n')}`);
  });
  failIfExited.catch(() => {});
  let client = null;
  try {
    const doc = await Promise.race([waitServing(paths.runtimeRoot, { timeoutMs: readyTimeoutMs }), failIfExited]);
    client = await connectTo(doc, clientName);
    return {
      paths,
      discovery: doc,
      client,
      pid: child.pid,
      spawnedAt,
      tail: () => tail.join('\n') || '(no output)',
      call: (method, params) => client.call(method, params),
      /**
       * `POST /mgmt/stop` (the core's own stop, as `mixdogd ctl stop --when-idle --reason quit`), then the exit.
       * Every step has a deadline (`timeoutMs`); on any failure the child this call started is ended by its own
       * handle and the failure is thrown with the core's output tail. A clean answer is the `{ code, signal }` of the exit.
       */
      async stop({ timeoutMs = 15_000 } = {}) {
        try {
          if (client) {
            const closing = client;
            client = null;
            await within(closing.close(), timeoutMs, 'closing the protocol connection');
          }
          const response = await fetch(`http://127.0.0.1:${doc.core.control.port}/mgmt/stop`, {
            method: 'POST',
            headers: { authorization: `Bearer ${doc.endpoints.session.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) throw new Error(`/mgmt/stop answered ${response.status}: ${await response.text()}`);
          return await within(exited, timeoutMs, 'the core exiting after /mgmt/stop');
        } catch (error) {
          await endChild(child, exited);
          throw new Error(`stopping the core failed: ${error.message}\n${tail.join('\n') || '(no output)'}`, { cause: error });
        }
      },    };
  } catch (error) {
    await within(client?.close() ?? Promise.resolve(), 15_000, 'closing the protocol connection').catch(() => {});
    await endChild(child, exited);
    throw error;
  }
}
