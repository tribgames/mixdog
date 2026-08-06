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

test('streams media over http through the relay, with ranges and cache validators', async () => {
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
    const phone = await connectPhone(relay.port, desktop.token);
    phone.close();
    const base = `http://127.0.0.1:${relay.port}/media/${assetId}`;
    const full = await fetch(`${base}?variant=thumb&token=${desktop.token}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'image/webp');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await full.arrayBuffer());
    assert.equal(body.length, bytes.length);
    assert.equal(body.equals(bytes), true);

    // Seeking a clip must cost a window, not the whole file.
    const ranged = await fetch(`${base}?variant=original&token=${desktop.token}`, {
      headers: { Range: 'bytes=100-199' },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
    assert.equal(Buffer.from(await ranged.arrayBuffer()).equals(bytes.subarray(100, 200)), true);

    // Re-visits revalidate instead of re-downloading.
    const cached = await fetch(`${base}?variant=thumb&token=${desktop.token}`, {
      headers: { 'If-None-Match': full.headers.get('etag') },
    });
    assert.equal(cached.status, 304);

    const missing = await fetch(
      `http://127.0.0.1:${relay.port}/media/${randomUUID()}?variant=thumb&token=${desktop.token}`,
    );
    assert.equal(missing.status, 404);
    const unauthorized = await fetch(`${base}?variant=thumb&token=deadbeef`);
    assert.equal(unauthorized.status, 401);

    // The probe answers for the desktop that would produce the bytes.
    const health = await fetch(`http://127.0.0.1:${relay.port}/media/healthz?token=${desktop.token}`);
    assert.equal(health.status, 200);
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
test('marks join and resync snapshots as undroppable recovery frames', async () => {
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
  const broadcasts = () => envelopes.filter((frame) => frame.type === 'broadcast');
  try {
    await waitFor(() => legs.length > 0, 'desktop leg never dialed the relay');
    // A phone joining mid-stream: the answer is a full snapshot.
    legs[0].send(JSON.stringify({ type: 'client-open', clientId: 'phone-1' }));
    await waitFor(() => broadcasts().length > 0, 'join never produced a snapshot');
    assert.equal(broadcasts()[0].critical, true);

    // Engine pushes stay droppable — they are recoverable by a later resync.
    host.emit({ items: [], busy: true });
    await waitFor(() => broadcasts().length > 1, 'engine push never reached the leg');
    assert.equal(broadcasts()[1].critical, undefined);

    // An explicit resync request answers with another undroppable snapshot.
    legs[0].send(JSON.stringify({
      type: 'frame',
      clientId: 'phone-1',
      data: JSON.stringify({ method: 'stateResync', params: [] }),
    }));
    await waitFor(() => broadcasts().length > 2, 'resync never produced a snapshot');
    assert.equal(broadcasts()[2].critical, true);
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
    const phone = await connectPhone(relay.port, desktop.token);
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
    ]);
    restarted = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      host,
      userDataPath: desktopDir,
    });
    const freshPhone = await connectPhone(relay.port, restarted.token);
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
    const phone = await connectPhone(relay.port, desktop.token);
    phone.close();
    await delay(300);
    const before = JSON.parse(readFileSync(join(relayDir, 'devices.json'), 'utf8'));
    const previousId = Object.keys(before)[0];

    await relay.close();
    await Promise.all([
      rotateRemoteToken(desktopDir),
      rotateRemoteDevice(desktopDir),
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
    const freshPhone = await connectPhone(relay.port, restarted.token);
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
