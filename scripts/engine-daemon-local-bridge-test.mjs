import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-local-bridge-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
process.env.MIXDOG_ENGINE_DAEMON_HOST = '1';

const { installEngineDaemonLocalBridge } =
  await import('../src/standalone/engine-daemon-local-bridge.mjs');
const { createEngineDaemonService } =
  await import('../src/standalone/engine-daemon-service.mjs');
const { createRemoteEngineSession } =
  await import('../src/standalone/engine-daemon-client.mjs');

test('an in-daemon desktop projection calls the session service without loopback HTTP', async () => {
  const clients = new Map();
  let nextClient = 0;
  let service;
  let state = { sessionId: '', items: [], busy: false };
  const listeners = new Set();
  const engine = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reserveSession(id) {
      state = { ...state, sessionId: String(id) };
      for (const listener of listeners) listener();
      return true;
    },
    submit(text) {
      const value = typeof text === 'string'
        ? text
        : (Array.isArray(text) ? text : [text])
          .map((part) => String(part?.text ?? ''))
          .join('');
      state = { ...state, items: [...state.items, { id: state.items.length + 1, text: value }] };
      for (const listener of listeners) listener();
      return true;
    },
    async dispose() {},
  };
  const bridge = {
    attach({ onFrame = () => {} } = {}) {
      const clientToken = `local_test_${++nextClient}`;
      clients.set(clientToken, onFrame);
      let closed = false;
      return {
        call(name, args = {}, options = {}) {
          if (closed) throw new Error('local bridge closed');
          return service.handleCall(name, args, {
            clientToken,
            ...(options.callId ? { callId: options.callId } : {}),
          });
        },
        async close() {
          if (closed) return;
          closed = true;
          clients.delete(clientToken);
          service.releaseClient(clientToken);
        },
      };
    },
  };
  service = createEngineDaemonService({
    createEngine: async () => engine,
    publishIntervalMs: 1,
    onFrame(frame, targetTokens) {
      const targets = targetTokens ? new Set(targetTokens) : null;
      for (const [token, onFrame] of clients) {
        if (!targets || targets.has(token)) onFrame(frame);
      }
    },
  });
  const uninstall = installEngineDaemonLocalBridge(bridge);
  try {
    const view = await createRemoteEngineSession({ cwd: ROOT });
    assert.match(view.getState().sessionId, /^sess_daemon_/);
    assert.equal(await view.submitAsync('direct bridge'), true);
    assert.equal(state.items.at(-1)?.text, 'direct bridge',
      'the direct call reaches the daemon-owned engine');
    assert.equal(view.getState().items.length, 1,
      'the daemon-local projection receives the updated snapshot');
    assert.equal(existsSync(join(ROOT, 'engine-daemon.json')), false,
      'the daemon-local view never discovers or opens an HTTP transport');
    await view.dispose('test');
  } finally {
    uninstall();
    await service.stop('test end');
    rmSync(ROOT, { recursive: true, force: true });
  }
});
