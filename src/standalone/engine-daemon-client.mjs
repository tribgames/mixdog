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
} from './engine-daemon-protocol.mjs';
import { engineDaemonLocalBridge } from './engine-daemon-local-bridge.mjs';

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}

export function engineDaemonDiscoveryPath() {
  return path.join(runtimeRoot(), 'engine-daemon.json');
}

function daemonEntry() {
  // ONE daemon: the channels/memory host also owns the engine pool, so both
  // spawn paths converge on the same singleton process.
  return fileURLToPath(new URL('./backend-daemon.mjs', import.meta.url));
}

// Data calls and lifecycle control must never share a socket pool. A burst of
// long /call requests can occupy every data socket; health/register/deregister
// still need a reserved lane so a new terminal can always attach or recover.
const daemonCallAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 8 });
const daemonControlAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 4 });

function request({
  port,
  token,
  method = 'GET',
  path: urlPath,
  body = null,
  timeoutMs = 120_000,
  control = false,
}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      agent: control ? daemonControlAgent : daemonCallAgent,
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
    const health = await request({ port, token, path: '/health', timeoutMs, control: true });
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
 *  ok      — same wire protocol, attach. A different BUILD is not a reason to
 *            touch it: the daemon dies with its last client, so closing the app
 *            and launching the new version is what picks up new code.
 *  restart — the daemon speaks an OLDER protocol; stop it and open fresh
 *            engines on a daemon this client can talk to.
 *  defer   — the daemon is NEWER (another, newer install owns the box); this
 *            client must not kill it and must surface the version conflict. */
export function negotiateEngineDaemon(health) {
  const protocol = Number(health?.protocol) || 0;
  if (protocol > ENGINE_DAEMON_PROTOCOL) return 'defer';
  if (protocol < ENGINE_DAEMON_PROTOCOL) return 'restart';
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
          // Engine-only spawn: the backend stays dormant on the channels side
          // until a channels client registers.
          MIXDOG_DAEMON_SPAWNED_FOR: 'engine',
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
  // A daemon we asked to drain but that kept serving live clients is a
  // DIFFERENT failure from "no daemon came up": the user has to close the
  // running views, so say that instead of a generic unavailability.
  let upgradeBlocked = null;
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
        log(`stopping older engine daemon ${health.version || '?'} (protocol ${health.protocol ?? 0})`);
        await shutdownEngineDaemon(discovery);
        upgradeBlocked = await waitForDaemonExit(discovery) ? null : health;
      }
    }
    await spawnDaemonCandidate({ cwd, log });
    await delay(100);
  }
  if (upgradeBlocked) {
    const err = new Error(
      `an older Mixdog backend (protocol ${upgradeBlocked.protocol ?? 0}) is still serving live clients`
      + ' — close the running Mixdog windows and terminals, then start again',
    );
    err.daemonUpgradeBlocked = true;
    throw err;
  }
  throw new Error('engine daemon is unavailable');
}

/** Attach to a live daemon: register, open the frame stream, return a handle
 *  whose call() dispatches engine operations. */
export async function attachEngineDaemon({
  discovery,
  leadPid = process.pid,
  cwd = process.cwd(),
  lifecycle = true,
  registrationId = randomUUID(),
  onFrame = () => {},
  onFatal = () => {},
  log = () => {},
} = {}) {
  if (!discovery?.port || !discovery?.token) throw new Error('daemon discovery {port, token} required');
  const { port, token: serverToken } = discovery;
  const stableRegistrationId = String(registrationId || randomUUID());
  let reg = null;
  let registrationError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      reg = await request({
        port, token: serverToken, method: 'POST', path: '/client/register',
        body: {
          leadPid,
          cwd,
          lifecycle: lifecycle !== false,
          registrationId: stableRegistrationId,
        },
        timeoutMs: 3000,
        control: true,
      });
      break;
    } catch (error) {
      registrationError = error;
      if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) throw error;
      if (attempt < 2) await delay(100 * (attempt + 1));
    }
  }
  if (!reg) throw registrationError || new Error('engine daemon registration failed');
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
        body: { token: clientToken }, timeoutMs: 1500, control: true,
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
      path: '/shutdown', body: {}, timeoutMs: 3000, control: true,
    });
    return true;
  } catch { return false; }
}

