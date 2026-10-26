import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { createIceService, requestIceServers } from '../../../relay/lib/ice-legs.mjs';
import { turnConfigFromEnv } from '../../../relay/lib/turn-credentials.mjs';
import { createDesktopService } from './desktop-service.ts';
import { activateRemote } from './remote-activation.ts';
import { resolveRemoteIceServers } from './remote-ice-servers.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasTurn = (list) => list.some((server) => server.username);

/** The relay's own handler answering a paired device, so the desktop reads real wire frames. */
function relayAnswer(requestId) {
  const sent = [];
  requestIceServers(
    {
      ice: createIceService(
        turnConfigFromEnv({
          TURN_AUTH_SECRET: 'e'.repeat(64),
          TURN_HOST: 'relay.example.com',
          TURN_ISSUE_LIMIT: '100',
        }),
        { log: () => {} }
      ),
      store: { listClients: () => [{ id: 'phone' }] },
      deviceId: 'device-a',
      socket: {},
      sendJson: (_socket, payload) => sent.push(payload),
    },
    { requestId }
  );
  return sent[0];
}

test('the OS suspend and resume operations drop the TURN credential, so the next connection asks again', async () => {
  const f = await viewSyncHost();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  let requests = 0;
  const open = new Set();
  server.on('connection', (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.send(JSON.stringify({ type: 'relay-capabilities', binaryFrames: 1, ice: 1 }));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'ice-servers-request') return;
      requests += 1;
      socket.send(JSON.stringify(relayAnswer(frame.requestId)));
    });
  });
  let service;
  try {
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
      emit: () => {},
    });
    const invoke = (operation, ...args) => service.invoke('invokeDesktopOperation', [operation, args]);
    await invoke('remoteAccessStart');
    await activateRemote(f.options.userDataPath);
    await invoke('remoteAccessStart');
    /** Until a list with TURN comes back: the relay leg and its capabilities have to arrive first. */
    const turnList = async () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const list = await resolveRemoteIceServers();
        if (hasTurn(list)) return list;
        await sleep(10);
      }
      throw new Error('no TURN servers resolved');
    };

    await turnList();
    assert.equal(requests, 1);
    await turnList();
    assert.equal(requests, 1, 'cached until told otherwise');

    await invoke('remoteAccessSuspend');
    await turnList();
    assert.equal(requests, 2, 'suspend dropped the credential');

    await invoke('remoteAccessResume');
    await turnList();
    assert.equal(requests, 3, 'resume dropped it again (and redialled the leg)');
  } finally {
    await service?.dispose();
    for (const socket of open) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previousUrl;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('suspend with no relay running is a no-op', async () => {
  const f = await viewSyncHost();
  let service;
  try {
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
      emit: () => {},
    });
    assert.equal(await service.invoke('invokeDesktopOperation', ['remoteAccessSuspend', []]), null);
  } finally {
    await service?.dispose();
    await rm(f.directory, { recursive: true, force: true });
  }
});
