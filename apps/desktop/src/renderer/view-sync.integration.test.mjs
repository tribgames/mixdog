import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import { startRelay } from '../../../relay/server.mjs';
import { startRemoteRelay } from '../main/remote-relay.ts';
import { viewSyncHost } from '../main/test-support/view-sync-host.mjs';
import { createSessionLaneStore } from './session-lane-store.ts';

async function until(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('View synchronization did not settle.');
    await delay(10);
  }
}

test('real host, relay and browser shim restore lost final frames and agent rows through repeated reconnects', async () => {
  const f = await viewSyncHost();
  let relay, handle, dom, stop, stopPane;
  const sockets = [];
  const priorWindow = globalThis.window;
  const store = createSessionLaneStore({ decorator: { decorate: (value) => value, clear() {} } });
  try {
    f.put('lead', 'initial answer');
    relay = await startRelay({ port: 0, dataDir: `${f.directory}/relay` });
    const origin = `http://127.0.0.1:${relay.port}`;
    handle = await startRemoteRelay({ relayUrl: `ws://127.0.0.1:${relay.port}`, userDataPath: f.directory, host: f.host });
    const deviceId = new URL(handle.clientUrl).pathname.split('/')[2];
    await until(() => relay.store.isKnown(deviceId));
    const registered = relay.store.registerClient(deviceId, '11111111-2222-3333-4444-555555555555', {});
    dom = new JSDOM('<!doctype html><body><p id="transcript"></p></body>', {
      url: `${origin}/d/${deviceId}/`, runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    globalThis.window = w;
    Object.defineProperty(w.navigator, 'userAgent', { value: 'Android Mobile' });
    w.matchMedia = () => ({ matches: true });
    Object.defineProperty(w, 'crypto', { value: webcrypto });
    Object.assign(w, {
      TextEncoder, TextDecoder, ArrayBuffer, Uint8Array,
      CompressionStream, DecompressionStream,
      fetch: (url, options) => fetch(new URL(url, origin), options),
    });
    class BrowserSocket extends WebSocket {
      constructor(url) { super(url, { headers: { Origin: origin } }); sockets.push(this); }
      emit(event, ...args) {
        if (event === 'message' && this.dropNext && args[1] === true) {
          this.dropNext = false;
          this.dropped = true;
          return true;
        }
        return super.emit(event, ...args);
      }
    }
    w.WebSocket = BrowserSocket;
    for (const [key, value] of Object.entries({
      'mixdog.remote-token': registered.token,
      'mixdog.remote-paired': '1',
      'mixdog.remote-browser-id': registered.clientId,
      'mixdog.remote-e2ee-public-key': handle.pairing.serverPublicKey,
      'mixdog.remote-e2ee-secret': handle.pairing.pairingSecret,
    })) w.localStorage.setItem(key, value);
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('./remote-shim.ts', import.meta.url))],
      bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022',
    });
    w.eval(bundle.outputFiles[0].text);
    const api = w.mixdogDesktop;
    stop = store.start(api.subscribeSessionState);
    const text = w.document.getElementById('transcript');
    stopPane = store.subscribe('lead', () => {
      text.textContent = store.get('lead')?.items?.[0]?.text ?? '';
    });
    const agentRows = [];
    api.subscribeAgentPool((rows) => agentRows.push(rows));
    await api.setVisibleSessions(['lead']);
    await until(() => text.textContent === 'initial answer');
    for (let cycle = 0; cycle < 4; cycle++) {
      const socket = sockets.at(-1);
      socket.dropNext = true;
      socket.dropped = false;
      f.put('lead', `finished ${cycle}`);
      await until(() => socket.dropped);
      assert.notEqual(text.textContent, `finished ${cycle}`);
      f.state.agents = [{ sessionId: `agent-${cycle}`, ownerSessionId: 'lead', status: 'completed' }];
      w.dispatchEvent(new w.Event('online'));
      await until(() => text.textContent === `finished ${cycle}`
        && agentRows.at(-1)?.[0]?.sessionId === `agent-${cycle}`
        && w.document.documentElement.dataset.mixdogRemoteConnection === 'connected');
      socket.terminate();
      await until(() => sockets.length === cycle + 2
        && w.document.documentElement.dataset.mixdogRemoteConnection === 'connected');
    }
    const [first, retry] = await Promise.all([
      api.submitNewTask('created once', { id: 'web-creation-receipt' }),
      api.submitNewTask('created once', { id: 'web-creation-receipt' }),
    ]);
    assert.equal(first.sessionId, retry.sessionId);
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.submits, 1);
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const replay = f.host.replaySessionStates.bind(f.host);
    f.host.replaySessionStates = async (...args) => {
      entered.resolve();
      await gate.promise;
      return replay(...args);
    };
    f.host.abortSession = async () => true;
    const recovery = api.setVisibleSessions(['lead']);
    await entered.promise;
    try {
      assert.equal(await api.abortSession('lead'), true);
      assert.equal(w.document.documentElement.dataset.mixdogRemoteConnection, 'syncing');
    } finally { gate.resolve(); }
    await recovery;
  } finally {
    stopPane?.();
    stop?.();
    store.clear();
    if (dom) {
      Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    }
    for (const socket of sockets) socket.terminate();
    dom?.window.close();
    globalThis.window = priorWindow;
    await handle?.close();
    await relay?.close();
    await f.close();
  }
});