// ── Shared per-process attachment ────────────────────────────────────────────
// Every session view in this process rides ONE attachment. Frames and calls are
// addressed only by durable sessionId; daemon engine handles never cross wire.
let shared = null;

function addSessionView(views, sessionId, view) {
  let bucket = views.get(sessionId);
  if (!bucket) { bucket = new Set(); views.set(sessionId, bucket); }
  bucket.add(view);
}

function removeSessionView(views, sessionId, view) {
  const bucket = views.get(sessionId);
  if (!bucket) return;
  bucket.delete(view);
  if (bucket.size === 0) views.delete(sessionId);
}

function sessionViewCount(views, sessionId) {
  return views.get(sessionId)?.size ?? 0;
}

function applyStatePatch(state, patch) {
  const next = { ...state, ...(patch.set || {}) };
  if (patch.itemsAppend) {
    const base = Array.isArray(state.items) ? state.items : [];
    next.items = base.slice(0, patch.itemsAppend.from).concat(patch.itemsAppend.values || []);
  }
  for (const key of patch.remove || []) delete next[key];
  return next;
}

const liveViews = new Set();
let reattachTimer = null;

function scheduleReattach({ cwd, log }) {
  if (reattachTimer || liveViews.size === 0) return;
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (liveViews.size === 0) return;
    void ensureSharedAttachment({ cwd, log }).catch((err) => {
      log(`backend daemon re-attach failed: ${err?.message || err}`);
      scheduleReattach({ cwd, log });
    });
  }, 500);
  reattachTimer.unref?.();
}

