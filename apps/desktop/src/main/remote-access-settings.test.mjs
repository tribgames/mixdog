import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { createDesktopService } from './desktop-service.ts';
import { activateRemote } from './remote-activation.ts';
import { createRemoteAccessSettingsStore } from './remote-access-settings.ts';
import { loadRemoteHostStore } from './remote-hosts.ts';
import { startRemoteRelay } from './remote-relay.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'mixdog-access-settings-'));
const wait = async (predicate) => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'condition was not met in time');
};

test('settings persist; default follows activation; names trim, cap and reset', async () => {
  const dir = await tmp();
  try {
    const store = createRemoteAccessSettingsStore(dir, () => 'HOST');
    assert.deepEqual(await store.read(), { enabled: false, name: 'HOST', defaultName: 'HOST' });
    assert.equal(await store.disabled(), false, 'never chosen is not off');
    await activateRemote(dir);
    assert.equal((await store.read()).enabled, true, 'existing activated installs default to on');
    await store.setEnabled(false);
    const reopened = createRemoteAccessSettingsStore(dir, () => 'HOST');
    assert.equal((await reopened.read()).enabled, false, 'explicit off survives restart and activation');
    assert.equal(await reopened.disabled(), true);
    assert.equal((await reopened.setName('  Desk  ')).name, 'Desk');
    assert.equal((await reopened.setName('x'.repeat(100))).name.length, 64);
    const reset = await reopened.setName('   ');
    assert.deepEqual(reset, { enabled: false, name: 'HOST', defaultName: 'HOST' });
    await reopened.setName('Kept');
    assert.equal((await createRemoteAccessSettingsStore(dir, () => 'HOST').read()).name, 'Kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a saved PC alias is what the list reports; empty resets to the announced name', async () => {
  const dir = await tmp();
  try {
    const link = { url: `https://relay.example.com/d/${'a'.repeat(32)}/`, deviceId: 'a'.repeat(32) };
    const store = await loadRemoteHostStore(dir);
    const saved = await store.save(link, 'Announced');
    await store.rename(saved.id, '  Office  ');
    assert.equal(store.list()[0].name, 'Office');
    assert.equal((await loadRemoteHostStore(dir)).get(saved.id).name, 'Office', 'alias persists');
    assert.equal((await store.save(link, 'Announced 2')).name, 'Office', 'a re-announce keeps the alias');
    await store.rename(saved.id, '');
    assert.equal(store.get(saved.id).name, 'Announced 2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the relay reports, shakes hands and requests codes under the saved PC name', async () => {
  const dir = await tmp();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  let name = 'First';
  let handle;
  try {
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`,
      userDataPath: dir,
      host: {
        getSnapshot: () => ({ sessionId: 's', items: [], status: 'idle' }),
        listSessions: async () => [],
        listAgentPool: async () => [],
        subscribe: () => () => {},
        subscribeSessions: () => () => {},
        subscribeAgentPool: () => () => {},
        subscribeSessionStates: () => () => {},
        subscribeDesktopEvents: () => () => {},
        setVisibleSessionsForSource: async () => true,
        invokeDesktopOperation: async () => null,
      },
      hostName: () => name,
    });
    const [socket] = await connected;
    const frames = [];
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    await wait(() => frames.some((frame) => frame.type === 'set-client-token'));
    assert.equal(frames.find((frame) => frame.type === 'desktop-name').name, 'First');
    name = 'Second';
    handle.pushName();
    await wait(() => frames.some((frame) => frame.type === 'desktop-name' && frame.name === 'Second'));
    handle.pairCode('ensure');
    await wait(() => frames.some((frame) => frame.type === 'pair-code-request'));
    assert.equal(frames.find((frame) => frame.type === 'pair-code-request').name, 'Second');
  } finally {
    await handle?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('off closes the relay and issues no codes but keeps pairings; outgoing hosts still work; on reconnects', async () => {
  const f = await viewSyncHost();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  let connections = 0;
  const open = new Set();
  const frames = [];
  server.on('connection', (socket) => {
    connections += 1;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === 'list-clients') {
        socket.send(
          JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients: [{ id: 'c1', name: 'Phone' }] })
        );
      }
    });
  });
  const events = [];
  let service;
  try {
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({}) },
      emit: (message) => message.kind === 'desktop-event' && events.push(message),
    });
    const invoke = (operation, ...args) => service.invoke('invokeDesktopOperation', [operation, args]);
    await invoke('remoteAccessStart');
    await invoke('remoteAccessStart');
    await activateRemote(f.options.userDataPath);
    await invoke('remoteAccessStart');
    await wait(() => open.size === 1);

    const off = await invoke('remoteAccessSetEnabled', false);
    assert.equal(off.enabled, false);
    await wait(() => open.size === 0);
    assert.equal(events.at(-1).name, 'remote-access-settings-changed');
    assert.equal(events.at(-1).value.enabled, false);
    await access(join(f.options.userDataPath, 'relay-device.json'));

    const before = connections;
    await invoke('remoteAccessStart');
    await invoke('remoteAccessResume');
    assert.equal(await invoke('remoteAccessPairCode', 'ensure'), null, 'no pair code while off');
    const info = await invoke('remoteAccessInfo', true);
    assert.equal(info.enabled, false);
    assert.deepEqual(
      info.relay.clients,
      [{ id: 'c1', name: 'Phone', platform: '', browser: '', createdAt: 0, lastSeenAt: 0, online: false }],
      'paired devices are kept and listed'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, before, 'no reconnect while off');
    assert.equal(
      frames.some((frame) => frame.type === 'pair-code-request'),
      false
    );

    const renamed = await invoke('remoteAccessSetName', 'Studio');
    assert.equal(renamed.name, 'Studio');
    assert.equal((await invoke('remoteAccessSettings')).name, 'Studio');

    const on = await invoke('remoteAccessSetEnabled', true);
    assert.equal(on.enabled, true);
    await wait(() => open.size === 1);
    await wait(() => frames.some((frame) => frame.type === 'desktop-name' && frame.name === 'Studio'));
  } finally {
    await service?.dispose();
    for (const socket of open) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previousUrl;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('the paired-device list survives a restart while off, and a revoke made while off applies on enable', async () => {
  const f = await viewSyncHost();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  const phone = {
    id: 'a'.repeat(32),
    name: 'Phone',
    platform: 'iOS',
    browser: 'Safari',
    createdAt: 5,
    lastSeenAt: 9,
    online: true,
  };
  const tablet = { ...phone, id: 'b'.repeat(32), name: 'Tablet' };
  const open = new Set();
  const frames = [];
  server.on('connection', (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === 'list-clients') {
        socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients: [phone, tablet] }));
      } else if (frame.type === 'revoke-client') {
        socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: true }));
      }
    });
  });
  const services = [];
  const start = async () => {
    const service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({}) },
      emit: () => {},
    });
    services.push(service);
    return (operation, ...args) => service.invoke('invokeDesktopOperation', [operation, args]);
  };
  try {
    await activateRemote(f.options.userDataPath);
    let invoke = await start();
    await invoke('remoteAccessStart');
    await wait(() => open.size === 1);
    assert.equal((await invoke('remoteAccessInfo', true)).relay.clients.length, 2);
    await invoke('remoteAccessSetEnabled', false);
    await services.pop().dispose();

    invoke = await start();
    const info = await invoke('remoteAccessInfo', true);
    assert.equal(info.enabled, false);
    assert.deepEqual(
      info.relay.clients.map((client) => [client.id, client.name, client.online]),
      [
        [phone.id, 'Phone', false],
        [tablet.id, 'Tablet', false],
      ],
      'the stored list is served offline after a restart'
    );
    const afterRevoke = await invoke('remoteAccessRevokeClient', phone.id);
    assert.deepEqual(
      afterRevoke.relay.clients.map((client) => [client.id, client.pendingRemoval === true]),
      [
        [phone.id, true],
        [tablet.id, false],
      ],
      'an offline revoke stays listed as pending until the relay acknowledges it'
    );
    assert.equal(
      frames.some((frame) => frame.type === 'revoke-client'),
      false,
      'nothing sent while off'
    );
    await services.pop().dispose();

    invoke = await start();
    assert.deepEqual(
      (await invoke('remoteAccessInfo', true)).relay.clients.map((client) => [client.id, client.pendingRemoval === true]),
      [
        [phone.id, true],
        [tablet.id, false],
      ],
      'the pending revoke survives a restart'
    );
    await invoke('remoteAccessSetEnabled', true);
    await wait(() => frames.some((frame) => frame.type === 'revoke-client' && frame.clientId === phone.id));
    const on = await invoke('remoteAccessInfo', true);
    assert.equal(on.enabled, true);
  } finally {
    for (const service of services) await service.dispose();
    for (const socket of open) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previousUrl;
    await rm(f.directory, { recursive: true, force: true });
  }
});
