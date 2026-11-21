import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteTransportMediaClient } from './remote-transport-media-client.ts';

const MEDIA_SID = 'M'.repeat(43);
const FRAME = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

/** A controlling worker stand-in: records what the page posts to it. */
function workerContainer() {
  const posted = [];
  const listeners = new Set();
  return {
    posted,
    listeners,
    controller: { postMessage: (data) => posted.push(data) },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
}

/** Collects what arrives on `port`. */
function inbox(port) {
  const items = [];
  port.onmessage = (event) => items.push(event.data);
  return items;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The worker asking the page for one window, as sw-media.js does. */
function askWindow(lanePort, fields = {}) {
  const reply = new MessageChannel();
  const answers = inbox(reply.port1);
  lanePort.postMessage(
    {
      op: 'request',
      assetId: 'aaaaaaaa-1111',
      variant: 'original',
      range: 'bytes=0-65535',
      enc: 'e2ee1',
      port: reply.port2,
      ...fields,
    },
    [reply.port2]
  );
  return { port: reply.port1, answers };
}

function attachedClient() {
  const container = workerContainer();
  const sent = [];
  const media = createRemoteTransportMediaClient({ send: (message) => sent.push(message), container });
  media.attach(MEDIA_SID);
  return { container, sent, media, port: container.posted[0].port };
}

test('the direct media client carries a worker window over the transport and its answer back unchanged', async () => {
  const container = workerContainer();
  const sent = [];
  const media = createRemoteTransportMediaClient({ send: (message) => sent.push(message), container });
  media.attach(MEDIA_SID);
  assert.equal(container.posted.length, 1);
  const { type, sid, port } = container.posted[0];
  assert.deepEqual([type, sid, port instanceof MessagePort], ['mixdog:media-transport', MEDIA_SID, true]);
  const window = askWindow(port);
  await settle();
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.deepEqual(
    { ...request, id: undefined },
    {
      type: 'transport-media',
      op: 'request',
      id: undefined,
      assetId: 'aaaaaaaa-1111',
      variant: 'original',
      range: 'bytes=0-65535',
      enc: 'e2ee1',
    }
  );
  const id = request.id;
  assert.equal(media.receive({ type: 'transport-media', op: 'head', id, status: 200 }), true);
  assert.equal(media.receive({ type: 'transport-media', op: 'chunk', id, frame: FRAME.toString('base64url') }), true);
  assert.equal(media.receive({ type: 'transport-media', op: 'end', id }), true);
  await settle();
  assert.deepEqual(
    window.answers.map((answer) => answer.op),
    ['head', 'chunk', 'end']
  );
  assert.equal(window.answers[0].status, 200);
  assert.deepEqual(Buffer.from(window.answers[1].frame), FRAME);
  assert.equal(media.receive({ type: 'transport-media', op: 'chunk', id, frame: FRAME.toString('base64url') }), true);
  assert.equal(media.receive({ type: 'rpc', id: 1 }), false);
  await settle();
  assert.equal(window.answers.length, 3);
  media.close();
  port.close();
});

test('a cancelled window cancels its stream and drops later answers for it', async () => {
  const { sent, media, port } = attachedClient();
  const window = askWindow(port);
  await settle();
  const { id } = sent[0];
  window.port.postMessage({ op: 'cancel' });
  await settle();
  assert.deepEqual(sent[1], { type: 'transport-media', op: 'cancel', id });
  media.receive({ type: 'transport-media', op: 'head', id, status: 200 });
  await settle();
  assert.deepEqual(window.answers, []);
  media.close();
  window.port.close();
  port.close();
});

test('a request the contract refuses goes back to the HTTP lane and never reaches the desktop', async () => {
  const { sent, media, port } = attachedClient();
  const odd = askWindow(port, { variant: 'not a token' });
  await settle();
  assert.deepEqual(odd.answers, [{ op: 'unavailable' }]);
  assert.equal(sent.length, 0);
  media.close();
  odd.port.close();
  port.close();
});

test('at most 32 windows run on the transport; the 33rd takes the HTTP lane', async () => {
  const { sent, media, port } = attachedClient();
  const open = Array.from({ length: 32 }, () => askWindow(port));
  const extra = askWindow(port);
  await settle();
  assert.deepEqual(extra.answers, [{ op: 'unavailable' }]);
  assert.equal(sent.length, 32);
  media.close();
  for (const item of [...open, extra]) item.port.close();
  port.close();
});

test('a send that fails before any head gives the window back to the HTTP lane', async () => {
  const container = workerContainer();
  const media = createRemoteTransportMediaClient({
    send: () => Promise.reject(new Error('session closed')),
    container,
  });
  media.attach(MEDIA_SID);
  const lost = askWindow(container.posted[0].port);
  await settle();
  assert.deepEqual(lost.answers, [{ op: 'unavailable' }]);
  media.close();
  lost.port.close();
  container.posted[0].port.close();
});

test('closing the transport fails answered windows, returns the rest, and withdraws the port', async () => {
  const { container, sent, media, port } = attachedClient();
  const answered = askWindow(port);
  const waiting = askWindow(port);
  await settle();
  media.receive({ type: 'transport-media', op: 'head', id: sent[0].id, status: 200 });
  media.close();
  await settle();
  assert.deepEqual(
    answered.answers.map((answer) => answer.op),
    ['head', 'error']
  );
  assert.deepEqual(waiting.answers, [{ op: 'unavailable' }]);
  assert.deepEqual(container.posted.at(-1), { type: 'mixdog:media-transport', sid: MEDIA_SID, port: null });
  assert.equal(container.listeners.size, 0);
  const late = askWindow(port);
  await settle();
  assert.deepEqual(late.answers, [{ op: 'unavailable' }]);
  assert.equal(sent.length, 2);
  for (const item of [answered, waiting, late]) item.port.close();
  port.close();
});

test('a restarted worker asking for the session key gets the transport port again', async () => {
  const container = workerContainer();
  const media = createRemoteTransportMediaClient({ send: () => undefined, container });
  media.attach(MEDIA_SID);
  const ask = (sid) => {
    for (const listener of container.listeners) listener({ data: { type: 'mixdog:media-key-request', sid } });
  };
  ask('O'.repeat(43));
  assert.equal(container.posted.length, 1);
  ask(MEDIA_SID);
  assert.equal(container.posted.length, 2);
  assert.notEqual(container.posted[1].port, container.posted[0].port);
  media.close();
  for (const posted of container.posted) posted.port?.close();
});

test('without a controlling worker there is nobody to hand a port to', () => {
  const container = { ...workerContainer(), controller: null };
  const none = createRemoteTransportMediaClient({ send: () => undefined, container });
  none.attach(MEDIA_SID);
  assert.equal(container.posted.length, 0);
  none.close();
});
