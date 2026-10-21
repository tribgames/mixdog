// A damaged revocation record must never leave a paired phone trusted. The
// pending client revocations (remote-clients.json) and the queued device
// revocations (relay-device-revocations.json) are the only record of what the
// user already revoked; once one is damaged nothing can prove a revocation
// was not in it, so the pairing is reset (every phone must pair again) before
// a relay leg opens. Local use never waits on it.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { createDesktopService } from './desktop-service.ts';
import { activateRemote } from './remote-activation.ts';
import { loadOrCreateRelayE2EEIdentity } from './remote-e2ee.ts';
import { loadOrCreatePairingToken } from './remote-pairing-token.ts';
import { loadOrCreateDevice } from './remote-relay-device.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

const CLIENTS = 'remote-clients.json';
const QUEUE = 'relay-device-revocations.json';

const wait = async (predicate) => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'condition was not met in time');
};

/** An activated install that is already paired under `before`, a relay that
 *  records every leg (who dialled, what it sent), and the service over them. */
async function paired(run) {
  const f = await viewSyncHost();
  const dir = f.options.userDataPath;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  const legs = [];
  const open = new Set();
  server.on('connection', (socket, request) => {
    const credentials = Buffer.from(String(request.headers.authorization).split(' ')[1], 'base64').toString('utf8');
    const leg = { deviceId: credentials.split(':')[0], frames: [] };
    legs.push(leg);
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      leg.frames.push(frame.type);
      if (frame.type === 'revoke-device') socket.send(JSON.stringify({ type: 'device-revoked', ok: true }));
      if (frame.type === 'list-clients') {
        socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients: [] }));
      }
    });
  });
  let service;
  try {
    await activateRemote(dir);
    const before = {
      device: await loadOrCreateDevice(dir),
      token: await loadOrCreatePairingToken(dir),
      e2ee: await loadOrCreateRelayE2EEIdentity(dir),
    };
    const events = [];
    const start = async () => {
      service = await createDesktopService({
        options: f.options,
        runtime: { ...f.runtime, loadConfig: async () => ({}) },
        emit: (message) => message.kind === 'desktop-event' && events.push(message),
      });
      return (operation, ...args) => service.invoke('invokeDesktopOperation', [operation, args]);
    };
    const after = async () => ({
      device: await loadOrCreateDevice(dir),
      token: await loadOrCreatePairingToken(dir),
      e2ee: await loadOrCreateRelayE2EEIdentity(dir),
    });
    await run({ dir, before, after, legs, events, start });
  } finally {
    await service?.dispose();
    for (const socket of open) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previousUrl;
    await rm(f.directory, { recursive: true, force: true });
  }
}

/** Every credential that existed before was replaced, and the old device is
 *  revoked at the relay with its own credentials. */
async function assertPairingReset({ dir, before, after, legs }) {
  await wait(() => legs.some((leg) => leg.deviceId === before.device.deviceId && leg.frames.includes('revoke-device')));
  // The relay acknowledged it, so the queue empties (and the drain is done
  // with the profile before the test removes it).
  await wait(() => JSON.parse(readFileSync(join(dir, QUEUE), 'utf8')).length === 0);
  const now = await after();
  assert.notEqual(now.device.deviceId, before.device.deviceId);
  assert.notEqual(now.token, before.token);
  assert.notEqual(JSON.stringify(now.e2ee), JSON.stringify(before.e2ee));
  assert.equal(
    legs.some((leg) => leg.deviceId === now.device.deviceId),
    true,
    'the relay leg is the new registration'
  );
  assert.equal(
    legs
      .filter((leg) => leg.deviceId === before.device.deviceId)
      .every((leg) => leg.frames.every((frame) => frame === 'revoke-device')),
    true,
    'the old registration is only ever used to revoke itself'
  );
}

test('a NUL-filled remote-clients.json revokes every paired phone before the relay opens', () =>
  paired(async (context) => {
    writeFileSync(join(context.dir, CLIENTS), Buffer.alloc(160));
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await assertPairingReset(context);
    assert.equal(JSON.parse(readFileSync(join(context.dir, CLIENTS), 'utf8')).repairRequired, false);
  }));

test('a damaged relay-device-revocations.json revokes every paired phone before the relay opens', () =>
  paired(async (context) => {
    writeFileSync(join(context.dir, QUEUE), '[{"deviceId":"11111111-2222-3333-4444-5555');
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await assertPairingReset(context);
  }));

test('a wrong-shaped remote-clients.json revokes every paired phone before the relay opens', async () => {
  for (const content of ['{"pendingRevokes":{}}', '{"pendingRevokes":["c1",2]}']) {
    await paired(async (context) => {
      writeFileSync(join(context.dir, CLIENTS), content);
      const invoke = await context.start();
      await invoke('remoteAccessStart');
      await assertPairingReset(context);
      assert.equal(JSON.parse(readFileSync(join(context.dir, CLIENTS), 'utf8')).repairRequired, false, content);
    });
  }
});

test('a relay-device-revocations.json holding an invalid identity revokes every paired phone before the relay opens', async () => {
  for (const content of ['[{}]', '[{"deviceId":"x"},{}]']) {
    await paired(async (context) => {
      writeFileSync(join(context.dir, QUEUE), content);
      const invoke = await context.start();
      await invoke('remoteAccessStart');
      await assertPairingReset(context);
    });
  }
});

test('a damaged remote-clients.json is answered by the reset even while remote access is off, when it is next switched on', () =>
  paired(async (context) => {
    writeFileSync(join(context.dir, CLIENTS), Buffer.alloc(40));
    const invoke = await context.start();
    await invoke('remoteAccessSetEnabled', false);
    assert.equal(context.legs.length, 0, 'off: no relay leg');
    assert.deepEqual((await invoke('remoteAccessInfo', true)).relay.clients, [], 'local reads still work');
    await invoke('remoteAccessSetEnabled', true);
    await assertPairingReset(context);
  }));

test('undamaged revocation records leave the pairing alone', () =>
  paired(async (context) => {
    writeFileSync(join(context.dir, QUEUE), '[]');
    writeFileSync(
      join(context.dir, CLIENTS),
      JSON.stringify({ clients: [], pendingRevokes: [], repairRequired: false })
    );
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await wait(() => context.legs.length > 0);
    const now = await context.after();
    assert.deepEqual(now, context.before);
    assert.equal(
      context.legs.every((leg) => leg.deviceId === context.before.device.deviceId),
      true
    );
  }));

test('a record that cannot even be read keeps the relay closed while local use goes on', () =>
  paired(async (context) => {
    // A directory where the queue belongs: reading it fails with EISDIR.
    mkdirSync(join(context.dir, QUEUE));
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(context.legs.length, 0, 'no relay leg opened over an unverifiable revocation record');
    assert.equal(
      context.events.some((event) => event.name === 'remote-access-status' && event.value.status === 'failed'),
      true,
      'the failure is reported'
    );
    assert.equal((await invoke('remoteAccessSettings')).enabled, true, 'the service itself still answers');
    assert.deepEqual(await context.after(), context.before, 'nothing was replaced on a guess');
  }));
