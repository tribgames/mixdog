import { fork } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { claimSingletonOwner, readSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT ? resolve(process.env.MIXDOG_RUNTIME_ROOT) : join(tmpdir(), 'mixdog');
}

function activeInstancePath() {
  return join(runtimeRoot(), 'active-instance.json');
}

function readActiveInstance() {
  try {
    return JSON.parse(readFileSync(activeInstancePath(), 'utf8'));
  } catch {
    return null;
  }
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function parsePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid) {
  const n = parsePid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestJson({ port, method = 'GET', path = '/', body = null, timeoutMs = 10_000, headers = {} }) {
  return new Promise((resolvePromise, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (res.statusCode && res.statusCode >= 400) {
          const message = parsed?.error
            || parsed?.content?.[0]?.text
            || data
            || `HTTP ${res.statusCode}`;
          const error = new Error(message);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        resolvePromise(parsed ?? { raw: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`memory proxy request timed out: ${method} ${path}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function createStandaloneMemoryRuntime({
  entry,
  dataDir,
  cwd = process.cwd(),
} = {}) {
  if (!entry) throw new Error('memory runtime entry is required');
  if (!dataDir) throw new Error('memory runtime dataDir is required');

  const logPath = join(dataDir, 'memory-runtime-proxy.log');
  const ownerPath = join(dataDir, 'memory-runtime-owner.json');
  const singletonEnabled = process.env.MIXDOG_MEMORY_SINGLETON !== '0';
  const idleTtlMs = Math.max(0, Number(process.env.MIXDOG_MEMORY_IDLE_TTL_MS) || 10 * 60_000);
  let portCache = null;
  let startPromise = null;
  let child = null;
  let nextCallId = 1;

  async function findLivePort({ allowStarting = false } = {}) {
    const active = readActiveInstance();
    const port = parsePort(active?.memory_port);
    if (!port) return null;
    const ownerPid = parsePid(active?.memory_server_pid);
    if (ownerPid && !isPidAlive(ownerPid)) return null;
    try {
      const health = await requestJson({ port, path: '/health', timeoutMs: allowStarting ? 2000 : 500 });
      if (health?.status === 'ok' || (allowStarting && health?.status === 'starting')) {
        portCache = port;
        return port;
      }
    } catch {}
    return null;
  }

  async function waitForPort(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const port = await findLivePort({ allowStarting: true });
      if (port) {
        try {
          const health = await requestJson({ port, path: '/health', timeoutMs: 1500 });
          if (health?.status === 'ok') return port;
        } catch (error) {
          lastError = error;
        }
      }
      await delay(100);
    }
    throw lastError || new Error('memory runtime did not become ready');
  }

  function claimOwner() {
    if (!singletonEnabled) return { owned: true, owner: { pid: process.pid } };
    return claimSingletonOwner(ownerPath, {
      kind: 'memory-runtime-daemon',
      pid: process.pid,
      meta: { cwd, clientPid: process.pid },
    });
  }

  function releaseOwnerIfSelf() {
    if (!singletonEnabled) return;
    releaseSingletonOwner(ownerPath, process.pid);
  }

  async function start() {
    if (portCache) {
      const port = await findLivePort();
      if (port) return { running: true, port, mode: 'http-proxy' };
      portCache = null;
    }
    const existing = await findLivePort();
    if (existing) return { running: true, port: existing, mode: 'http-proxy' };
    if (startPromise) {
      const port = await startPromise;
      return { running: true, port, mode: 'http-proxy' };
    }

    startPromise = (async () => {
      const claim = claimOwner();
      if (!claim.owned) {
        const owner = readSingletonOwner(ownerPath);
        if (owner.alive) {
          const live = await waitForPort(30_000);
          return live;
        }
        releaseOwnerIfSelf();
      }

      const daemonEnv = { ...process.env };
      delete daemonEnv.MIXDOG_QUIET_MEMORY_LOG;
      child = fork(entry, [], {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        detached: true,
        env: {
          ...daemonEnv,
          MIXDOG_DATA_DIR: dataDir,
          MIXDOG_WORKER_MODE: '1',
          MIXDOG_STANDALONE: '1',
          MIXDOG_SERVER_PID: '',
          MIXDOG_OWNER_LEAD_PID: String(process.pid),
          MIXDOG_MEMORY_SECONDARY: '0',
          MIXDOG_PG_ATTACH_ONLY: '0',
          MIXDOG_MEMORY_DISABLE_CYCLES: process.env.MIXDOG_MEMORY_DISABLE_CYCLES ?? '0',
          MIXDOG_MEMORY_DISABLE_LLM_WORKER: process.env.MIXDOG_MEMORY_DISABLE_LLM_WORKER ?? '0',
          MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
          MIXDOG_MEMORY_DAEMON: '1',
          MIXDOG_MEMORY_IDLE_TTL_MS: String(idleTtlMs),
        },
        windowsHide: true,
      });
      const childPid = child.pid;
      if (singletonEnabled && childPid) {
        releaseSingletonOwner(ownerPath, process.pid);
        claimSingletonOwner(ownerPath, {
          kind: 'memory-runtime-daemon',
          pid: childPid,
          meta: { cwd, launcherPid: process.pid },
        });
      }
      child.stderr?.on('data', chunk => {
        const text = String(chunk || '').trimEnd();
        if (text) logLine(logPath, text);
      });
      child.on('exit', () => {
        if (singletonEnabled && childPid) releaseSingletonOwner(ownerPath, childPid);
        if (child?.pid === childPid) child = null;
        portCache = null;
      });

      const ready = new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('memory worker ready timeout')), 60_000);
        child.once('message', (msg) => {
          clearTimeout(timer);
          if (msg?.degraded || msg?.error) rejectReady(new Error(msg.error || 'memory worker degraded'));
          else resolveReady(msg);
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          rejectReady(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          rejectReady(new Error(`memory worker exited before ready (${signal || code || 'unknown'})`));
        });
      });

      await ready;
      const port = await waitForPort(15_000);
      try { child.disconnect?.(); } catch {}
      try { child.unref?.(); } catch {}
      try { child.stderr?.unref?.(); } catch {}
      return port;
    })().finally(() => {
      startPromise = null;
    });

    const port = await startPromise;
    return { running: true, port, mode: 'http-proxy' };
  }

  async function handleToolCall(name, args = {}) {
    await start();
    const port = portCache || await findLivePort({ allowStarting: true });
    if (!port) throw new Error('memory runtime is not available');
    const callId = `mem_${process.pid}_${nextCallId++}`;
    return await requestJson({
      port,
      method: 'POST',
      path: '/api/tool',
      body: { name, arguments: args || {} },
      timeoutMs: Math.max(1000, Number(process.env.MIXDOG_MEMORY_TOOL_TIMEOUT_MS) || 180_000),
      headers: { 'X-Mixdog-Call-Id': callId },
    });
  }

  async function buildSessionCoreMemoryPayload(sessionCwd) {
    await start();
    const port = portCache || await findLivePort({ allowStarting: true });
    if (!port) throw new Error('memory runtime is not available');
    return await requestJson({
      port,
      method: 'POST',
      path: '/session-start/core-memory',
      body: { cwd: sessionCwd || cwd },
      timeoutMs: 30_000,
    });
  }

  async function stop() {
    // Detach only. The daemon owns its own idle lifetime; CLI shutdown must not
    // tear it down out from under another tab.
    try { child?.disconnect?.(); } catch {}
    try { child?.unref?.(); } catch {}
    child = null;
    return true;
  }

  async function status() {
    const port = await findLivePort();
    const owner = readSingletonOwner(ownerPath);
    return {
      running: Boolean(port),
      port,
      mode: 'http-proxy',
      ownerPid: parsePid(owner.owner?.pid),
      ownerAlive: owner.alive,
    };
  }

  return {
    init: start,
    start,
    stop,
    status,
    handleToolCall,
    buildSessionCoreMemoryPayload,
    moduleUrl: pathToFileURL(entry).href,
  };
}
