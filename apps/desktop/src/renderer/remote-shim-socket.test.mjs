import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptRelayE2EEClientHello, createRelayE2EEChallenge } from '../shared/remote-e2ee.ts';
import { FakeSocket, settle, until, withShim } from './remote-shim-test-harness.mjs';

/** Open one socket attempt and stop before any challenge: the joining phone. */
async function joiningSocket(ctx) {
  const known = FakeSocket.instances.length;
  const connecting = ctx.connect();
  connecting.catch(() => {});
  await until(() => FakeSocket.instances.length === known + 1, 'a socket attempt');
  const ws = FakeSocket.instances[known];
  ws.readyState = FakeSocket.OPEN;
  ws.onopen();
  return { ws, connecting };
}

test('a joining phone answers a replaced PC leg challenge on the same socket and becomes ready', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    const { ws, connecting } = await joiningSocket(ctx);
    // The first PC leg challenges; the phone answers and holds a channel.
    ws.onmessage({ data: JSON.stringify(createRelayE2EEChallenge()) });
    await until(() => ws.sent.length === 1, 'the first hello');
    await until(() => ctx.secureChannel !== null, 'the first channel');
    // That leg died before its ready; the relay kept this socket and the
    // replacement leg sends its own challenge.
    const second = createRelayE2EEChallenge();
    ws.onmessage({ data: JSON.stringify(second) });
    await until(() => ws.sent.length === 2, 'a hello for the replacement leg');
    const server = await acceptRelayE2EEClientHello(identity, second, JSON.parse(ws.sent[1]));
    ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1 }) });
    assert.equal(await connecting, ws);
    assert.equal(ctx.connectionReady, true);
    assert.equal(ws.closeCalls, 0, 'the joining phone kept its socket');
  });
});

test('handshake restarts on one joining socket are bounded', async () => {
  await withShim({}, async ({ ctx }) => {
    const { ws } = await joiningSocket(ctx);
    for (let challenge = 1; challenge <= 3; challenge++) {
      ws.onmessage({ data: JSON.stringify(createRelayE2EEChallenge()) });
      await until(() => ws.sent.length === challenge, `hello ${challenge}`);
    }
    assert.equal(ws.closeCalls, 0, 'two restarts are answered');
    ws.onmessage({ data: JSON.stringify(createRelayE2EEChallenge()) });
    await until(() => ws.closeCalls === 1, 'a looping relay ends this attempt');
    assert.equal(ws.sent.length, 3, 'no hello for a challenge past the bound');
  });
});

test('a socket constructor that throws does not pin connect() to a rejected attempt', async () => {
  await withShim({ secure: false }, async ({ ctx }) => {
    let reconnects = 0;
    ctx.scheduleReconnect = () => {
      reconnects += 1;
    };
    const Real = globalThis.WebSocket;
    class Throwing extends Real {
      constructor() {
        throw new SyntaxError('invalid url');
      }
    }
    globalThis.WebSocket = Throwing;
    await assert.rejects(ctx.connect(), /invalid url/);
    await settle();
    assert.equal(ctx.openPromise, null, 'the failed attempt is released');
    assert.equal(reconnects, 1, 'a retry is scheduled');
    globalThis.WebSocket = Real;
    const known = FakeSocket.instances.length;
    const connecting = ctx.connect();
    await until(() => FakeSocket.instances.length === known + 1, 'a fresh socket attempt');
    const ws = FakeSocket.instances[known];
    ws.readyState = FakeSocket.OPEN;
    ws.onopen();
    await connecting;
  });
});

const { encodeRemoteTransportRecord } = await import('../shared/remote-transport.ts');

/** Hand-drives one handshake: `seen` is the challenge as the relay shows it,
 *  `offered` the one the PC issued. Returns the leg and the PC's channel. */
async function handshake(ctx, identity, { offered, seen = offered }) {
  ctx.transportOptIn = true;
  ctx.createTransportMedia ??= () => ({ attach() {}, receive: () => false, close() {} });
  const { ws, connecting } = await joiningSocket(ctx);
  ws.bufferedAmount = 0;
  ws.onmessage({ data: JSON.stringify(seen) });
  await until(() => ws.sent.length === 1, 'the hello');
  const hello = JSON.parse(ws.sent[0]);
  const server = await acceptRelayE2EEClientHello(identity, offered, hello);
  return { ws, connecting, hello, server };
}
const record = async (server, payload) => encodeRemoteTransportRecord(await server.encryptBinary(payload))[0].slice().buffer;

test('the hello carries its extra members through helloFields; the gate keeps it legacy', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    const { ws } = await joiningSocket(ctx);
    const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
    ws.onmessage({ data: JSON.stringify(offered) });
    await until(() => ws.sent.length === 1, 'the hello');
    const hello = JSON.parse(ws.sent[0]);
    assert.equal(hello.viewSync, 1);
    assert.equal(hello.promptHistoryPatch, 2);
    assert.equal(hello.transportWebrtc, undefined, 'the switch is off');
    const server = await acceptRelayE2EEClientHello(identity, offered, hello);
    assert.equal(server.transportEnabled, false);
  });
});

