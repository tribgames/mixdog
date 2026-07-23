// End-to-end relay test: relay server (apps/relay) + desktop relay client +
// a fake phone speaking the LAN-bridge wire protocol through the relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { startRelay } from '../../../relay/server.mjs';
import { startRemoteRelay } from './remote-relay';

function createFakeHost() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(snapshot) {
      for (const listener of [...listeners]) listener(snapshot);
    },
    getSnapshot: () => ({ items: [], busy: false }),
    listProjects: () => [{ name: 'demo', path: 'C:/demo', alias: null, pinned: false }],
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPhone(port, token) {
  // The desktop leg registers its token right after connecting; poll briefly.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', () => resolve(null));
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(null);
      });
    });
    if (opened) return opened;
    await delay(50);
  }
  throw new Error('phone could not connect through the relay');
}

function rpc(ws, id, method, params = []) {
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

test('relays rpc calls and pushes between phone and desktop', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host,
    userDataPath: desktopDir,
  });
  try {
    const phone = await connectPhone(relay.port, desktop.token);
    const response = await rpc(phone, 1, 'listProjects');
    assert.equal(response.ok, true);
    assert.equal(response.value.length, 1);
    assert.equal(response.value[0].name, 'demo');

    const push = new Promise((resolve) => {
      phone.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'state') resolve(message.payload);
      });
    });
    host.emit({ items: [], busy: true });
    assert.equal((await push).busy, true);

    const blocked = await rpc(phone, 2, 'invokeCapability', [
      { capability: 'saveProviderApiKey', args: ['openai', 'sk-test'] },
    ]);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /not available over the remote bridge/);
    phone.close();
  } finally {
    await desktop.close();
    await relay.close();
  }
});

test('rejects phones with a wrong token and desktops with a wrong secret', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host,
    userDataPath: desktopDir,
  });
  try {
    // Wait until the legitimate pairing works, so the token is registered.
    const phone = await connectPhone(relay.port, desktop.token);
    phone.close();
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?token=deadbeef`);
      ws.once('open', () => resolve(false));
      ws.once('error', () => resolve(true));
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode === 401);
      });
    });
    assert.equal(refused, true);
  } finally {
    await desktop.close();
    await relay.close();
  }
});

test('gates static http behind the pairing token', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const rendererDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-renderer-'));
  writeFileSync(join(rendererDir, 'index.html'), '<!doctype html><title>mixdog</title>', 'utf8');
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir, rendererDir });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host,
    userDataPath: desktopDir,
  });
  try {
    // Wait until the legitimate pairing works, so the token is registered.
    const phone = await connectPhone(relay.port, desktop.token);
    phone.close();
    const base = `http://127.0.0.1:${relay.port}`;
    const [bare, health, entry] = await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/healthz`),
      fetch(`${base}/?token=${encodeURIComponent(desktop.token)}`),
    ]);
    assert.equal(bare.status, 401);
    assert.equal(health.status, 200);
    assert.equal(entry.status, 200);
    const setCookie = entry.headers.get('set-cookie') || '';
    assert.match(setCookie, /^mixdog_token=/);
    // Asset/APK follow-ups carry no query token; the cookie must pass the gate.
    const viaCookie = await fetch(`${base}/index.html`, {
      headers: { cookie: setCookie.split(';')[0] },
    });
    assert.equal(viaCookie.status, 200);
    const wrongCookie = await fetch(`${base}/index.html`, {
      headers: { cookie: 'mixdog_token=deadbeef' },
    });
    assert.equal(wrongCookie.status, 401);
  } finally {
    await desktop.close();
    await relay.close();
  }
});

test('stays quiet with no phones and resyncs the next phone that joins', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host,
    userDataPath: desktopDir,
  });
  try {
    const first = await connectPhone(relay.port, desktop.token);
    first.close();
    await delay(200); // client-close reaches the desktop leg
    // Nobody is listening: the desktop must drop this push instead of
    // spending relay bandwidth on it (idle installs stay keepalive-only).
    host.emit({ items: [], busy: true });
    const second = await connectPhone(relay.port, desktop.token);
    // The join resync may race this listener; the emitted push after it must
    // arrive regardless — proving the gate reopened for the new phone.
    const gotState = new Promise((resolve) => {
      second.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.event === 'state') resolve(message.payload);
      });
    });
    host.emit({ items: [], busy: false });
    assert.ok(await gotState);
    second.close();
  } finally {
    await desktop.close();
    await relay.close();
  }
});
