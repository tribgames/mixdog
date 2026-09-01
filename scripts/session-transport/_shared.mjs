// Session transport contract: transport fan-out, call routing, and the remote
// runtime proxy — all against a STUB runtime factory so the test never boots a
// provider, model catalog, or memory runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applySessionStatePatch,
  diffSessionState,
} from '../../src/standalone/session-state-patch.mjs';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-session-transport-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;
process.env.MIXDOG_SESSION_SSE_PENDING_MB = '0.25';
process.env.MIXDOG_CHANNEL_ACTIVE_CALLS = '8';

const { createSessionTransport } = await import('../../src/standalone/session-transport.mjs');
const { createSessionService } = await import('../../src/standalone/session-service.mjs');
const { SESSION_READ_ACTIONS } = await import('../../src/standalone/session-protocol.mjs');
const { createChannelTransport } = await import('../../src/standalone/channel-transport.mjs');
const {
  cleanupBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
} = await import('../../src/runtime/shared/background-tasks.mjs');
const {
  attachSession, createSession, probeSessionHealth,
  daemonShouldDetach, sessionDaemonCompatibility,
} =
  await import('../../src/standalone/session-client.mjs');
const { createProjectPicker } = await import('../../src/tui/app/project-picker.mjs');
const { createPanelSurface } = await import('../../src/tui/app/panel-surface.mjs');
const { createSessionApiA } = await import('../../src/tui/session/session-api.mjs');
const { createSessionApiB } = await import('../../src/tui/session/session-api-ext.mjs');
const {
  appendTuiSteeringPersist,
  drainTuiSteeringPersist,
} = await import('../../src/tui/session/tui-steering-persist.mjs');
const { createSessionOAuthFlowRegistry } =
  await import('../../src/tui/session/oauth-flows.mjs');
const {
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} =
  await import('../../src/standalone/session-wire.mjs');

function daemonPost(discovery, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: discovery.port,
      path,
      method: 'POST',
      headers: {
        'X-Mixdog-Daemon-Token': discovery.token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const parsed = raw ? JSON.parse(raw) : {};
        if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function waitForSseFrame(discovery, clientToken, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      reject(new Error('timed out waiting for SSE frame'));
    }, timeoutMs);
    const req = http.request({
      hostname: '127.0.0.1',
      port: discovery.port,
      path: `/events?token=${encodeURIComponent(clientToken)}`,
      method: 'GET',
      headers: { 'X-Mixdog-Daemon-Token': discovery.token },
    }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let frame;
            try { frame = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (!predicate(frame)) continue;
            clearTimeout(timer);
            req.destroy();
            resolve(frame);
            return;
          }
        }
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      if (error?.code === 'ECONNRESET') return;
      reject(error);
    });
    req.end();
  });
}

function waitForValue(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for value'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function createStubSessionRuntime(sessionId = '') {
  let state = { sessionId, items: [], busy: false };
  const listeners = new Set();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reserveSession(id) {
      state = { ...state, sessionId: String(id) };
      publish();
      return true;
    },
    async submitAsync(text) {
      state = { ...state, items: [...state.items, { id: state.items.length + 1, text: String(text) }] };
      publish();
      return true;
    },
    async resume(id) {
      state = { ...state, sessionId: String(id), items: [{ id: 1, text: `resumed ${id}` }] };
      publish();
      return true;
    },
    setProgressHint() {
      state = { ...state, busy: true, items: [...state.items, { id: state.items.length + 1, text: 'working' }] };
      publish();
      return true;
    },
    setCwd(cwd) {
      state = { ...state, cwd: String(cwd) };
      publish();
      return state.cwd;
    },
    abort(options = {}) {
      state = { ...state, busy: false };
      publish();
      return {
        aborted: true,
        restoreText: options?.restorePrompt === false ? '' : 'restored prompt',
        pastedImages: options?.restorePrompt === false
          ? null
          : { image_1: { filename: 'restored.png' } },
      };
    },
    getProfile() { throw new Error('stub failure'); },
    // A function value must never cross the wire — the sanitizer drops it.
    getTheme() { return { ok: true, callback() {}, when: new Date(0) }; },
    async dispose() { state = { ...state, disposed: true }; publish(); },
  };
}

