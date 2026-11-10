// A real daemon of any source tree, launched the way a session client launches
// it (the tree's own ensureDaemon), in an isolated home, behind the observation
// entry (daemon-steady-entry.mjs). Used by daemon-steady-state.slow.test.mjs and
// scripts/daemon-load-bench.mjs.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Larger than any stall: a call with this never gives up (the largest setTimeout delay). */
export const NO_DEADLINE_MS = 2 ** 31 - 1;
const ENTRY = fileURLToPath(new URL('./daemon-steady-entry.mjs', import.meta.url));
const HEAD_TREE = new URL('../../../', import.meta.url);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** One loopback connection to the probe in the daemon: `start` opens a
 *  window, `stop` closes it and returns what the window saw. */
async function connectProbe(portFile) {
  let port = 0;
  for (let i = 0; i < 200 && !port; i += 1) {
    try {
      port = Number(readFileSync(portFile, 'utf8'));
    } catch {
      await delay(50);
    }
  }
  if (!port) throw new Error('the daemon probe never published its port');
  const socket = net.connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  let pending = '';
  const waiting = [];
  socket.on('data', (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      waiting.shift()?.resolve(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  // A probe that goes away (daemon exit, socket error) fails what waits on it
  // instead of leaving the caller hanging.
  let lost = null;
  const lose = (error) => {
    lost ??= error;
    for (const waiter of waiting.splice(0)) waiter.reject(lost);
  };
  socket.on('error', lose);
  socket.on('close', () => lose(new Error('probe disconnected')));
  const ask = (command) =>
    new Promise((resolve, reject) => {
      if (lost) {
        reject(lost);
        return;
      }
      waiting.push({ resolve, reject });
      socket.write(`${command}\n`);
    });
  // `ticker: true` also runs the in-daemon gap ticker for this window.
  return {
    start: ({ ticker = false } = {}) => ask(ticker ? 'start ticker' : 'start'),
    stop: () => ask('stop'),
    close: () => socket.destroy(),
  };
}

/**
 * @param {object} options
 * @param {URL|string} [options.tree]  source tree root (default: this checkout)
 * @param {string} [options.mutation]  absolute path of a module the daemon loads first
 * @param {string[]} [options.execArgv]  node flags for the daemon
 * @param {Function} [options.prepare]  async ({ root, dataDir }) run before the daemon starts
 * @param {string} [options.base]  where the isolated root is created. The
 *   sessions' cwd lives in it, and the daemon watches every ancestor of a cwd
 *   (git HEAD cache): a base under a busy directory wakes it with that
 *   directory's events.
 */
export async function launchObservedDaemon({
  tree = HEAD_TREE,
  mutation = '',
  execArgv = [],
  base = tmpdir(),
  prepare = null,
} = {}) {
  const treeRoot = tree instanceof URL ? tree : pathToFileURL(`${String(tree).replace(/[\\/]+$/, '')}/`);
  const root = mkdtempSync(join(base, 'mixdog-steady-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.mixdog', 'data');
  mkdirSync(dataDir, { recursive: true });
  // `prepare({ root, dataDir })`: seeds the isolated home before the daemon starts.
  try {
    await prepare?.({ root, dataDir });
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    throw error;
  }
  const portFile = join(root, 'probe-port');
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_DISABLE_MCP: '1',
    MIXDOG_PROBE_PORT_FILE: portFile,
    MIXDOG_PROBE_DAEMON_URL: new URL('src/standalone/daemon.mjs', treeRoot).href,
    MIXDOG_STEADY_STATE_MUTATION: mutation ? pathToFileURL(mutation).href : '',
    HOME: home,
    USERPROFILE: home,
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  const previousExecArgv = process.execArgv;
  for (const [name, value] of Object.entries(env)) {
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  // The launcher passes its execArgv on: the daemon runs as a plain script
  // unless the caller asks for node flags (a CPU profile).
  process.execArgv = execArgv;

  const client = await import(new URL('src/standalone/session-client.mjs', treeRoot).href);
  const clients = [];
  const sessionClients = new Map();
  let discovery = null;
  let probe = null;
  let disposed = false;

  // `afterExit`: runs once the daemon has exited, before the root is removed.
  async function dispose({ afterExit = null } = {}) {
    if (disposed) return;
    disposed = true;
    probe?.close();
    for (const attached of clients) await attached.close().catch(() => {});
    const pid = Number(discovery?.pid);
    let stopped = null;
    if (discovery) {
      stopped = await client.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 20_000 }).then(
        () => null,
        (error) => error
      );
    }
    let afterExitError = null;
    try {
      await afterExit?.(stopped);
    } catch (error) {
      afterExitError = error;
    }
    if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && pid > 0 && isAlive(pid); i += 1) await delay(50);
    process.execArgv = previousExecArgv;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // Its helper processes release the fixture shortly after it exits. The
    // promise rm, unlike Electron's native rmSync, removes git's read-only
    // object files on Windows.
    await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    if (afterExitError) throw afterExitError;
  }

  try {
    discovery = await client.ensureDaemon({ cwd: root, attempts: 2, readyTimeoutMs: 60_000, entry: ENTRY });
    probe = await connectProbe(portFile);
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    root,
    discovery,
    dataDir,
    daemonLog: () => {
      try {
        return readFileSync(join(dataDir, 'daemon.log'), 'utf8');
      } catch {
        return '';
      }
    },
    window: probe,
    /** One more client attachment (closed by `dispose`): `call(name, args)` is
     *  the daemon's client protocol. */
    async attach({ cwd = root } = {}) {
      const attached = await client.attachSession({ discovery, cwd });
      clients.push(attached);
      return attached;
    },
    /** `count` sessions, each over its own client attachment (a terminal each). */
    async openSessions(count, { cwd = root } = {}) {
      const created = await Promise.all(
        Array.from({ length: count }, async () => {
          const attached = await client.attachSession({ discovery, cwd });
          clients.push(attached);
          // No deadline: a stalled daemon answers late, and that is a result.
          const session = await attached.call(
            'session.create',
            {
              cwd,
              provider: 'openai',
              model: 'gpt-4o-mini',
              toolMode: 'full',
              remote: false,
              desktopSession: null,
            },
            { timeoutMs: NO_DEADLINE_MS }
          );
          const sessionId = String(session?.sessionId || '');
          sessionClients.set(sessionId, attached);
          return sessionId;
        })
      );
      if (created.some((id) => !id)) throw new Error('session.create returned no sessionId');
      return created;
    },
    /** The client attachment a session returned by `openSessions` was created over. */
    sessionClient: (sessionId) => sessionClients.get(sessionId),
    dispose,
  };
}
