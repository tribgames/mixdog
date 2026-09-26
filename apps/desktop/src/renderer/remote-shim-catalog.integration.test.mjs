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

async function until(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Condition did not settle.');
    await delay(10);
  }
}

// A cold phone boot marks its session catalog ready only when listSessions
// answers, and a session opened from a notification waits for exactly that.
// The view sync has already delivered the catalog; asking the desktop again
// queued the read behind every capability call the boot had issued first.
test('a synchronized phone answers catalog reads from the synchronized roster, not the call queue', async () => {
  const f = await viewSyncHost();
  let relay, handle, dom;
  const sockets = [];
  const priorWindow = globalThis.window;
  try {
    f.put('lead', 'initial answer');
    f.state.agents = [{ sessionId: 'agent-1', ownerSessionId: 'lead', status: 'running' }];
    relay = await startRelay({ port: 0, dataDir: `${f.directory}/relay` });
    const origin = `http://127.0.0.1:${relay.port}`;
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      userDataPath: f.directory,
      host: f.host,
    });
    const deviceId = new URL(handle.clientUrl).pathname.split('/')[2];
    await until(() => relay.store.isKnown(deviceId));
    const registered = relay.store.registerClient(deviceId, '11111111-2222-3333-4444-555555555555', {});
    dom = new JSDOM('<!doctype html><body></body>', {
      url: `${origin}/d/${deviceId}/`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const w = dom.window;
    globalThis.window = w;
    Object.defineProperty(w.navigator, 'userAgent', { value: 'Android Mobile' });
    w.matchMedia = () => ({ matches: true });
    Object.defineProperty(w, 'crypto', { value: webcrypto });
    Object.assign(w, {
      TextEncoder,
      TextDecoder,
      ArrayBuffer,
      Uint8Array,
      ReadableStream,
      CompressionStream,
      DecompressionStream,
      fetch: (url, options) => fetch(new URL(url, origin), options),
    });
    w.WebSocket = class extends WebSocket {
      constructor(url) {
        super(url, { headers: { Origin: origin } });
        sockets.push(this);
      }
    };
    for (const [key, value] of Object.entries({
      'mixdog.remote-token': registered.token,
      'mixdog.remote-paired': '1',
      'mixdog.remote-browser-id': registered.clientId,
      'mixdog.remote-e2ee-public-key': handle.pairing.serverPublicKey,
      'mixdog.remote-e2ee-secret': handle.pairing.pairingSecret,
    }))
      w.localStorage.setItem(key, value);
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('./remote-shim.ts', import.meta.url))],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
    });
    w.eval(bundle.outputFiles[0].text);
    const api = w.mixdogDesktop;
    await api.setVisibleSessions([]);
    await until(() => w.document.documentElement.dataset.mixdogRemoteConnection === 'connected');

    // Boot capability reads are barriers on the desktop's call lane.
    const invokeCapability = f.host.invokeCapability.bind(f.host);
    f.host.invokeCapability = async (...args) => {
      await delay(1_500);
      return invokeCapability(...args).catch(() => ({ value: null, snapshot: f.host.getSnapshot() }));
    };
    let catalogReads = 0;
    const listSessions = f.host.listSessions.bind(f.host);
    f.host.listSessions = (...args) => {
      catalogReads += 1;
      return listSessions(...args);
    };
    const barrier = api.invokeCapability({ capability: 'getOnboardingStatus' });
    void barrier.catch(() => undefined);
    await delay(50);
    const startedAt = Date.now();
    const [sessions, agents] = await Promise.all([api.listSessions(), api.listAgentPool()]);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1_000, `catalog reads waited ${elapsed}ms behind an unrelated capability call`);
    // Rows cross from the page realm; compare their content.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(
      plain(sessions.map((row) => row.id)),
      (await listSessions()).map((row) => row.id)
    );
    assert.ok(sessions.some((row) => row.id === 'lead'));
    assert.deepEqual(plain(agents), plain(await f.host.listAgentPool()));
    assert.ok(agents.length > 0);
    assert.equal(catalogReads, 0, 'the synchronized roster is not downloaded a second time');
    await barrier;
  } finally {
    if (dom) {
      // Hidden first, so the closing leg does not schedule a redial.
      Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
    }
    for (const socket of sockets) socket.terminate();
    await until(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
    await delay(50);
    dom?.window.close();
    globalThis.window = priorWindow;
    await handle?.close();
    await relay?.close();
    await f.close();
  }
});
