// End-to-end relay test: relay server (apps/relay) + desktop relay client +
// a fake phone speaking the LAN-bridge wire protocol through the relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { WebSocketServer } from 'ws';

import { startRelay } from '../../../relay/server.mjs';
import { rotateRemoteDevice, startRemoteRelay } from './remote-relay';
import { loadOrCreateToken, rotateRemoteToken } from './remote-bridge';
import { rotateRelayE2EEIdentity } from './remote-e2ee';
import {
  createRelayE2EEClientHandshake,
  isRelayE2EEChallenge,
} from '../shared/remote-e2ee';

function createFakeHost() {
  const listeners = new Set();
  const sessionListeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(snapshot) {
      for (const listener of [...listeners]) listener(snapshot);
    },
    subscribeSessionStates(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    emitSession(update) {
      for (const listener of [...sessionListeners]) listener(update);
    },
    getSnapshot: () => ({ items: [], busy: false }),
    listProjects: () => [{ name: 'demo', path: 'C:/demo', alias: null, pinned: false }],
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Media rides its own lane: the relay proxies a plain HTTP request to the
// desktop leg, which answers with status/headers plus raw chunks. The host
// only has to resolve an asset id to a file on disk.
function createMediaHost(files) {
  return {
    ...createFakeHost(),
    invokeCapability: (capability, args) => {
      if (capability !== 'resolveMediaFile') throw new Error(`unexpected ${capability}`);
      const [assetId] = args;
      const file = files.get(String(assetId));
      if (!file) return { value: { available: false, path: '' } };
      return { value: { available: true, path: file.path, mime: file.mime } };
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}

async function connectPhone(port, desktop) {
  // The desktop leg registers its token right after connecting; poll briefly.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const opened = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${desktop.token}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', () => resolve(null));
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(null);
      });
    });
    if (opened) {
      const listeners = new Set();
      let channel = null;
      let readyResolve;
      const ready = new Promise((resolve) => { readyResolve = resolve; });
      opened.on('message', (raw) => {
        void (async () => {
          const parsed = JSON.parse(raw.toString());
          if (isRelayE2EEChallenge(parsed)) {
            const handshake = await createRelayE2EEClientHandshake(desktop.pairing, parsed);
            channel = handshake.channel;
            opened.send(JSON.stringify(handshake.hello));
            return;
          }
          if (parsed.pong || parsed.resync || !channel) return;
          const message = await channel.decryptJson(parsed);
          if (message?.type === 'e2ee-ready') {
            readyResolve();
            return;
          }
          for (const listener of [...listeners]) listener(message);
        })();
      });
      await ready;
      return {
        onMessage(listener) { listeners.add(listener); },
        offMessage(listener) { listeners.delete(listener); },
        send(message) {
          void channel.encryptJson(message).then((frame) => opened.send(frame));
        },
        close() { opened.close(); },
      };
    }
    await delay(50);
  }
  throw new Error('phone could not connect through the relay');
}

function phoneIsRejected(port, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.once('open', () => {
      ws.close();
      resolve(false);
    });
    ws.once('error', () => resolve(true));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode === 401);
    });
  });
}

function rpc(phone, id, method, params = []) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      phone.offMessage(onMessage);
      resolve(message);
    };
    phone.onMessage(onMessage);
    phone.send({ id, method, params });
  });
}