async function withDaemon(run, {
  sessionFactory = async () => createStubSessionRuntime(), idleEvictMs = null, evictSweepMs = null,
  onClientRegistered = null, softRssMb = null,
  rssBytes = undefined, desktopRuntime = null,
} = {}) {
  let clientsEmptyReason = null;
  // Client identity is what the pool refcounts views by; the tests need it to
  // act as "that client went away" without tearing down the local view.
  let lastClientToken = null;
  const service = createSessionService({
    createSessionRuntime: sessionFactory,
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
    idleEvictMs,
    evictSweepMs,
    softRssMb,
    desktopRuntime,
    ...(rssBytes ? { rssBytes } : {}),
  });
  const transport = createSessionTransport({
    handleCall: (name, args, ctx) => {
      if (ctx?.clientToken) lastClientToken = ctx.clientToken;
      return service.handleCall(name, args, ctx);
    },
    clientGraceMs: 50,
    sweepMs: 50,
    onClientsEmpty: () => { clientsEmptyReason = 'empty'; },
    onClientRegistered,
    onClientDropped: (token) => { service.releaseClient(token); },
  });
  const { port, token } = await transport.start();
  const discovery = { pid: process.pid, port, token };
  writeFileSync(join(RUNTIME_ROOT, 'daemon.json'), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    endpoints: { session: { port, token } },
  }));
  try {
    await run({
      transport, service, discovery,
      clientsEmpty: () => clientsEmptyReason,
      clientToken: () => lastClientToken,
    });
  } finally {
    await service.stop('test end');
    await transport.stop();
  }
}

async function waitFor(predicate, message, timeoutMs = 4000) {
  const started = Date.now();
  while (true) {
    let value;
    try { value = await predicate(); } catch (err) { throw err; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      const detail = typeof message === 'function' ? message() : message;
      throw new Error(`timeout: ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10).unref?.());
  }
}

/** Replay a view's frame stream into the transcript it represents. Frames are
 *  DELTAS against the revision each view already holds (a full snapshot only
 *  opens the stream), so a fan-out assertion has to fold them the same way the
 *  view proxy does. */
function itemsFromFrames(frames) {
  let items = [];
  for (const frame of frames) {
    if (frame.type !== 'session-state') continue;
    if (frame.full) { items = Array.isArray(frame.full.items) ? frame.full.items : []; continue; }
    const patch = frame.patch;
    if (!patch) continue;
    if (Array.isArray(patch.set?.items)) items = patch.set.items;
    if (patch.itemsAppend) {
      items = [...items.slice(0, patch.itemsAppend.from), ...patch.itemsAppend.values];
    }
  }
  return items;
}

function sessionSnapshotFromFrames(frames, sessionId) {
  let snapshot = null;
  for (const frame of frames) {
    if (frame.type !== 'session-state' || frame.sessionId !== sessionId) continue;
    if (frame.full) { snapshot = frame.full; continue; }
    if (!frame.patch) continue;
    const base = snapshot || {};
    const next = { ...base, ...(frame.patch.set || {}) };
    if (frame.patch.itemsAppend) {
      next.items = (Array.isArray(base.items) ? base.items : [])
        .slice(0, frame.patch.itemsAppend.from)
        .concat(frame.patch.itemsAppend.values || []);
    }
    for (const key of frame.patch.remove || []) delete next[key];
    snapshot = next;
  }
  return snapshot;
}

export {
  http,
  mkdtempSync,
  writeFileSync,
  performance,
  tmpdir,
  join,
  pathToFileURL,
  applySessionStatePatch,
  diffSessionState,
  RUNTIME_ROOT,
  createSessionTransport,
  createSessionService,
  SESSION_READ_ACTIONS,
  createChannelTransport,
  cleanupBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
  attachSession,
  createSession,
  probeSessionHealth,
  daemonShouldDetach,
  sessionDaemonCompatibility,
  createProjectPicker,
  createPanelSurface,
  createSessionApiA,
  createSessionApiB,
  appendTuiSteeringPersist,
  drainTuiSteeringPersist,
  createSessionOAuthFlowRegistry,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
  daemonPost,
  waitForSseFrame,
  waitForValue,
  createStubSessionRuntime,
  withDaemon,
  waitFor,
  itemsFromFrames,
  sessionSnapshotFromFrames,
};