async function ensureSharedAttachment({ cwd, log }) {
  if (shared?.client) return shared;
  if (shared?.pending) return shared.pending;
  const pending = (async () => {
    const localBridge = process.env.MIXDOG_ENGINE_DAEMON_HOST === '1'
      ? engineDaemonLocalBridge()
      : null;
    const discovery = localBridge
      ? { pid: process.pid, local: true }
      : await ensureEngineDaemon({ cwd, log });
    const views = new Map();
    const state = { client: null, views, discovery, refs: liveViews.size, log, cwd };
    const attachmentOptions = {
      cwd,
      log,
      onFrame: (frame) => {
        const bucket = views.get(String(frame?.sessionId || ''));
        if (!bucket) return;
        for (const view of [...bucket]) {
          if (frame.type === 'session-state') view.applyFrame(frame);
          else if (frame.type === 'session-gone') view.applyGone(frame.reason || 'session unloaded');
        }
      },
      onFatal: (reason) => {
        log(`backend daemon attachment lost (${reason})`);
        if (shared === state) shared = null;
        for (const bucket of views.values()) {
          for (const view of [...bucket]) view.applyDetached(reason);
        }
        scheduleReattach({ cwd: state.cwd, log });
      },
    };
    state.client = localBridge
      ? await localBridge.attach(attachmentOptions)
      : await attachEngineDaemon({ discovery, ...attachmentOptions });
    shared = state;
    for (const view of liveViews) {
      addSessionView(views, view.sessionId(), view);
      void view.recover(state).catch((err) => {
        log(`session ${view.sessionId()} recovery failed: ${err?.message || err}`);
      });
    }
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
  'getState', 'subscribe', 'dispose', 'isRemoteEngine', 'disposedView',
  'then', 'catch', 'finally', 'toJSON', 'inspect', Symbol.toStringTag,
]);

/** Remote counterpart of createEngineSession(): this is a session projection,
 *  while execution and durable intake stay in the backend daemon. */
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
  let attachment = await ensureSharedAttachment({ cwd, log });
  const created = await attachment.client.call('session.create', openParams, {
    callId: `session-create:${process.pid}:${randomUUID()}`,
  });
  let sessionId = String(created?.sessionId || '');
  if (!sessionId) throw new Error('session.create returned no sessionId');
  let state = created?.full ?? {};
  let revision = Number(created?.revision) || 0;
  let sync = created?.sync ?? {};
  let disposed = false;
  const listeners = new Set();

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (err) { log(`session listener threw: ${err?.message || err}`); }
    }
  }

  function applyBody(body) {
    if (disposed || !body) return false;
    if (body.full !== undefined && body.full !== null) {
      state = body.full;
      revision = Number(body.revision) || revision;
      emit();
      return true;
    }
    if (body.patch) {
      // The daemon answers a state-changing call AND broadcasts the same step,
      // so every such call delivers one revision twice. Recognising the
      // duplicate as a no-op keeps it from looking like a revision gap, which
      // used to cost one extra full session.read per call.
      if (Number(body.revision) === revision
        && Number(body.baseRevision) === revision - 1) return true;
      if (Number(body.baseRevision) !== revision) return false;
      state = applyStatePatch(state, body.patch);
      revision = Number(body.revision) || revision;
      emit();
      return true;
    }
    if (Number.isFinite(Number(body.revision))) {
      revision = Number(body.revision);
      return true;
    }
    return false;
  }

  let resyncing = false;
  function resync(reason) {
    if (disposed || resyncing) return;
    resyncing = true;
    void attachment.client.call('session.read', {
      sessionId, open: openParams, baseRevision: revision,
    }).then((result) => {
      if (disposed) return;
      if (result?.sync) sync = result.sync;
      if (!applyBody(result) && result?.revision !== undefined) {
        log(`session ${sessionId} resync returned an unusable body`);
      }
    }).catch((err) => {
      log(`session ${sessionId} resync after ${reason} failed: ${err?.message || err}`);
    }).finally(() => { resyncing = false; });
  }

  let recoveryPromise = null;
  let view;
  async function recover(nextAttachment) {
    if (disposed) return;
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const previousAttachment = attachment;
      if (previousAttachment !== nextAttachment) {
        removeSessionView(previousAttachment.views, sessionId, view);
        attachment = nextAttachment;
      }
      let result;
      try {
        result = await attachment.client.call('session.subscribe', {
          sessionId, open: openParams, baseRevision: revision,
        });
      } catch {
        result = await attachment.client.call('session.create', {
          ...openParams, sessionId,
        }, { callId: `session-recreate:${sessionId}` });
      }
      addSessionView(attachment.views, sessionId, view);
      if (result?.sync) sync = result.sync;
      if (!applyBody(result) && result?.revision !== undefined) resync('recovery body gap');
      log(`session ${sessionId} projection recovered`);
    })();
    try {
      return await recoveryPromise;
    } finally {
      recoveryPromise = null;
    }
  }

  view = {
    sessionId: () => sessionId,
    applyFrame(frame) {
      if (disposed) return;
      if (!applyBody(frame)) resync('revision gap');
    },
    applyGone(reason) {
      if (disposed) return;
      void recover(attachment).catch((err) => {
        log(`session ${sessionId} reload after ${reason} failed: ${err?.message || err}`);
      });
    },
    applyDetached(reason) {
      log(`session ${sessionId} projection detached (${reason})`);
    },
    recover,
  };
  addSessionView(attachment.views, sessionId, view);
  attachment.refs += 1;
  liveViews.add(view);

  async function sendCall(route, payload, callId) {
    const send = () => attachment.client.call(route, payload, { callId });
    try {
      return await send();
    } catch (err) {
      const recoverable = err?.daemonTransportError
        || /unknown client token/i.test(String(err?.message || ''));
      if (!recoverable || disposed) throw err;
      if (shared === attachment) shared = null;
      const next = await ensureSharedAttachment({ cwd, log });
      await recover(next);
      return await send();
    }
  }

  async function applyResult(result, reason) {
    const nextSessionId = String(result?.sessionId || sessionId);
    if (nextSessionId && nextSessionId !== sessionId) {
      const previousSessionId = sessionId;
      addSessionView(attachment.views, nextSessionId, view);
      removeSessionView(attachment.views, previousSessionId, view);
      sessionId = nextSessionId;
    }
    if (result?.sync) sync = result.sync;
    if (!applyBody(result) && result?.revision !== undefined) resync(`${reason} body gap`);
    return result;
  }

  let callChain = Promise.resolve();
  function serialize(task) {
    const run = callChain.then(task);
    callChain = run.then(() => {}, () => {});
    return run;
  }

  function remoteCall(method, args, callOptions = {}) {
    return serialize(async () => {
      if (disposed) throw new Error('This session view is disposed.');
      const stableCallId = typeof callOptions.callId === 'string' && callOptions.callId.trim()
        ? callOptions.callId.trim()
        : randomUUID();
      const result = await sendCall('session.invoke', {
        sessionId,
        method,
        args,
        open: openParams,
        baseRevision: revision,
      }, stableCallId);
      await applyResult(result, method);
      return result?.value ?? null;
    });
  }

  function dispatch(method, args) {
    void remoteCall(method, args).catch((err) => {
      log(`session ${method} failed: ${err?.message || err}`);
    });
  }

  async function rebindTo(result, previousSessionId) {
    const nextSessionId = String(result?.sessionId || '');
    if (!nextSessionId) throw new Error('session route returned no sessionId');
    const lastLocalView = sessionViewCount(attachment.views, previousSessionId) <= 1;
    addSessionView(attachment.views, nextSessionId, view);
    removeSessionView(attachment.views, previousSessionId, view);
    sessionId = nextSessionId;
    if (result?.sync) sync = result.sync;
    if (!applyBody(result) && result?.revision !== undefined) resync('session rebind body gap');
    if (previousSessionId && previousSessionId !== nextSessionId && lastLocalView) {
      try {
        await attachment.client.call('session.unsubscribe', { sessionId: previousSessionId });
      } catch (err) {
        log(`session ${previousSessionId} unsubscribe failed: ${err?.message || err}`);
      }
    }
    return nextSessionId;
  }

  async function createReservedSession() {
    return serialize(async () => {
      if (disposed) throw new Error('This session view is disposed.');
      const previousSessionId = sessionId;
      const result = await sendCall('session.create', openParams,
        `session-create:${process.pid}:${randomUUID()}`);
      return await rebindTo(result, previousSessionId);
    });
  }

  async function resumeSession(targetSessionId, resumeOptions) {
    const target = String(targetSessionId || '');
    if (!target) return false;
    return serialize(async () => {
      if (disposed) throw new Error('This session view is disposed.');
      if (target === sessionId) {
        const result = await sendCall('session.read', {
          sessionId, open: openParams, baseRevision: revision,
        }, randomUUID());
        await applyResult(result, 'resume');
        return true;
      }
      const previousSessionId = sessionId;
      const result = await sendCall('session.subscribe', {
        sessionId: target,
        open: { ...openParams, resumeOptions: resumeOptions || undefined },
        baseRevision: null,
      }, randomUUID());
      await rebindTo(result, previousSessionId);
      return true;
    });
  }

  let submitSeq = 0;
  async function submitAsync(prompt, options = {}) {
    if (disposed) throw new Error('This session view is disposed.');
    const submissionId = String(options?.id || '').trim()
      || `session-submit-${process.pid}-${Date.now()}-${(submitSeq += 1)}`;
    return serialize(async () => {
      const result = await sendCall('session.submit', {
        sessionId,
        prompt,
        options: { ...(options || {}), id: submissionId },
        open: openParams,
        baseRevision: revision,
      }, `session-submit:${sessionId}:${submissionId}`);
      await applyResult(result, 'submit');
      return result?.accepted === true;
    });
  }

  const base = {
    isRemoteEngine: true,
    get disposedView() { return disposed; },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listSessions(options) {
      if (options?.refreshFromStorage) dispatch('listSessions', [options]);
      return Array.isArray(sync.sessions) ? sync.sessions : [];
    },
    sessionStoreDir() {
      return typeof sync.sessionStoreDir === 'string' ? sync.sessionStoreDir : null;
    },
    async newSession() {
      await createReservedSession();
      return true;
    },
    resume: resumeSession,
    async prefetchSession(targetSessionId) {
      const target = String(targetSessionId || '');
      if (!target) return false;
      await callDaemonSession({
        sessionId: target,
        method: 'read',
        open: openParams,
        cwd,
        log,
        attempts: 1,
      });
      return true;
    },
    submitAsync,
    submit(prompt, options) {
      if (disposed) return false;
      void submitAsync(prompt, options).catch((err) => {
        log(`legacy submit failed: ${err?.message || err}`);
      });
      return true;
    },
    abort() {
      void serialize(async () => {
        const result = await sendCall('session.abort', {
          sessionId, open: openParams, baseRevision: revision,
        }, randomUUID());
        await applyResult(result, 'abort');
      }).catch((err) => log(`session abort failed: ${err?.message || err}`));
      return true;
    },
    resolveToolApproval(id, decision) {
      void serialize(async () => {
        const result = await sendCall('session.approve', {
          sessionId,
          approvalId: id,
          decision,
          open: openParams,
          baseRevision: revision,
        }, randomUUID());
        await applyResult(result, 'approval');
      }).catch((err) => log(`session approval failed: ${err?.message || err}`));
      return true;
    },
    async dispose(reason = 'view dispose') {
      if (disposed) return;
      disposed = true;
      liveViews.delete(view);
      const releasedSessionId = sessionId;
      const lastLocalView = sessionViewCount(attachment.views, releasedSessionId) <= 1;
      if (lastLocalView) {
        try {
          await attachment.client.call('session.unsubscribe', { sessionId: releasedSessionId });
        } catch (err) {
          log(`session ${releasedSessionId} unsubscribe failed: ${err?.message || err}`);
        }
      }
      removeSessionView(attachment.views, releasedSessionId, view);
      listeners.clear();
      attachment.refs = Math.max(0, attachment.refs - 1);
      if (attachment.refs === 0 && liveViews.size === 0) {
        try { await attachment.client.close(reason); } catch {}
        // Last view gone: drop pooled keep-alive sockets so an idle connection
        // cannot keep the process (or a test runner) alive.
        try { daemonCallAgent.destroy(); } catch {}
        try { daemonControlAgent.destroy(); } catch {}
        if (shared === attachment) shared = null;
      }
    },
  };

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

