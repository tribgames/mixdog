// Lifecycle supervisor for one isolated desktop instance.
// Owns all child processes inside one Windows Job Object, proxies the instance's CDP port so
// client connections are observed directly as use (pausing idle shutdown while attached and
// starting the idle countdown on disconnect), serves the built dev renderer and optional
// loopback phone relay in-process, and tears down the whole unit automatically on idle timeout,
// TTL expiry, owner-process exit, session scratch-dir removal, app exit, or /stop request.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { registerHooks } from 'node:module';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createProcessGroup, getProcessCreationTimeMs, watchProcessExit } from './dev-isolated-job.mjs';
import { cleanupStoppedInstance, instanceProcessIds, listProcesses, updateLeaseLastUsed } from './dev-isolated.mjs';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

function insideDir(target, parent) {
  const rel = relative(resolve(parent), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
}

function startStaticRendererServer(rendererDir, port) {
  const root = resolve(rendererDir);
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!relPath) relPath = 'index.html';
        let filePath = resolve(root, relPath);
        if (!insideDir(filePath, root)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        let info = await stat(filePath).catch(() => null);
        if (info?.isDirectory()) {
          filePath = join(filePath, 'index.html');
          info = await stat(filePath).catch(() => null);
        }
        if (!info?.isFile()) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const body = await readFile(filePath);
        const type = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500);
        res.end(error?.message || 'Internal error');
      }
    });
    server.once('error', rejectServer);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolveServer(server));
  });
}

function allocateLoopbackPort(avoid = new Set()) {
  return new Promise((resolvePort, rejectPort) => {
    const tryOnce = (attemptsLeft) => {
      const probe = createNetServer();
      probe.once('error', rejectPort);
      probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const port = probe.address().port;
        probe.close(() => {
          if (!avoid.has(port) || attemptsLeft <= 0) resolvePort(port);
          else tryOnce(attemptsLeft - 1);
        });
      });
    };
    tryOnce(10);
  });
}

