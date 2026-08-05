// Engine daemon client: spawn-or-attach + the REMOTE ENGINE PROXY that both
// the terminal TUI and the desktop engine host consume in place of a local
// createEngineSession(). The proxy keeps the store contract intact —
// getState() stays synchronous by mirroring the daemon's snapshot frames, and
// every other method is forwarded over the transport.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_DAEMON_PROTOCOL,
  compareRuntimeVersions,
  engineRuntimeVersion,
} from './engine-daemon-protocol.mjs';

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}

export function engineDaemonDiscoveryPath() {
  return path.join(runtimeRoot(), 'engine-daemon.json');
}

function daemonEntry() {
  return fileURLToPath(new URL('./engine-daemon.mjs', import.meta.url));
}

function request({ port, token, method = 'GET', path: urlPath, body = null, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'X-Mixdog-Daemon-Token': token,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = null; }
        if (res.statusCode && res.statusCode >= 400) {
          const err = new Error(parsed?.error || data || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve(parsed ?? {});
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`engine daemon timeout: ${method} ${urlPath}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function probeEngineDaemonHealth({ port, token, timeoutMs = 800 } = {}) {
  try {
    const health = await request({ port, token, path: '/health', timeoutMs });
    return health?.status === 'ok' ? health : null;
  } catch { return null; }
}

export function readEngineDaemonDiscovery(discoveryPath = engineDaemonDiscoveryPath()) {
  try {
    const parsed = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    if (!parsed?.port || !parsed?.token || !parsed?.pid) return null;
    return parsed;
  } catch { return null; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Version skew verdict for a live daemon:
 *  ok      — same protocol and runtime version, attach.
 *  restart — the daemon is older; drain it and let this client host instead.
 *  defer   — the daemon is NEWER (another, newer install owns the box); this
 *            client must not kill it, so it falls back to an in-process engine. */
export function negotiateEngineDaemon(health) {
  const protocol = Number(health?.protocol) || 0;
  if (protocol > ENGINE_DAEMON_PROTOCOL) return 'defer';
  if (protocol < ENGINE_DAEMON_PROTOCOL) return 'restart';
  const comparison = compareRuntimeVersions(health?.version, engineRuntimeVersion());
  if (comparison > 0) return 'defer';
  if (comparison < 0) return 'restart';
  return 'ok';
}

async function waitForDaemonExit(discovery, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeEngineDaemonHealth({ port: discovery.port, token: discovery.token, timeoutMs: 400 });
    if (!health || Number(health.pid) !== Number(discovery.pid)) return true;
    await delay(150);
  }
  return false;
}

/** Fork one daemon candidate DETACHED (it outlives this client — machine
 *  global) and resolve when it reports ready OR exits (race loss/crash); the
 *  caller then re-reads discovery and attaches to whoever won. */
function spawnDaemonCandidate({ cwd, log }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    let child;
    try {
      child = fork(daemonEntry(), [], {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: {
          ...process.env,
          MIXDOG_ENGINE_DAEMON_HOST: '1',
          MIXDOG_SUPERVISOR_PID: process.env.MIXDOG_SUPERVISOR_PID || String(process.pid),
        },
      });
    } catch (err) {
      log(`daemon spawn failed: ${err?.message || err}`);
      done();
      return;
    }
    const mirror = (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) log(text);
    };
    child.stderr?.on('data', mirror);
    child.once('message', (msg) => {
      if (msg?.type !== 'ready') return;
      try { child.stderr?.off?.('data', mirror); } catch {}
      try { child.disconnect?.(); } catch {}
      try { child.unref?.(); } catch {}
      try { child.stderr?.unref?.(); } catch {}
      done();
    });
    child.once('exit', done);
    child.once('error', (err) => { log(`daemon spawn error: ${err?.message || err}`); done(); });
    const timer = setTimeout(done, 30_000);
    timer.unref?.();
  });
}

/** Spawn-or-attach discovery for the machine-global engine daemon. */
export async function ensureEngineDaemon({ cwd = process.cwd(), log = () => {}, attempts = 5 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const discovery = readEngineDaemonDiscovery();
    if (discovery) {
      const health = await probeEngineDaemonHealth({ port: discovery.port, token: discovery.token });
      if (health && Number(health.pid) === Number(discovery.pid)) {
        const verdict = negotiateEngineDaemon(health);
        if (verdict === 'ok') return discovery;
        if (verdict === 'defer') {
          const err = new Error(
            `engine daemon ${health.version || '?'} (protocol ${health.protocol ?? 0}) is newer than this client`,
          );
          err.daemonNewerThanClient = true;
          throw err;
        }
        log(`draining older engine daemon ${health.version || '?'} (protocol ${health.protocol ?? 0})`);
        await shutdownEngineDaemon(discovery);
        await waitForDaemonExit(discovery);
      }
    }
    await spawnDaemonCandidate({ cwd, log });
    await delay(100);
  }
  throw new Error('engine daemon is unavailable');
}

/** Attach to a live daemon: register, open the frame stream, return a handle
 *  whose call() dispatches engine operations. */
export async function attachEngineDaemon({
  discovery,
  leadPid = process.pid,
  cwd = process.cwd(),
  onFrame = () => {},
  onFatal = () => {},
  log = () => {},
} = {}) {
  if (!discovery?.port || !discovery?.token) throw new Error('daemon discovery {port, token} required');
  const { port, token: serverToken } = discovery;
  const reg = await request({
    port, token: serverToken, method: 'POST', path: '/client/register',
    body: { leadPid, cwd }, timeoutMs: 3000,
  });
  const clientToken = reg?.token;
  if (!clientToken) throw new Error('engine daemon register returned no client token');

  let closed = false;
  let streamRequest = null;

  function openStream() {
    if (closed) return;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/events?token=${encodeURIComponent(clientToken)}&server_token=${encodeURIComponent(serverToken)}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'X-Mixdog-Daemon-Token': serverToken },
    }, (res) => {
      if (req !== streamRequest || closed) { res.resume(); return; }
      if (res.statusCode !== 200) {
        res.resume();
        if (!closed) { try { onFatal(`bad sse status ${res.statusCode}`); } catch {} }
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        if (req !== streamRequest || closed) return;
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue; // ': ka' keepalives
            const json = line.slice(5).trim();
            if (!json) continue;
            let frame = null;
            try { frame = JSON.parse(json); } catch { continue; }
            try { onFrame(frame); } catch (err) { log(`onFrame threw: ${err?.message || err}`); }
          }
        }
      });
      const lost = (reason) => {
        if (req !== streamRequest || closed) return;
        try { onFatal(reason); } catch {}
      };
      res.on('end', () => lost('sse ended'));
      res.on('error', () => lost('sse error'));
    });
    req.on('error', () => { if (req === streamRequest && !closed) { try { onFatal('sse request error'); } catch {} } });
    streamRequest = req;
    req.end();
  }
  openStream();

  async function call(name, args = {}, { timeoutMs = 300_000, callId = null } = {}) {
    let out;
    try {
      out = await request({
        port, token: serverToken, method: 'POST', path: '/call',
        body: { token: clientToken, name, args: args || {}, ...(callId ? { callId } : {}) },
        timeoutMs,
      });
    } catch (err) {
      // Transport death (daemon restarted/unreachable) is recoverable by
      // re-attaching; an engine error comes back as a 200 {error} envelope.
      err.daemonTransportError = true;
      throw err;
    }
    if (out && out.error) throw new Error(out.error);
    return out?.result;
  }

  async function close(reason = 'client close') {
    if (closed) return;
    closed = true;
    try { streamRequest?.destroy?.(); } catch {}
    try {
      await request({
        port, token: serverToken, method: 'POST', path: '/client/deregister',
        body: { token: clientToken }, timeoutMs: 1500,
      });
    } catch { /* the daemon sweep reaps us anyway */ }
    log(`detached (${reason})`);
  }

  return { call, close, clientToken, port, pid: Number(discovery.pid) };
}

/** Ask a live daemon to exit. Used by dev/test teardown; normal clients just
 *  detach and let the client-grace shutdown fire. */
export async function shutdownEngineDaemon(discovery = readEngineDaemonDiscovery()) {
  if (!discovery?.port) return false;
  try {
    await request({
      port: discovery.port, token: discovery.token, method: 'POST',
      path: '/shutdown', body: {}, timeoutMs: 3000,
    });
    return true;
  } catch { return false; }
}

// ── Shared per-process attachment ────────────────────────────────────────────
// Every remote engine in this process rides ONE attachment: the daemon fan-out
// is per client, not per engine, and a second stream would double every frame.
let shared = null;

/** engineId -> Set(mirror). Many VIEWS can hold one engine (that is the whole
 *  point of the daemon), so frames fan out to every mirror on that id. */
function addMirror(mirrors, engineId, mirror) {
  let bucket = mirrors.get(engineId);
  if (!bucket) { bucket = new Set(); mirrors.set(engineId, bucket); }
  bucket.add(mirror);
}

function removeMirror(mirrors, engineId, mirror) {
  const bucket = mirrors.get(engineId);
  if (!bucket) return;
  bucket.delete(mirror);
  if (bucket.size === 0) mirrors.delete(engineId);
}

function mirrorCount(mirrors, engineId) {
  return mirrors.get(engineId)?.size ?? 0;
}

// Every live view in this process. A daemon crash kills its engines, so the
// views are what the recovery path re-seats onto the replacement daemon.
const liveViews = new Set();
let lastDaemonPid = null;
let reattachTimer = null;

function scheduleReattach({ cwd, log }) {
  if (reattachTimer || liveViews.size === 0) return;
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (liveViews.size === 0) return;
    void ensureSharedAttachment({ cwd, log }).catch((err) => {
      log(`engine daemon re-attach failed: ${err?.message || err}`);
      scheduleReattach({ cwd, log });
    });
  }, 500);
  reattachTimer.unref?.();
}

async function ensureSharedAttachment({ cwd, log }) {
  if (shared?.client) return shared;
  if (shared?.pending) return shared.pending;
  const pending = (async () => {
    const discovery = await ensureEngineDaemon({ cwd, log });
    const mirrors = new Map(); // engineId -> Set(mirror)
    const state = { client: null, mirrors, discovery, refs: 0, log, cwd };
    state.client = await attachEngineDaemon({
      discovery,
      cwd,
      log,
      onFrame: (frame) => {
        const bucket = mirrors.get(String(frame?.engineId || ''));
        if (!bucket) return;
        for (const mirror of [...bucket]) {
          if (frame.type === 'engine-state') mirror.applySnapshot(frame.snapshot);
          else if (frame.type === 'engine-gone') mirror.applyGone(frame.reason || 'engine closed');
        }
      },
      onFatal: (reason) => {
        log(`engine daemon attachment lost (${reason})`);
        if (shared === state) shared = null;
        for (const bucket of mirrors.values()) {
          for (const mirror of [...bucket]) mirror.applyDetached(reason);
        }
        // The engines may have died with the daemon; a bounded retry loop puts
        // every surviving view back onto a live one.
        scheduleReattach({ cwd: state.cwd, log });
      },
    });
    shared = state;
    // A DIFFERENT pid means the engines this process was viewing are gone.
    const freshDaemon = lastDaemonPid !== null && Number(discovery.pid) !== Number(lastDaemonPid);
    lastDaemonPid = Number(discovery.pid);
    for (const view of liveViews) {
      addMirror(mirrors, view.engineId(), view.mirror);
      if (freshDaemon) {
        void view.recover(state).catch((err) => log(`view recovery failed: ${err?.message || err}`));
      }
    }
    state.refs += liveViews.size;
    return state;
  })();
  shared = { pending };
  try {
    return await pending;
  } catch (err) {
    shared = null;
    throw err;
  }
}

const LOCAL_ENGINE_KEYS = new Set([
  'getState', 'subscribe', 'dispose', 'engineId', 'isRemoteEngine',
  'then', 'catch', 'finally', 'toJSON', 'inspect', Symbol.toStringTag,
]);

/** Remote counterpart of createEngineSession(): the engine runs in the daemon,
 *  this object is the local view of it. */
export async function createRemoteEngineSession(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cwd = options.cwd || process.cwd();
  const openParams = {
    cwd,
    provider: options.provider,
    model: options.model,
    toolMode: options.toolMode || 'full',
    remote: options.remote === true,
    desktopSession: options.desktopSession ?? null,
  };
  // The attachment can be REPLACED under this view (daemon restart), so it is
  // read through the binding rather than captured once.
  let attachment = await ensureSharedAttachment({ cwd, log });
  const opened = await attachment.client.call('engine.open', openParams);
  // The bound engine can MOVE: resuming a session another view already holds
  // adopts that engine instead of loading a second copy of the same session.
  let engineId = opened.engineId;

  let state = opened.snapshot ?? {};
  let disposed = false;
  const listeners = new Set();

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (err) { log(`engine listener threw: ${err?.message || err}`); }
    }
  }

  const mirror = {
    applySnapshot(next) {
      if (disposed || !next) return;
      state = next;
      emit();
    },
    applyGone(reason) {
      if (disposed) return;
      disposed = true;
      log(`remote engine ${engineId} closed by daemon (${reason})`);
      emit();
    },
    applyDetached(reason) {
      // The engine keeps running in the daemon; only this view went dark. A
      // fresh attach re-opens the stream, so surface the loss without killing
      // the local snapshot.
      log(`remote engine ${engineId} view detached (${reason})`);
    },
  };
  addMirror(attachment.mirrors, engineId, mirror);
  attachment.refs += 1;

  /** Re-seat this view after a daemon restart: open a fresh engine on the
   *  replacement daemon and resume whatever session this view was holding —
   *  which also re-converges two views that shared one engine. */
  async function recover(nextAttachment) {
    if (disposed) return;
    const previousEngineId = engineId;
    const previousState = state;
    attachment = nextAttachment;
    const reopened = await attachment.client.call('engine.open', openParams);
    removeMirror(attachment.mirrors, previousEngineId, mirror);
    engineId = reopened.engineId;
    addMirror(attachment.mirrors, engineId, mirror);
    state = reopened.snapshot ?? {};
    emit();
    const sessionId = String(previousState?.sessionId || '');
    if (sessionId) {
      try { await remoteCall('resume', [sessionId]); }
      catch (err) { log(`session ${sessionId} could not be resumed after recovery: ${err?.message || err}`); }
    }
    log(`view recovered onto engine ${engineId}${sessionId ? ` (session ${sessionId})` : ''}`);
  }

  const view = { engineId: () => engineId, mirror, recover };
  liveViews.add(view);

  /** Rebind this view onto an engine that already hosts the requested session.
   *  The old engine is released only when it was an idle placeholder — never
   *  when it still carries a session or in-flight work. */
  async function adopt(nextEngineId) {
    if (disposed || !nextEngineId || nextEngineId === engineId) return;
    const previousEngineId = engineId;
    const previousState = state;
    removeMirror(attachment.mirrors, previousEngineId, mirror);
    engineId = nextEngineId;
    addMirror(attachment.mirrors, engineId, mirror);
    log(`view adopted engine ${previousEngineId} -> ${engineId}`);
    try {
      const adopted = await attachment.client.call('engine.snapshot', { engineId });
      if (adopted?.snapshot) { state = adopted.snapshot; emit(); }
    } catch (err) {
      log(`adopted snapshot read failed: ${err?.message || err}`);
    }
    const idlePlaceholder = !String(previousState?.sessionId || '')
      && previousState?.busy !== true;
    if (!idlePlaceholder) return;
    try {
      await attachment.client.call('engine.dispose', {
        engineId: previousEngineId, reason: 'adopted into a live session',
      });
    } catch (err) {
      log(`placeholder dispose failed: ${err?.message || err}`);
    }
  }

  async function remoteCall(method, args) {
    const result = await attachment.client.call('engine.call', { engineId, method, args }, {
      callId: randomUUID(),
    });
    if (result?.adoptEngineId) await adopt(result.adoptEngineId);
    return result?.value ?? null;
  }

  const base = {
    isRemoteEngine: true,
    get engineId() { return engineId; },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose(reason = 'view dispose', disposeOptions = {}) {
      if (disposed) return;
      disposed = true;
      liveViews.delete(view);
      const releasedEngineId = engineId;
      removeMirror(attachment.mirrors, releasedEngineId, mirror);
      attachment.refs = Math.max(0, attachment.refs - 1);
      // Closing ONE view must never end a session another view is still
      // holding — the engine dies with its last viewer, not its first.
      if (mirrorCount(attachment.mirrors, releasedEngineId) === 0) {
        try {
          await attachment.client.call('engine.dispose', {
            engineId: releasedEngineId,
            reason,
            keepBackgroundWork: disposeOptions?.keepBackgroundWork === true,
          });
        } catch (err) {
          log(`remote dispose failed: ${err?.message || err}`);
        }
      }
      if (attachment.refs === 0) {
        try { await attachment.client.close('last engine disposed'); } catch {}
        if (shared === attachment) shared = null;
      }
    },
  };

  // Any store method that is not handled locally is forwarded by name. The
  // engine surface is large (the whole TUI store API) and still growing, so a
  // name-forwarding proxy keeps the daemon contract from having to enumerate it.
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property in target || LOCAL_ENGINE_KEYS.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      if (typeof property === 'symbol') return undefined;
      return (...args) => remoteCall(property, args);
    },
    has(target, property) {
      return typeof property === 'string' ? true : Reflect.has(target, property);
    },
  });
}
