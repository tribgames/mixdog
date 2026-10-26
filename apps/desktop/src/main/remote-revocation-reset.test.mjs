// A damaged revocation record must never leave a paired phone trusted. The
// pending client revocations (remote-clients.json) and the queued device
// revocations (relay-device-revocations.json) are the only record of what the
// user already revoked; once one is damaged nothing can prove a revocation
// was not in it, so the pairing is reset (every phone must pair again) before
// a relay leg opens. Local use never waits on it.
//
// An unpair the relay has not confirmed is part of that record too: it stays
// queued (and in force, see remote-screen/screen-access-publisher.ts) across a
// restart until the relay confirms it or the device is approved again.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { createDesktopService } from './desktop-service.ts';
import { generateRelayClaimKeyPair } from '../shared/remote-e2ee.ts';
import { generateSecureDesktopControllerKey } from '../shared/secure-desktop-grant.ts';
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
  /** How the relay answers a client revoke. */
  const relay = { revokeClientOk: true };
  server.on('connection', (socket, request) => {
    const credentials = Buffer.from(String(request.headers.authorization).split(' ')[1], 'base64').toString('utf8');
    const leg = { deviceId: credentials.split(':')[0], frames: [], socket };
    legs.push(leg);
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      leg.frames.push(frame.type);
      if (frame.type === 'revoke-device') socket.send(JSON.stringify({ type: 'device-revoked', ok: true }));
      if (frame.type === 'revoke-client') {
        socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: relay.revokeClientOk }));
      }
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
        runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
        emit: (message) => message.kind === 'desktop-event' && events.push(message),
      });
      return (operation, ...args) => service.invoke('invokeDesktopOperation', [operation, args]);
    };
    const after = async () => ({
      device: await loadOrCreateDevice(dir),
      token: await loadOrCreatePairingToken(dir),
      e2ee: await loadOrCreateRelayE2EEIdentity(dir),
    });
    /** Quits the service; `start` again is the next app launch. */
    const stop = async () => {
      await service?.dispose();
      service = undefined;
    };
    await run({ dir, before, after, legs, events, start, stop, relay });
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

const PHONE = '0123456789abcdef0123456789abcdef';
const pendingRevokes = (dir) => JSON.parse(readFileSync(join(dir, CLIENTS), 'utf8')).pendingRevokes;
/** The newest relay leg is up: the desktop registered its pairing token. */
const connected = (context) => Boolean(context.legs.at(-1)?.frames.includes('set-client-token'));

test('an unpair the relay refuses stays recorded, across a restart, until the relay confirms it', () =>
  paired(async (context) => {
    let invoke = await context.start();
    await invoke('remoteAccessStart');
    await wait(() => connected(context));
    context.relay.revokeClientOk = false;
    await assert.rejects(invoke('remoteAccessRevokeClient', PHONE), /failed/);
    assert.deepEqual(pendingRevokes(context.dir), [PHONE]);
    // The next launch reads the record back, and its relay leg retries it.
    await context.stop();
    const launched = context.legs.length;
    invoke = await context.start();
    await invoke('remoteAccessStart');
    await wait(() => context.legs.slice(launched).some((leg) => leg.frames.includes('revoke-client')));
    assert.deepEqual(pendingRevokes(context.dir), [PHONE], 'refused again: still recorded');
    // Confirmed: the record clears.
    context.relay.revokeClientOk = true;
    await invoke('remoteAccessRevokeClient', PHONE);
    assert.deepEqual(pendingRevokes(context.dir), []);
  }));

test('approving the unpaired device again withdraws its unconfirmed unpair', () =>
  paired(async (context) => {
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await wait(() => connected(context));
    context.relay.revokeClientOk = false;
    await assert.rejects(invoke('remoteAccessRevokeClient', PHONE), /failed/);
    assert.deepEqual(pendingRevokes(context.dir), [PHONE]);
    const leg = context.legs.at(-1);
    const { publicKey } = await generateRelayClaimKeyPair();
    leg.socket.send(
      JSON.stringify({
        type: 'client-claim',
        claimId: 'claim-1',
        clientId: PHONE,
        publicKey,
        name: 'Phone',
        expiresAt: Date.now() + 60_000,
      })
    );
    await wait(() => context.events.some((event) => event.name === 'remote-client-claim'));
    assert.equal(await invoke('remoteAccessResolveClaim', 'claim-1', true), true);
    await wait(() => leg.frames.includes('claim-approve'));
    await wait(() => pendingRevokes(context.dir).length === 0);
  }));

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