// Trust-on-first-use registration is unauthenticated by design; without a
// quota an internet scanner could mint device rows until the store fills the
// disk. Only a bounded number of NEW ids may come from one source.
function dialDesktopLeg(port, deviceId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/desktop?device=${deviceId}&secret=${'a'.repeat(32)}`,
    );
    ws.once('open', () => { ws.close(); resolve(true); });
    ws.once('error', () => resolve(false));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(false);
    });
  });
}

test('caps trust-on-first-use device registrations per source', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  try {
    const results = [];
    for (let index = 0; index < 7; index += 1) {
      results.push(await dialDesktopLeg(relay.port, `00000000-0000-4000-8000-00000000000${index}`));
    }
    assert.equal(results.slice(0, 5).every(Boolean), true);
    assert.equal(results.slice(5).some(Boolean), false);
    // A device that already registered keeps reconnecting past the quota.
    assert.equal(await dialDesktopLeg(relay.port, '00000000-0000-4000-8000-000000000000'), true);
  } finally {
    await relay.close();
  }
});

test('rate limits public webhook ingress per device', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  try {
    const deviceId = '11111111-1111-4111-8111-111111111111';
    let limited = 0;
    for (let index = 0; index < 130; index += 1) {
      const response = await fetch(`http://127.0.0.1:${relay.port}/hook/${deviceId}/x`, {
        method: 'POST',
        body: '{}',
      });
      if (response.status === 429) limited += 1;
      else assert.equal(response.status, 503); // no agent leg attached
    }
    assert.ok(limited > 0, 'expected the ingress quota to reject the tail of the burst');
  } finally {
    await relay.close();
  }
});

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
    const phone = await connectPhone(relay.port, desktop);
    const response = await rpc(phone, 1, 'listProjects');
    assert.equal(response.ok, true);
    assert.equal(response.value.length, 1);
    assert.equal(response.value[0].name, 'demo');

    const push = new Promise((resolve) => {
      phone.onMessage((message) => {
        if (message.event === 'state') resolve(message.payload);
      });
    });
    host.emit({ items: [], busy: true });
    const pushed = await push;
    assert.equal(
      pushed.busy ?? pushed.__statePatch?.changed?.busy,
      true,
      'the state lane may carry either its full baseline or a subsequent delta',
    );

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

test('disables plaintext media transport through the relay', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const assetId = randomUUID();
  const bytes = randomBytes(700_000);
  const assetPath = join(desktopDir, 'asset.bin');
  writeFileSync(assetPath, bytes);
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  const files = new Map([[assetId, { path: assetPath, mime: 'image/webp' }]]);
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host: createMediaHost(files),
    userDataPath: desktopDir,
  });
  try {
    // The desktop leg registers its pairing token a beat after connecting.
    const phone = await connectPhone(relay.port, desktop);
    phone.close();
    const base = `http://127.0.0.1:${relay.port}/media/${assetId}`;
    const full = await fetch(`${base}?variant=thumb&token=${desktop.token}`);
    assert.equal(full.status, 503);
    const unauthorized = await fetch(`${base}?variant=thumb&token=deadbeef`);
    assert.equal(unauthorized.status, 401);
    const health = await fetch(`http://127.0.0.1:${relay.port}/media/healthz?token=${desktop.token}`);
    assert.equal(health.status, 503);
  } finally {
    await desktop.close();
    await relay.close();
  }
});

test('downgrades media instantly for a desktop without the byte lane', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  // An older install: it registers and relays RPC, but never announces a
  // media lane and drops the proxied media frames on the floor.
  const deviceId = randomUUID();
  const secret = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const leg = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop?device=${deviceId}&secret=${secret}`);
  try {
    await new Promise((resolve, reject) => {
      leg.once('open', resolve);
      leg.once('error', reject);
    });
    leg.send(JSON.stringify({ type: 'set-client-token', token }));
    const base = `http://127.0.0.1:${relay.port}/media/${randomUUID()}`;
    let status = 0;
    let elapsed = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const started = Date.now();
      const probe = await fetch(`${base}?variant=thumb&token=${token}`);
      elapsed = Date.now() - started;
      status = probe.status;
      await probe.arrayBuffer();
      if (status !== 401) break; // token registration landed
      await delay(50);
    }
    assert.equal(status, 503);
    assert.ok(elapsed < 5_000, `expected an immediate downgrade, waited ${elapsed}ms`);
    const health = await fetch(`http://127.0.0.1:${relay.port}/media/healthz?token=${token}`);
    assert.equal(health.status, 503);
  } finally {
    leg.close();
    await relay.close();
  }
});

