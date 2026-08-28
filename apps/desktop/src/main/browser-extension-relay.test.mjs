import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createBrowserExtensionRelay } from './browser-extension-relay';

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function cdpCall(socket, id, method, params = {}, sessionId = '') {
  return new Promise((resolve, reject) => {
    const receive = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      socket.off('message', receive);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    }));
  });
}

test('Chrome extension relay authenticates both lanes and seals CDP to an allowed tab session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-extension-relay-'));
  const relay = createBrowserExtensionRelay({
    userDataDirectory: directory,
    extensionPath: join(directory, 'chrome-extension'),
    port: 0,
  });
  let extension;
  let internal;
  try {
    const internalEndpoint = await relay.internalWebSocketEndpoint();
    const pairing = relay.pairingInfo();
    assert.match(pairing.pairingToken, /^[a-f0-9]{64}$/);
    assert.equal(pairing.connected, false);

    extension = new WebSocket(
      `ws://127.0.0.1:${pairing.port}/extension?token=${pairing.pairingToken}`,
      { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    );
    await opened(extension);
    const requests = [];
    extension.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'request') return;
      requests.push(message);
      let result = {};
      if (message.action === 'listTargets') {
        result = {
          targetInfos: [{
            targetId: 'tab:7',
            type: 'page',
            title: 'Signed-in shop',
            url: 'https://shop.example.test/checkout',
          }],
        };
      }
      extension.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        result,
      }));
    });

    internal = new WebSocket(internalEndpoint);
    await opened(internal);
    const targets = await cdpCall(internal, 1, 'Target.getTargets');
    assert.equal(targets.targetInfos[0].targetId, 'tab:7');
    const attached = await cdpCall(internal, 2, 'Target.attachToTarget', {
      targetId: 'tab:7',
      flatten: true,
    });
    assert.match(attached.sessionId, /^mixdog-extension-/);
    await cdpCall(internal, 3, 'Page.enable', {}, attached.sessionId);
    assert.ok(requests.some((request) =>
      request.action === 'cdp'
      && request.targetId === 'tab:7'
      && request.method === 'Page.enable'));
    await assert.rejects(
      cdpCall(internal, 4, 'Runtime.enable', {}, 'other-session'),
      /session is no longer allowed/,
    );

    const event = new Promise((resolve) => {
      const receive = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method !== 'Page.loadEventFired') return;
        internal.off('message', receive);
        resolve(message);
      };
      internal.on('message', receive);
    });
    extension.send(JSON.stringify({
      type: 'event',
      targetId: 'tab:7',
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    }));
    assert.equal((await event).sessionId, attached.sessionId);

    const secondRelay = createBrowserExtensionRelay({
      userDataDirectory: directory,
      extensionPath: join(directory, 'chrome-extension'),
      port: 0,
    });
    assert.equal(secondRelay.pairingInfo().pairingToken, pairing.pairingToken);
  } finally {
    internal?.close();
    extension?.close();
    await relay.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Chrome extension relay rejects a browser page or unpaired client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-extension-relay-deny-'));
  const relay = createBrowserExtensionRelay({
    userDataDirectory: directory,
    extensionPath: join(directory, 'chrome-extension'),
    port: 0,
  });
  try {
    await relay.start();
    const pairing = relay.pairingInfo();
    const deniedOrigin = new WebSocket(
      `ws://127.0.0.1:${pairing.port}/extension?token=${pairing.pairingToken}`,
      { origin: 'https://attacker.example.test' },
    );
    const originStatus = await new Promise((resolve) => {
      deniedOrigin.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      deniedOrigin.once('error', () => resolve(0));
    });
    assert.equal(originStatus, 403);
    deniedOrigin.terminate();

    const deniedToken = new WebSocket(
      `ws://127.0.0.1:${pairing.port}/extension?token=${'0'.repeat(64)}`,
      { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    );
    const tokenStatus = await new Promise((resolve) => {
      deniedToken.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      deniedToken.once('error', () => resolve(0));
    });
    assert.equal(tokenStatus, 403);
    deniedToken.terminate();
  } finally {
    await relay.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