function mergeBuildInputsTarget(manifestPath, target, filePaths) {
  if (!manifestPath) return;
  const files = {};
  for (const raw of [...filePaths].sort()) {
    try {
      const real = realpathSync(raw);
      const st = statSync(real);
      if (st.isFile()) files[real] = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      // Ignore vanished or non-file paths.
    }
  }
  mkdirSync(dirname(manifestPath), { recursive: true });
  let current = {};
  try {
    current = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    current = {};
  }
  current[target] = { files, dirs: {} };
  const tmp = `${manifestPath}.${process.pid}.${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(current));
  renameSync(tmp, manifestPath);
}

function rewriteEndpointPort(rawUrl, targetPort, listenPort) {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
  const targetStr = String(targetPort);
  const listenStr = String(listenPort);
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port === targetStr) {
      parsed.port = listenStr;
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

function rewriteDevtoolsFrontendUrl(rawUrl, targetPort, listenPort) {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
  const targetStr = String(targetPort);
  const listenStr = String(listenPort);
  return rawUrl.replace(
    new RegExp(`([?&]wss?=(?:127\\.0\\.0\\.1|localhost)):${targetStr}(?=[/&]|$)`, 'gi'),
    `$1:${listenStr}`
  );
}

function rewriteCdpTargetObject(entry, targetPort, listenPort) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const next = { ...entry };
  if (typeof next.webSocketDebuggerUrl === 'string') {
    next.webSocketDebuggerUrl = rewriteEndpointPort(next.webSocketDebuggerUrl, targetPort, listenPort);
  }
  if (typeof next.devtoolsFrontendUrl === 'string') {
    next.devtoolsFrontendUrl = rewriteDevtoolsFrontendUrl(next.devtoolsFrontendUrl, targetPort, listenPort);
  }
  return next;
}

/** Parses a CDP `/json*` response body and rewrites only `webSocketDebuggerUrl` and
 *  `devtoolsFrontendUrl` so page URLs and titles containing the internal port stay untouched. */
export function rewriteCdpJsonBody(raw, targetPort, listenPort) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map((item) => rewriteCdpTargetObject(item, targetPort, listenPort)));
  }
  if (parsed && typeof parsed === 'object') {
    return JSON.stringify(rewriteCdpTargetObject(parsed, targetPort, listenPort));
  }
  return raw;
}

/** Proxies HTTP + WebSocket CDP traffic from public `listenPort` to Electron's `targetPort`,
 *  rewriting `webSocketDebuggerUrl` and `devtoolsFrontendUrl` on `/json*` responses and reporting active/idle transitions. */
export function startCdpProxy({
  listenPort,
  targetPort,
  onActivityStart = () => {},
  onActivityEnd = () => {},
}) {
  const activeSockets = new Set();
  let activeRequests = 0;

  const server = createServer((req, res) => {
    activeRequests += 1;
    onActivityStart();
    let ended = false;
    const finishReq = () => {
      if (ended) return;
      ended = true;
      activeRequests = Math.max(0, activeRequests - 1);
      onActivityEnd();
    };
    res.once('close', finishReq);
    res.once('finish', finishReq);

    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upRes) => {
        const urlPath = (req.url || '').split('?', 1)[0];
        const isJsonMeta = urlPath === '/json' || urlPath.startsWith('/json/');
        if (isJsonMeta) {
          const chunks = [];
          upRes.on('data', (chunk) => chunks.push(chunk));
          upRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const rewritten = rewriteCdpJsonBody(raw, targetPort, listenPort);
            const body = Buffer.from(rewritten, 'utf8');
            const resHeaders = { ...upRes.headers, 'content-length': String(body.length) };
            delete resHeaders['transfer-encoding'];
            res.writeHead(upRes.statusCode || 200, resHeaders);
            res.end(body);
          });
        } else {
          res.writeHead(upRes.statusCode || 200, upRes.headers);
          upRes.pipe(res);
        }
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'text/plain', Connection: 'close' });
      }
      res.end('CDP upstream unavailable');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    onActivityStart();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSockets.delete(clientSocket);
      onActivityEnd();
    };
    const upstream = netConnect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/${req.httpVersion || '1.1'}`];
      let hasHost = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const val = req.rawHeaders[i + 1];
        if (key.toLowerCase() === 'host') {
          lines.push(`Host: 127.0.0.1:${targetPort}`);
          hasHost = true;
        } else {
          lines.push(`${key}: ${val}`);
        }
      }
      if (!hasHost) lines.push(`Host: 127.0.0.1:${targetPort}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const tearDown = () => {
      release();
      if (!upstream.destroyed) upstream.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    };
    upstream.once('error', tearDown);
    upstream.once('close', tearDown);
    clientSocket.once('error', tearDown);
    clientSocket.once('close', tearDown);
  });

  return new Promise((resolveProxy, rejectProxy) => {
    server.once('error', rejectProxy);
    server.listen({ host: '127.0.0.1', port: listenPort, exclusive: true }, () => {
      resolveProxy({
        server,
        port: server.address().port,
        activeClientCount: () => activeSockets.size,
        activeRequestCount: () => activeRequests,
        close: () =>
          new Promise((resolveClose) => {
            for (const sock of activeSockets) sock.destroy();
            activeSockets.clear();
            server.closeAllConnections?.();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'ready-port': { type: 'string' },
      'ready-token': { type: 'string' },
      foreground: { type: 'boolean', default: false },
    },
  });
  if (!values.config) throw new Error('--config is required.');
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  const {
    root,
    name,
    instanceDir,
    profile,
    appDir,
    desktopDir,
    cdpPort,
    rendererPort,
    mode = 'capture',
    relayMode = 'off',
    relayUrl: explicitRelayUrl = 'off',
    idleMs,
    ttlMs,
    ownerPid = null,
    sessionDir = null,
    sessionId = null,
    controlToken,
    devProfileDir,
    inspectMain = null,
    electronExecPath,
    electronViteBin,
    logPath,
    startedAt,
    buildInputsPath = null,
    env: baseEnv,
  } = config;

  const job = createProcessGroup();
  let staticServer = null;
  let cdpProxy = null;
  let relay = null;
  let controlServer = null;
  let appChild = null;
  let idleTimer = null;
  let ttlTimer = null;
  let ownerWatch = { active: false, cancel() {} };
  let sessionWatcher = null;
  let lastUsedAt = Date.now();
  let shuttingDown = null;
  const browserEntries = new Map();
  let activeRelaySockets = 0;

  const isBusy = () =>
    (cdpProxy?.activeClientCount() ?? 0) > 0 ||
    (cdpProxy?.activeRequestCount() ?? 0) > 0 ||
    browserEntries.size > 0 ||
    activeRelaySockets > 0;

  const statusPayload = () => ({
    ok: true,
    name,
    supervisorPid: process.pid,
    supervisorCreated: getProcessCreationTimeMs(process.pid),
    appPid: appChild?.pid ?? null,
    cdpPort,
    rendererPort,
    relayUrl: activeRelayUrl,
    mode,
    startedAt,
    lastUsedAt: new Date(lastUsedAt).toISOString(),
    idleMs,
    idlePaused: isBusy(),
    activeCdpClients: cdpProxy?.activeClientCount() ?? 0,
    idleExpiresAt:
      !isBusy() && Number.isFinite(idleMs) && idleMs > 0 ? new Date(lastUsedAt + idleMs).toISOString() : null,
    expiresAt: new Date(Date.parse(startedAt) + ttlMs).toISOString(),
    ownerPid,
    sessionId,
    browsers: [...browserEntries.keys()],
  });

  function cleanupBrowserEntry(entry, { terminateJob = false, persist = true } = {}) {
    if (!entry || entry.cleaned) return Promise.resolve();
    entry.cleaned = true;
    browserEntries.delete(entry.pid);
    entry.browserWatch.cancel();
    entry.ownerWatch.cancel();
    if (entry.browserJob) {
      if (terminateJob) entry.browserJob.terminate();
      else entry.browserJob.close();
    }
    if (terminateJob && entry.profileDir && insideDir(entry.profileDir, join(instanceDir, 'capture-profiles'))) {
      import('node:fs/promises')
        .then(({ rm }) => rm(entry.profileDir, { recursive: true, force: true }))
        .catch(() => {});
    }
    return markActivityEnd({ persist });
  }

  function registerCaptureBrowser(pid, captureOwnerPid, profileDir = null) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (browserEntries.has(pid)) return true;
    // Give each capture browser its own supervisor-owned Job Object (KILL_ON_JOB_CLOSE):
    // works even if the browser lives in a different parent job chain than appChild, terminates
    // with the supervisor on crash/shutdown, and can be killed independently if its capture script dies.
    const browserJob = createProcessGroup();
    if (!browserJob.assign(pid)) {
      browserJob.close();
      return false;
    }
    // Also assign any helper children the browser already spawned before /browser/assign arrived.
    try {
      const browserCreated = getProcessCreationTimeMs(pid);
      const ancestors = new Map([[pid, browserCreated]]);
      const descendants = instanceProcessIds(listProcesses(), {
        ancestors,
        needle:
          profileDir && insideDir(profileDir, join(instanceDir, 'capture-profiles')) ? profileDir : undefined,
        minCreatedAt: typeof browserCreated === 'number' ? browserCreated : undefined,
      });
      for (const childPid of descendants) browserJob.assign(childPid);
    } catch {
      // Best-effort adoption of pre-existing children; future children inherit browserJob automatically.
    }
    const entry = {
      pid,
      ownerPid: Number.isInteger(captureOwnerPid) && captureOwnerPid > 0 ? captureOwnerPid : null,
      profileDir: typeof profileDir === 'string' && profileDir ? resolve(profileDir) : null,
      browserJob,
      browserWatch: { cancel() {} },
      ownerWatch: { cancel() {} },
      cleaned: false,
    };
    browserEntries.set(pid, entry);
    // Observe browser exit directly so browserEntries shrinks even if /browser/release never arrives.
    entry.browserWatch = watchProcessExit(pid, () => {
      void cleanupBrowserEntry(entry, { terminateJob: false, persist: true });
    });
    // Observe the capture process that launched this browser: if it dies mid-run, terminate the browser tree too.
    if (entry.ownerPid && entry.ownerPid !== process.pid) {
      entry.ownerWatch = watchProcessExit(entry.ownerPid, () => {
        void cleanupBrowserEntry(entry, { terminateJob: true, persist: true });
      });
    }
    return true;
  }

  let persistChain = Promise.resolve();
  function persistLastUsed(iso) {
    persistChain = persistChain
      .then(() => updateLeaseLastUsed(root, name, startedAt, iso))
      .catch(() => {});
    return persistChain;
  }

  function disarmIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleIfQuiet() {
    disarmIdle();
    if (!isBusy() && Number.isFinite(idleMs) && idleMs > 0) {
      idleTimer = setTimeout(() => void shutdown('idle-timeout'), idleMs);
      idleTimer.unref?.();
    }
  }

  function resetIdle({ persist = false } = {}) {
    lastUsedAt = Date.now();
    const iso = new Date(lastUsedAt).toISOString();
    armIdleIfQuiet();
    return persist ? persistLastUsed(iso) : Promise.resolve();
  }

  function markActivityStart({ persist = false } = {}) {
    lastUsedAt = Date.now();
    disarmIdle();
    return persist ? persistLastUsed(new Date(lastUsedAt).toISOString()) : Promise.resolve();
  }

  function markActivityEnd({ persist = true } = {}) {
    lastUsedAt = Date.now();
    const iso = new Date(lastUsedAt).toISOString();
    armIdleIfQuiet();
    return persist ? persistLastUsed(iso) : Promise.resolve();
  }

  async function shutdown(reason, { exitAfter = true } = {}) {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      disarmIdle();
      if (ttlTimer) clearTimeout(ttlTimer);
      ownerWatch.cancel();
      for (const entry of [...browserEntries.values()]) {
        entry.cleaned = true;
        entry.browserWatch.cancel();
        entry.ownerWatch.cancel();
        entry.browserJob?.terminate();
      }
      browserEntries.clear();
      try {
        sessionWatcher?.close();
      } catch {
        // Ignore watcher close errors.
      }
      await Promise.all([
        cdpProxy ? cdpProxy.close().catch(() => {}) : Promise.resolve(),
        relay ? relay.close().catch(() => {}) : Promise.resolve(),
        staticServer
          ? new Promise((resolveClose) => {
              staticServer.closeAllConnections?.();
              staticServer.close(() => resolveClose());
            })
          : Promise.resolve(),
      ]);
      // Atomically terminate every process in the instance's Windows Job Object
      // (Electron, Vite/esbuild, mixdogd, ext-worker, postgres, capture browsers).
      job.terminate();
      await persistChain;
      const result = await cleanupStoppedInstance(
        root,
        name,
        { devProfileDir, killed: job.pids(), reason }
      ).catch((error) => ({
        name,
        killed: job.pids(),
        remaining: [],
        removed: false,
        carried: [],
        error: error.message,
      }));
      if (exitAfter) {
        if (controlServer) {
          controlServer.closeAllConnections?.();
          controlServer.close(() => process.exit(0));
        } else {
          process.exit(0);
        }
      }
      return { ...result, reason };
    })();
    return shuttingDown;
  }

  let activeRelayUrl = explicitRelayUrl;
  try {
    const rendererDir = join(appDir, 'out', 'renderer');
    if (mode === 'capture') {
      staticServer = await startStaticRendererServer(rendererDir, rendererPort);
    }
    if (relayMode === 'builtin') {
      const relayDataDir = join(instanceDir, 'relay-data');
      await mkdir(relayDataDir, { recursive: true });
      const relayServerPath = join(desktopDir, '..', 'relay', 'server.mjs');
      const relayFiles = new Set([relayServerPath]);
      const hook = registerHooks({
        load(url, context, nextLoad) {
          if (url.startsWith('file://')) {
            const loadedPath = fileURLToPath(url);
            if (!loadedPath.includes(`${sep}node_modules${sep}`)) relayFiles.add(loadedPath);
          }
          return nextLoad(url, context);
        },
      });
      let startRelay;
      try {
        ({ startRelay } = await import(pathToFileURL(relayServerPath).href));
      } finally {
        hook.deregister();
      }
      if (buildInputsPath) mergeBuildInputsTarget(buildInputsPath, 'relay', relayFiles);
      relay = await startRelay({ port: 0, dataDir: relayDataDir, rendererDir });
      activeRelayUrl = `ws://127.0.0.1:${relay.port}`;
      relay.server?.on?.('upgrade', (req, socket) => {
        const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        if (pathname !== '/ws') return;
        activeRelaySockets += 1;
        void markActivityStart({ persist: true });
        socket.once('close', () => {
          activeRelaySockets = Math.max(0, activeRelaySockets - 1);
          void markActivityEnd({ persist: true });
        });
      });
    }

    const internalCdpPort = await allocateLoopbackPort(new Set([cdpPort, rendererPort]));
    cdpProxy = await startCdpProxy({
      listenPort: cdpPort,
      targetPort: internalCdpPort,
      onActivityStart: () => void markActivityStart({ persist: true }),
      onActivityEnd: () => void markActivityEnd({ persist: true }),
    });

    const childEnv = {
      ...baseEnv,
      MIXDOG_RELAY_URL: activeRelayUrl,
      ELECTRON_EXEC_PATH: electronExecPath,
      ...(buildInputsPath ? { MIXDOG_BUILD_INPUTS_MANIFEST: buildInputsPath } : {}),
      ...(mode === 'capture' ? { ELECTRON_RENDERER_URL: `http://127.0.0.1:${rendererPort}/` } : {}),
    };

    const logFd = openSync(logPath, 'a');
    if (mode === 'capture') {
      appChild = spawn(
        electronExecPath,
        [
          appDir,
          `--remote-debugging-port=${internalCdpPort}`,
          ...(inspectMain ? [`--inspect=${inspectMain}`] : []),
        ],
        { cwd: desktopDir, env: childEnv, windowsHide: true, stdio: ['ignore', logFd, logFd] }
      );
    } else {
      appChild = spawn(
        process.execPath,
        [
          electronViteBin,
          'dev',
          '--remoteDebuggingPort',
          String(internalCdpPort),
          '--outDir',
          join(appDir, 'out'),
          '--clearScreen',
          'false',
          ...(inspectMain ? ['--inspect', String(inspectMain)] : []),
        ],
        { cwd: desktopDir, env: childEnv, windowsHide: true, stdio: ['ignore', logFd, logFd] }
      );
    }
    closeSync(logFd);
    if (appChild.pid) job.assign(appChild.pid);
    appChild.once('exit', () => {
      if (!shuttingDown) void shutdown('app-exited');
    });
    appChild.once('error', () => {
      if (!shuttingDown) void shutdown('app-error');
    });

    controlServer = createServer(async (req, res) => {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${controlToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      try {
        if (req.method === 'GET' && url.pathname === '/status') {
          if (url.searchParams.get('touch') === '1') await resetIdle({ persist: true });
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify(statusPayload()));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/touch') {
          await resetIdle({ persist: true });
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify(statusPayload()));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/browser/assign') {
          const body = await readBodyJson(req);
          const pid = Number(body?.pid);
          const captureOwnerPid = Number(body?.ownerPid);
          const profileDir = typeof body?.profileDir === 'string' ? body.profileDir : null;
          const assigned = registerCaptureBrowser(pid, captureOwnerPid, profileDir);
          if (assigned) await markActivityStart({ persist: true });
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ ok: true, assigned, pid }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/browser/release') {
          const body = await readBodyJson(req);
          const pid = Number(body?.pid);
          const entry = Number.isInteger(pid) ? browserEntries.get(pid) : null;
          if (entry) {
            await cleanupBrowserEntry(entry, { terminateJob: false, persist: true });
          } else {
            await markActivityEnd({ persist: true });
          }
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/stop') {
          const result = await shutdown('requested', { exitAfter: false });
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify(result), () => {
            controlServer.closeAllConnections?.();
            controlServer.close(() => process.exit(0));
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not-found' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || 'internal-error' }));
      }
    });

    await new Promise((resolveListen, rejectListen) => {
      controlServer.once('error', rejectListen);
      controlServer.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
    });
    const controlPort = controlServer.address().port;

    // Event-driven lifecycle bounds: idle timeout, TTL, owner-process exit, session scratch removal.
    resetIdle();
    if (Number.isFinite(ttlMs) && ttlMs > 0) {
      ttlTimer = setTimeout(() => void shutdown('ttl-expired'), ttlMs);
      ttlTimer.unref?.();
    }
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      ownerWatch = watchProcessExit(ownerPid, (why) => void shutdown(`owner-${why}`));
    }
    if (sessionDir && existsSync(sessionDir)) {
      const parent = dirname(sessionDir);
      if (existsSync(parent)) {
        sessionWatcher = watch(parent, () => {
          if (!existsSync(sessionDir)) void shutdown('session-ended');
        });
        sessionWatcher.on('error', () => {});
        sessionWatcher.unref?.();
      }
    }
    if (values.foreground) {
      process.stdin.resume();
      process.stdin.once('end', () => void shutdown('stdin-closed'));
      process.stdin.once('close', () => void shutdown('stdin-closed'));
    }
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    if (values['ready-port']) {
      await fetch(`http://127.0.0.1:${Number(values['ready-port'])}/ready`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${values['ready-token'] || ''}`,
        },
        body: JSON.stringify({
          supervisorPid: process.pid,
          supervisorCreated: getProcessCreationTimeMs(process.pid),
          appPid: appChild.pid,
          appCreated: appChild?.pid ? getProcessCreationTimeMs(appChild.pid) : null,
          controlPort,
          relayUrl: activeRelayUrl,
        }),
      });
    }
  } catch (error) {
    if (values['ready-port']) {
      await fetch(`http://127.0.0.1:${Number(values['ready-port'])}/error`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${values['ready-token'] || ''}`,
        },
        body: JSON.stringify({ error: error?.message || String(error) }),
      }).catch(() => {});
    }
    await shutdown('start-failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