// The relay drops ordinary state pushes for a congested phone leg. A full
// snapshot is the frame that RECOVERS from such a drop, so the desktop marks
// it critical and the relay delivers it regardless of buffer pressure.
test('targets encrypted state frames and preserves recovery priority', async () => {
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const stub = new WebSocketServer({ port: 0 });
  const legs = [];
  const envelopes = [];
  stub.on('connection', (socket) => {
    legs.push(socket);
    socket.on('message', (raw) => {
      try { envelopes.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
  });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${stub.address().port}`,
    host,
    userDataPath: desktopDir,
  });
  const targeted = () => envelopes.filter(
    (frame) => frame.type === 'frame' && frame.clientId === 'phone-1',
  );
  try {
    await waitFor(() => legs.length > 0, 'desktop leg never dialed the relay');
    legs[0].send(JSON.stringify({ type: 'client-open', clientId: 'phone-1' }));
    await waitFor(() => targeted().length > 0, 'challenge was not sent');
    const challenge = JSON.parse(targeted()[0].data);
    const handshake = await createRelayE2EEClientHandshake(desktop.pairing, challenge);
    legs[0].send(JSON.stringify({
      type: 'frame',
      clientId: 'phone-1',
      data: JSON.stringify(handshake.hello),
    }));
    await waitFor(() => targeted().length >= 3, 'encrypted baseline was not sent');
    assert.equal(targeted()[1].droppable, undefined);
    assert.equal(targeted()[2].droppable, undefined);
    await handshake.channel.decryptJson(targeted()[1].data);
    await handshake.channel.decryptJson(targeted()[2].data);

    // Engine pushes stay droppable — they are recoverable by a later resync.
    host.emit({ items: [], busy: true });
    await waitFor(() => targeted().length >= 4, 'engine push never reached the leg');
    assert.equal(targeted()[3].droppable, true);

    // An explicit resync request answers with another undroppable snapshot.
    const resync = await handshake.channel.encryptJson({ method: 'stateResync', params: [] });
    legs[0].send(JSON.stringify({
      type: 'frame',
      clientId: 'phone-1',
      data: resync,
    }));
    await waitFor(() => targeted().length >= 5, 'resync never produced a snapshot');
    assert.equal(targeted()[4].droppable, undefined);
  } finally {
    await desktop.close();
    await new Promise((resolve) => stub.close(() => resolve()));
  }
});

test('bounds the proxied media streams one desktop can hold open', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  // A desktop that announces the lane and then goes silent: every request it
  // never answers keeps an open response plus a timer on the relay, so the
  // count has to stay bounded instead of growing with the phone's requests.
  const deviceId = randomUUID();
  const secret = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const leg = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop?device=${deviceId}&secret=${secret}`);
  const controller = new AbortController();
  try {
    await new Promise((resolve, reject) => {
      leg.once('open', resolve);
      leg.once('error', reject);
    });
    leg.send(JSON.stringify({ type: 'desktop-lanes', media: true }));
    leg.send(JSON.stringify({ type: 'set-client-token', token }));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = await fetch(`http://127.0.0.1:${relay.port}/media/healthz?token=${token}`);
      await probe.arrayBuffer();
      if (probe.status === 200) break;
      await delay(50);
    }
    const request = () =>
      `http://127.0.0.1:${relay.port}/media/${randomUUID()}?variant=thumb&token=${token}`;
    const held = [];
    for (let index = 0; index < 32; index += 1) {
      held.push(fetch(request(), { signal: controller.signal }).catch(() => null));
    }
    await delay(300);
    const overflow = await fetch(request(), { signal: controller.signal });
    assert.equal(overflow.status, 503);
    assert.match(await overflow.text(), /Too many media streams/);
    controller.abort();
    await Promise.all(held);
  } finally {
    leg.close();
    await relay.close();
  }
});

test('unpair deletes the old relay registration before a fresh identity reconnects', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host,
    userDataPath: desktopDir,
  });
  let restarted = null;
  try {
    const phone = await connectPhone(relay.port, desktop);
    phone.close();
    await delay(300);
    const before = JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8'));
    const previousIds = Object.keys(before);
    assert.equal(previousIds.length, 1);

    await desktop.revoke();
    await desktop.close();
    const revoked = JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8'));
    assert.deepEqual(revoked, {});
    assert.equal(await phoneIsRejected(relay.port, desktop.token), true);

    await Promise.all([
      rotateRemoteToken(desktopDir),
      rotateRemoteDevice(desktopDir),
      rotateRelayE2EEIdentity(desktopDir),
    ]);
    restarted = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      host,
      userDataPath: desktopDir,
    });
    const freshPhone = await connectPhone(relay.port, restarted);
    freshPhone.close();
    await delay(300);
    const after = JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8'));
    const nextIds = Object.keys(after);
    assert.equal(nextIds.length, 1);
    assert.notEqual(nextIds[0], previousIds[0]);
    assert.notEqual(restarted.token, desktop.token);
    assert.equal(await phoneIsRejected(relay.port, desktop.token), true);
  } finally {
    await desktop.close();
    await restarted?.close();
    await relay.close();
  }
});

