// Real-process lifetime regression: a desktop client exits while a terminal
// turn is active. The daemon PID and execution must survive the disconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLE = process.env.MIXDOG_LIFETIME_TEST_ROLE || '';
const THIS_FILE = fileURLToPath(import.meta.url);

function send(message) {
  if (process.connected && process.send) process.send(message);
}

if (ROLE === 'daemon') {
  const { createSessionTransport } = await import('../src/standalone/session-transport.mjs');
  const { createSessionService } = await import('../src/standalone/session-service.mjs');
  let transport;
  const service = createSessionService({
    createSessionRuntime: async () => {
      let state = { sessionId: '', items: [], busy: false };
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
        async resume(id) {
          state = { ...state, sessionId: String(id) };
          publish();
          return true;
        },
        async submitAsync(text) {
          state = {
            ...state,
            busy: true,
            items: [...state.items, { id: 'prompt', text: String(text) }],
          };
          publish();
          setTimeout(() => {
            state = {
              ...state,
              busy: false,
              items: [...state.items, { id: 'answer', text: 'finished after desktop exit' }],
            };
            publish();
          }, 250);
          return true;
        },
        abort() {
          state = { ...state, busy: false, aborted: true };
          publish();
          return true;
        },
        async dispose() {},
      };
    },
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
  });
  transport = createSessionTransport({
    handleCall: (name, args, ctx) => service.handleCall(name, args, ctx),
    clientGraceMs: 10_000,
    sweepMs: 1_000,
    onClientDropped: (token) => service.releaseClient(token),
    onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  send({ type: 'ready', discovery: { pid: process.pid, port, token } });
  process.on('message', async (message) => {
    if (message?.type !== 'stop') return;
    await service.stop('test stop');
    await transport.stop();
    process.exit(0);
  });
} else if (ROLE === 'desktop') {
  const { attachSession } = await import('../src/standalone/session-client.mjs');
  const discovery = JSON.parse(process.env.MIXDOG_LIFETIME_DISCOVERY || '{}');
  const client = await attachSession({ discovery, cwd: process.cwd() });
  await client.call('session.subscribe', {
    sessionId: process.env.MIXDOG_LIFETIME_SESSION_ID,
  });
  send({ type: 'subscribed' });
  process.on('message', async (message) => {
    if (message?.type !== 'close') return;
    await client.close('desktop window closed');
    process.exit(0);
  });
} else {
  const { attachSession } = await import('../src/standalone/session-client.mjs');

  function childMessage(child, type, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for child ${type}`)), timeoutMs);
      const onMessage = (message) => {
        if (message?.type !== type) return;
        clearTimeout(timer);
        child.off('message', onMessage);
        resolve(message);
      };
      child.on('message', onMessage);
    });
  }

  function childExit(child, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for child exit')), timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  function waitFor(predicate, message, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        let value;
        try { value = predicate(); } catch (error) { reject(error); return; }
        if (value) { resolve(value); return; }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timeout: ${message}`));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  test('desktop process exit does not interrupt a daemon-owned terminal turn', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-session-lifetime-'));
    const childEnv = {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: root,
      MIXDOG_DATA_DIR: root,
    };
    const daemon = fork(THIS_FILE, [], {
      env: { ...childEnv, MIXDOG_LIFETIME_TEST_ROLE: 'daemon' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let desktop = null;
    let terminal = null;
    t.after(async () => {
      try { await terminal?.close?.('test cleanup'); } catch {}
      try { desktop?.kill?.(); } catch {}
      if (daemon.exitCode == null) {
        try { daemon.send({ type: 'stop' }); } catch {}
        try { await childExit(daemon, 3_000); } catch { try { daemon.kill(); } catch {} }
      }
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    });

    const ready = await childMessage(daemon, 'ready');
    const discovery = ready.discovery;
    const snapshots = new Map();
    terminal = await attachSession({
      discovery,
      cwd: process.cwd(),
      onFrame: (frame) => {
        if (frame?.type !== 'session-state' || !frame.sessionId) return;
        const base = snapshots.get(frame.sessionId) || {};
        if (frame.full) {
          snapshots.set(frame.sessionId, frame.full);
          return;
        }
        if (!frame.patch) return;
        const next = { ...base, ...(frame.patch.set || {}) };
        if (frame.patch.itemsAppend) {
          next.items = (Array.isArray(base.items) ? base.items : [])
            .slice(0, frame.patch.itemsAppend.from)
            .concat(frame.patch.itemsAppend.values || []);
        }
        for (const key of frame.patch.remove || []) delete next[key];
        snapshots.set(frame.sessionId, next);
      },
    });
    const created = await terminal.call('session.create', { cwd: process.cwd() });
    desktop = fork(THIS_FILE, [], {
      env: {
        ...childEnv,
        MIXDOG_LIFETIME_TEST_ROLE: 'desktop',
        MIXDOG_LIFETIME_DISCOVERY: JSON.stringify(discovery),
        MIXDOG_LIFETIME_SESSION_ID: created.sessionId,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    await childMessage(desktop, 'subscribed');

    const submitted = await terminal.call('session.submit', {
      sessionId: created.sessionId,
      prompt: 'long turn',
      options: { id: 'process-lifetime-submit' },
    }, { callId: 'session-submit:process-lifetime' });
    assert.equal(submitted.accepted, true);
    await waitFor(() => snapshots.get(created.sessionId)?.busy === true, 'turn becomes active');

    desktop.send({ type: 'close' });
    assert.equal(await childExit(desktop), 0, 'desktop client exits cleanly');
    assert.doesNotThrow(() => process.kill(discovery.pid, 0), 'daemon PID survives desktop exit');

    const completed = await waitFor(() => {
      const snapshot = snapshots.get(created.sessionId);
      return snapshot?.items?.at(-1)?.text === 'finished after desktop exit' ? snapshot : null;
    }, 'terminal receives completion after desktop exit');
    assert.equal(completed.busy, false);
    assert.notEqual(completed.aborted, true);
  });
}