/** Session-addressed backend request from a view that holds NO engine for that
 *  session. The daemon owns the engine pool, so a renderer (desktop pane, TUI
 *  tab) hands it the request and the daemon resolves — or loads — the session's
 *  engine. This is what makes "no live engine here" impossible to hit.
 *  Only a dead transport is retried; an engine-side verdict comes straight back. */
export async function callDaemonSession({
  sessionId,
  method,
  args = [],
  open: openHints = {},
  cwd = process.cwd(),
  log = () => {},
  attempts = 3,
} = {}) {
  const id = String(sessionId || '');
  if (!id) throw new TypeError('sessionId is required');
  const name = String(method || '');
  if (!name) throw new TypeError('method is required');
  let route = 'session.invoke';
  let payload = { sessionId: id, method: name, args, open: openHints || {} };
  if (name === 'submit') {
    route = 'session.submit';
    payload = {
      sessionId: id,
      prompt: args?.[0],
      options: args?.[1] || {},
      open: openHints || {},
    };
  } else if (name === 'abort') {
    route = 'session.abort';
    payload = { sessionId: id, open: openHints || {} };
  } else if (name === 'resolveToolApproval') {
    route = 'session.approve';
    payload = {
      sessionId: id,
      approvalId: args?.[0],
      decision: args?.[1],
      open: openHints || {},
    };
  } else if (name === 'read') {
    // Prefetch/peek: WARM (or load) the session's engine. This is a daemon
    // route, not an engine method — sending it as session.invoke asked the
    // engine for a `read()` that the store contract has never had, so every
    // prefetch failed with "engine method read is unavailable".
    route = 'session.read';
    payload = { sessionId: id, open: openHints || {}, baseRevision: null };
  }
  // One id for the whole retry sequence. In particular, a submit whose HTTP
  // response was lost must hit the transport cache instead of being accepted
  // twice by the daemon.
  const submissionId = name === 'submit' ? String(args?.[1]?.id || '').trim() : '';
  const callId = submissionId
    ? `session-submit:${id}:${submissionId}`
    : randomUUID();
  let lastError = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const attachment = await ensureSharedAttachment({ cwd, log });
    try {
      const result = await attachment.client.call(route, payload, { callId });
      if (name === 'submit') return { ...result, value: result?.accepted === true };
      if (name === 'abort') return { ...result, value: result?.aborted === true };
      if (name === 'resolveToolApproval') return { ...result, value: result?.approved === true };
      return result;
    } catch (err) {
      if (!err?.daemonTransportError) throw err;
      lastError = err;
      // The attachment died under us; drop it so the next attempt re-discovers
      // (or respawns) the daemon instead of calling into a closed socket.
      if (shared === attachment) shared = null;
      await delay(200 * (attempt + 1));
    }
  }
  throw lastError || new Error('engine daemon session call failed');
}