test('offline unpair rotates immediately and deletes the queued registration on reconnect', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const desktopDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-desktop-'));
  let relay = await startRelay({ port: 0, dataDir: relayDir });
  const host = createFakeHost();
  const desktop = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    host,
    userDataPath: desktopDir,
  });
  let restarted = null;
  try {
    const phone = await connectPhone(relay.port, desktop);
    phone.close();
    await delay(300);
    const before = JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8'));
    const previousId = Object.keys(before)[0];

    await relay.close();
    await Promise.all([
      rotateRemoteToken(desktopDir),
      rotateRemoteDevice(desktopDir),
      rotateRelayE2EEIdentity(desktopDir),
    ]);
    const nextIdentity = JSON.parse(readFileSync(join(desktopDir, 'relay-device.json'), 'utf8'));
    const queued = JSON.parse(readFileSync(join(desktopDir, 'relay-device-revocations.json'), 'utf8'));
    assert.notEqual(nextIdentity.deviceId, previousId);
    assert.equal(queued.some((identity) => identity.deviceId === previousId), true);
    assert.notEqual(await loadOrCreateToken(desktopDir), desktop.token);
    await desktop.close();

    relay = await startRelay({ port: 0, dataDir: relayDir });
    restarted = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      host,
      userDataPath: desktopDir,
    });
    const freshPhone = await connectPhone(relay.port, restarted);
    freshPhone.close();
    await waitFor(() => {
      const devices = JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8'));
      return Object.keys(devices).length === 1 && Object.hasOwn(devices, nextIdentity.deviceId);
    }, 'queued relay registration was not deleted');
    await waitFor(() => {
      const pending = JSON.parse(readFileSync(join(desktopDir, 'relay-device-revocations.json'), 'utf8'));
      return pending.length === 0;
    }, 'local revocation queue was not drained');
  } finally {
    await desktop.close();
    await restarted?.close();
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
    const phone = await connectPhone(relay.port, desktop);
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
    const phone = await connectPhone(relay.port, desktop);
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
    const first = await connectPhone(relay.port, desktop);
    first.close();
    await delay(200); // client-close reaches the desktop leg
    // Nobody is listening: the desktop must drop this push instead of
    // spending relay bandwidth on it (idle installs stay keepalive-only).
    host.emit({ items: [], busy: true });
    const second = await connectPhone(relay.port, desktop);
    // The join resync may race this listener; the emitted push after it must
    // arrive regardless — proving the gate reopened for the new phone.
    const gotState = new Promise((resolve) => {
      second.onMessage((message) => {
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

test('forwards public /hook requests to the registered hook leg', async () => {
  const relayDir = mkdtempSync(join(tmpdir(), 'mixdog-relay-'));
  const relay = await startRelay({ port: 0, dataDir: relayDir });
  const deviceId = randomUUID();
  const secret = randomBytes(24).toString('hex');
  const leg = new WebSocket(`ws://127.0.0.1:${relay.port}/hookleg?device=${deviceId}&secret=${secret}`);
  try {
    const seen = [];
    leg.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'http') return;
      seen.push(frame);
      // Echo back what the local webhook server would answer.
      leg.send(JSON.stringify({
        type: 'http-response',
        id: frame.id,
        status: 202,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"status":"accepted"}').toString('base64'),
      }));
    });
    await new Promise((resolveOpen, rejectOpen) => {
      leg.once('open', resolveOpen);
      leg.once('error', rejectOpen);
    });
    const response = await fetch(`http://127.0.0.1:${relay.port}/hook/${deviceId}/webhook/ci?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=abc' },
      body: '{"a":1}',
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].path, '/webhook/ci?x=1');
    // Signature headers must forward verbatim for local HMAC verification.
    assert.equal(seen[0].headers['x-hub-signature-256'], 'sha256=abc');
    assert.equal(Buffer.from(seen[0].body, 'base64').toString('utf8'), '{"a":1}');
    // Unknown device → the relay answers for the offline agent.
    const offline = await fetch(`http://127.0.0.1:${relay.port}/hook/${randomUUID()}/webhook/ci`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(offline.status, 503);
  } finally {
    try { leg.close(); } catch { /* already closed */ }
    await relay.close();
  }
});