// PC access: every pairing removal owes the removed phones' secure-desktop
// controller keys (remote-client-cache.ts `oweAccess`) before any mapping goes,
// and tells the desktop app, which takes them over and revokes them.
const PHONE_2 = 'fedcba9876543210fedcba9876543210';
const controllerKeys = async (count) =>
  Promise.all(Array.from({ length: count }, async () => (await generateSecureDesktopControllerKey()).publicKey));
const cacheFile = (dir) => JSON.parse(readFileSync(join(dir, CLIENTS), 'utf8'));
const writeMappedCache = (dir, keys) =>
  writeFileSync(
    join(dir, CLIENTS),
    JSON.stringify({ clients: [], pendingRevokes: [], repairRequired: false, controllerKeys: keys })
  );
const announcedOwed = (context) => context.events.some((event) => event.name === 'remote-controller-keys-owed');

test('rotating the pairing leaves every previously paired phone’s access key owed', () =>
  paired(async (context) => {
    const [first, second] = await controllerKeys(2);
    writeMappedCache(context.dir, { [PHONE]: first, [PHONE_2]: second });
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await wait(() => connected(context));
    await invoke('remoteAccessRotate');
    assert.deepEqual(cacheFile(context.dir).controllerKeys, {});
    assert.deepEqual(cacheFile(context.dir).owedAccessKeys, [first, second]);
    assert.deepEqual(await invoke('remoteAccessOwedControllerKeys'), { keys: [first, second], unknown: 0 });
    assert.equal(announcedOwed(context), true);
    // The desktop app took one over.
    await invoke('remoteAccessSettleOwedControllerKeys', [first], 0);
    assert.deepEqual(cacheFile(context.dir).owedAccessKeys, [second]);
    // The old registration's revocation is done with the profile before the test removes it.
    await wait(() => JSON.parse(readFileSync(join(context.dir, QUEUE), 'utf8')).length === 0);
  }));

test('the recovery reset leaves every paired phone’s access key owed, or unknown when the record was damaged', async () => {
  await paired(async (context) => {
    const [first, second] = await controllerKeys(2);
    writeMappedCache(context.dir, { [PHONE]: first, [PHONE_2]: second });
    writeFileSync(join(context.dir, QUEUE), '[{"deviceId":"11111111-2222-3333-4444-5555');
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await assertPairingReset(context);
    assert.deepEqual(cacheFile(context.dir).controllerKeys, {});
    assert.deepEqual(cacheFile(context.dir).owedAccessKeys, [first, second]);
    assert.equal(announcedOwed(context), true);
  });
  await paired(async (context) => {
    writeFileSync(join(context.dir, CLIENTS), Buffer.alloc(160));
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await assertPairingReset(context);
    assert.ok((await invoke('remoteAccessOwedControllerKeys')).unknown > 0, 'the keys went with the damage');
  });
});

test('the daemon’s unpair route owes the phone’s access key like the settings route, before the relay is asked', () =>
  paired(async (context) => {
    const [key] = await controllerKeys(1);
    writeMappedCache(context.dir, { [PHONE]: key });
    const invoke = await context.start();
    await invoke('remoteAccessStart');
    await wait(() => connected(context));
    context.relay.revokeClientOk = false;
    await assert.rejects(invoke('remoteAccessRevokeClient', PHONE), /failed/);
    assert.deepEqual(cacheFile(context.dir).owedAccessKeys, [key], 'owed even though the relay refused');
    assert.deepEqual(await invoke('remoteAccessControllerKeys'), [{ clientId: PHONE, publicKey: key, unpaired: true }]);
    assert.equal(announcedOwed(context), true);
    context.relay.revokeClientOk = true;
    await invoke('remoteAccessRevokeClient', PHONE);
    assert.deepEqual(cacheFile(context.dir).controllerKeys, {});
    assert.deepEqual(cacheFile(context.dir).owedAccessKeys, [key], 'still owed until the app takes it over');
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