test('opted in: a confirmed transport session opens on its first record', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
    const { ws, connecting, hello, server } = await handshake(ctx, identity, { offered });
    assert.equal(hello.transportWebrtc, 1);
    assert.equal(hello.viewSync, 1, 'covered by the transcript the PC just verified');
    ws.onmessage({ data: await record(server, { type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() }) });
    assert.equal(await connecting, ws);
    assert.equal(ctx.connectionReady, true);
    assert.ok(ctx.transport);
  });
});

for (const [name, ready] of [
  ['missing', () => ({})],
  ['altered', () => ({ transcript: 'A'.repeat(43) })],
]) {
  test(`opted in: a ${name} confirmation sends nothing and ends the session`, async () => {
    await withShim({}, async ({ ctx, identity }) => {
      const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
      const { ws } = await handshake(ctx, identity, { offered });
      const server = await acceptRelayE2EEClientHello(identity, offered, JSON.parse(ws.sent[0]));
      ws.onmessage({ data: await record(server, { type: 'e2ee-ready', version: 1, ...ready() }) });
      await until(() => ws.closeCalls === 1, 'the session ends');
      assert.equal(ws.sent.length, 1, 'only the hello ever left');
      assert.equal(ctx.connectionReady, false);
    });
  });
}

test('opted in: a stripped offer is refused, an older host takes the explicit legacy path', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
    const seen = { ...offered };
    delete seen.transportWebrtc;
    const { ws, server } = await handshake(ctx, identity, { offered, seen });
    ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() }) });
    await until(() => ws.closeCalls === 1, 'the downgrade is refused');
    assert.equal(ws.sent.length, 1);
  });
  await withShim({}, async ({ ctx, identity }) => {
    const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1 };
    const { ws, connecting, hello, server } = await handshake(ctx, identity, { offered });
    assert.equal(hello.transportWebrtc, undefined);
    ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1 }) });
    assert.equal(await connecting, ws);
    assert.equal(ctx.transport, null);
  });
});

/** A fake media client per transport session, recording what reaches it. */
function fakeMedia(ctx) {
  const clients = [];
  ctx.createTransportMedia = (deps) => {
    const client = {
      deps,
      events: [],
      attach: (sid) => client.events.push(['attach', sid, ctx.connectionReady]),
      receive: (payload) => {
        client.events.push(['receive', payload.type ?? payload.event]);
        return payload.type === 'transport-media';
      },
      close: () => client.events.push(['close']),
    };
    clients.push(client);
    return client;
  };
  return clients;
}

test('media client: one per transport session, attached after the confirmation under the media sid, fed first', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    ctx.serverBase = 'https://relay.example';
    const clients = fakeMedia(ctx);
    const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1, mediaE2ee: 1 };
    const { ws, connecting, server } = await handshake(ctx, identity, { offered });
    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].events, [], 'nothing before the confirmation');
    ws.onmessage({ data: await record(server, { type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() }) });
    await connecting;
    assert.deepEqual(clients[0].events, [['attach', offered.challenge, false]], 'attached once confirmed, before the session opened');
    assert.equal(ctx.mediaSid, offered.challenge);
    // Routing: a media message is consumed; anything else reaches the handler after it.
    const handled = [];
    ctx.handleMessage = (message) => handled.push(message.event);
    ws.onmessage({ data: await record(server, { type: 'transport-media', op: 'end', id: 'm1' }) });
    ws.onmessage({ data: await record(server, { event: 'state' }) });
    await until(() => handled.length === 1, 'the plain message');
    assert.deepEqual(clients[0].events.slice(1), [['receive', 'transport-media'], ['receive', 'state']]);
    assert.deepEqual(handled, ['state']);
    // The client's sends take the stream (sealed records on the relay socket).
    const before = ws.sent.length;
    await clients[0].deps.send({ type: 'transport-media', op: 'cancel', id: 'm1' });
    assert.ok(ws.sent.length > before);
    // Replacement: a new challenge closes it; a new session gets its own.
    ws.onmessage({ data: JSON.stringify({ ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 }) });
    await until(() => clients.length === 2, 'the replacement session');
    assert.deepEqual(clients[0].events.at(-1), ['close']);
    // Session end closes the current one.
    ws.onclose({ code: 1006 });
    assert.deepEqual(clients[1].events.at(-1), ['close']);
    assert.equal(ctx.transportMedia, null);
  });
});

test('media client: none while the switch is off', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    const clients = fakeMedia(ctx);
    const { ws } = await joiningSocket(ctx);
    const offered = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1, mediaE2ee: 1 };
    ctx.serverBase = 'https://relay.example';
    ws.onmessage({ data: JSON.stringify(offered) });
    await until(() => ws.sent.length === 1, 'the hello');
    const server = await acceptRelayE2EEClientHello(identity, offered, JSON.parse(ws.sent[0]));
    ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() }) });
    await until(() => ctx.connectionReady, 'the legacy session');
    assert.equal(clients.length, 0);
    assert.equal(ctx.transportMedia ?? null, null);
  });
});

test('a call that finds its socket mid-rekey fails as interrupted and leaves the socket open', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const leg = await dial();
    // The desktop redialed: the relay kept this browser socket and sent a new
    // challenge, so it is open but not ready while the new channel is built.
    ctx.connectionReady = false;
    const failure = await ctx.invoke('abortSession', ['s1']).catch((error) => error);
    assert.equal(failure.code, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED');
    assert.equal(leg.ws.closeCalls, 0, 'the recovering socket is not closed by a call that never sent');
    assert.equal(ctx.pending.size, 0);
  });
});
