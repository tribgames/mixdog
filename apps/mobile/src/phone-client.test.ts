// Fold parity (lifecycle-remote §9 test 6): the phone client over the E2EE relay connector — on the plain relay lane and on the
// upgraded MXT transport — folds a thread exactly as the same client does over the mock transport the conformance suite uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  connect,
  MockNetwork,
  sessionReducer,
  sessionStateOf,
  type ProtocolClient,
  type SessionFold,
} from '../../../packages/protocol-client/src/index.ts';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
  type RelayE2EEChannel,
} from '../../desktop/src/shared/remote-e2ee.ts';
import {
  decodeRemoteTransportMessage,
  encodeRemoteTransportRecord,
  RemoteTransportAssemblyPool,
  RemoteTransportMessageAssembler,
  RemoteTransportReceiver,
  RemoteTransportSender,
  splitRemoteTransportPayload,
} from '../../desktop/src/shared/remote-transport.ts';
import { connectPhone } from './phone-client.ts';
import type { PhoneConnection } from './phone-status.ts';
import type { RelaySocket } from './relay-connector.ts';

const conformance = new URL('../../../packages/protocol-client/conformance/', import.meta.url);
const options = JSON.parse(readFileSync(new URL('options.json', conformance), 'utf8'));

const thread = { id: 't1', preview: '', title: 'T', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null };
const feed = (seq: number) => ({ id: 't1', epoch: 'e1', seq });
const message = (seq: number, id: string, type: string, extra: object) => ({
  method: 'item/completed',
  params: { item: { type, id, ...extra } },
  feed: feed(seq),
});

/** The core's side of one connection: initialize, then a thread resume with a snapshot and two items. */
async function serve(next: () => Promise<any>, send: (frame: unknown) => Promise<void> | void): Promise<void> {
  const init = await next();
  assert.equal(init.method, 'initialize');
  await send({ id: init.id, result: options.initializeResult });
  assert.equal((await next()).method, 'initialized');
  const resume = await next();
  assert.equal(resume.method, 'thread/resume');
  await send({ id: resume.id, result: { thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 11 } } });
  await send({ method: 'thread/snapshot', params: { thread, items: [], state: { title: 'T' } }, feed: feed(10) });
  await send(message(11, 'u1', 'userMessage', { content: [{ type: 'text', text: 'hello' }] }));
  await send(message(12, 'a1', 'agentMessage', { text: 'hi there' }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

type Identity = Awaited<ReturnType<typeof generateRelayE2EEServerIdentity>>;

/** A relay socket whose far end is the desktop leg: it challenges, verifies the hello, sends `e2ee-ready`. With `transport` it
 *  offers the MXT transport and speaks records both ways, as the core's carrier does over the relay lane. */
function relayPair(identity: Identity, transport: boolean) {
  const inbox: any[] = [];
  let waiter: ((v: any) => void) | undefined;
  let server: RelayE2EEChannel | undefined;
  const challenge = { ...createRelayE2EEChallenge(), ...(transport ? { binaryFrames: 1 as const, transportWebrtc: 1 as const } : {}) };
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  const assembler = new RemoteTransportMessageAssembler(new RemoteTransportAssemblyPool());
  let fragment = 0;
  const closes: Array<[number, string]> = [];
  const hellos: any[] = [];
  const push = (value: any) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(value);
    } else inbox.push(value);
  };
  const toPhone = async (value: unknown) => {
    if (!transport) {
      ws.onmessage!({ data: await server!.encryptJson(value) });
      return;
    }
    for (const part of splitRemoteTransportPayload(value as never, ++fragment)) {
      const box = await server!.encryptBinary(part);
      sender.push(box);
      for (const record of encodeRemoteTransportRecord(box)) {
        ws.onmessage!({ data: record.buffer.slice(record.byteOffset, record.byteOffset + record.byteLength) });
      }
    }
  };
  const fromPhone = async (data: string | Uint8Array) => {
    if (!server) {
      const hello = JSON.parse(String(data));
      hellos.push(hello);
      server = await acceptRelayE2EEClientHello(identity, challenge, hello);
      await toPhone({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() });
      return;
    }
    if (!transport) return push(await server.decryptJson(JSON.parse(String(data))));
    const decoded = decodeRemoteTransportMessage(data);
    if (decoded.kind === 'control') return;
    receiver.accept(decoded, 0);
    for (let next = receiver.next(); next; next = receiver.next()) {
      const value = await server.decryptJson(next.box);
      receiver.commit(next.sequence, 0);
      const result = assembler.accept(value, 0);
      if (result.state === 'complete') push(result.payload);
    }
  };
  const ws: RelaySocket = {
    binaryType: '',
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => void fromPhone(data),
    close: (code = 1000, reason = '') => closes.push([code, reason]),
  };
  const start = () =>
    queueMicrotask(() => {
      ws.onopen?.();
      ws.onmessage!({ data: JSON.stringify(challenge) });
    });
  return {
    ws,
    start,
    closes,
    hellos,
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise<any>((r) => (waiter = r))),
    send: toPhone,
  };
}

async function referenceState(): Promise<{ client: ProtocolClient<SessionFold>; state: unknown }> {
  const net = new MockNetwork();
  const pending = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0.5,
    newOpId: () => 'op',
  });
  const conn = await net.accept();
  const served = serve(async () => JSON.parse(await conn.nextSent()), (f) => conn.serverSend(f));
  const client = await pending;
  const resumed = client.resumeThread('t1', { lastItems: 50 });
  await served;
  await resumed;
  await settle();
  return { client, state: sessionStateOf(client, 't1') };
}

for (const transport of [false, true]) {
  test(`phone client folds a thread like the plain transport (${transport ? 'MXT transport' : 'relay lane'})`, async () => {
    const reference = await referenceState();
    const identity = await generateRelayE2EEServerIdentity();
    const far = relayPair(identity, transport);
    const states: PhoneConnection[] = [];
    const served = serve(far.next, far.send);
    far.start();
    const phone = await connectPhone({
      deviceId: 'dev',
      version: options.clientInfo.version,
      pairing: () => relayE2EEPairingMaterial(identity),
      socketUrl: () => 'wss://relay.invalid/d/dev',
      createSocket: () => far.ws,
      webrtc: {
        createPeer: () => {
          throw new Error('no direct path in this test');
        },
        visible: () => true,
        log: () => {},
      },
      random: () => 0.5,
      onConnection: (c) => states.push(c),
    });
    const resumed = phone.client.resumeThread('t1', { lastItems: 50 });
    await served;
    await resumed;
    await settle();

    assert.equal(far.hellos[0].transportWebrtc, transport ? 1 : undefined);
    const state = sessionStateOf(phone.client, 't1') as { items: unknown[] };
    assert.deepEqual(state, reference.state);
    assert.equal(state.items.length, 2);
    assert.deepEqual(states.map((s) => s.state), ['connecting', 'connected']);
    await phone.client.close();
    await reference.client.close();
  });
}

test('a revoked pairing is terminal: reported, closed, no retry', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const states: PhoneConnection[] = [];
  const result = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: (c) => states.push(c),
  });
  queueMicrotask(() => far.ws.onclose!({ code: 4003, reason: 'revoked' }));
  await assert.rejects(result);
  assert.deepEqual(states.map((s) => s.state), ['connecting', 'pairing-lost']);
});

test('a close 4002 is the relay saying the PC is offline: reconnecting, never a terminal state', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const states: PhoneConnection[] = [];
  const served = serve(far.next, far.send);
  far.start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: (c) => states.push(c),
  });
  const resumed = phone.client.resumeThread('t1', { lastItems: 50 });
  await served;
  await resumed;
  far.ws.onclose!({ code: 4002, reason: 'version' });
  await settle();
  assert.deepEqual(states.map((s) => s.state), ['connecting', 'connected', 'reconnecting']);
  assert.equal(phone.client.status.state, 'reconnecting');
  await phone.client.close();
});

test('a frame still sealing when its socket ends never settles its claim; the next connection\'s frame settles its own', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const legs = [relayPair(identity, false), relayPair(identity, false)];
  let made = 0;
  const served = [serve(legs[0].next, legs[0].send), serve(legs[1].next, legs[1].send)];
  legs[0].start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      const leg = legs[made++];
      if (made === 2) leg.start();
      return leg.ws;
    },
    random: () => 0,
    onConnection: () => undefined,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served[0]]);

  // The next encryption on this page (the phone's frame; the test's far end is idle) waits until released: the frame is being sealed.
  const subtle = globalThis.crypto.subtle;
  const original = subtle.encrypt.bind(subtle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let sealed: Promise<unknown> = Promise.resolve();
  let holdNext = true;
  let sealing!: () => void;
  const sealStarted = new Promise<void>((resolve) => (sealing = resolve));
  Object.defineProperty(subtle, 'encrypt', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof original>) => {
      if (!holdNext) return original(...args);
      holdNext = false;
      sealing();
      return (sealed = gate.then(() => original(...args)));
    },
  });
  try {
    const states = new Promise<void>((resolve) => {
      const off = phone.client.on((event) => {
        if (event.type === 'status' && event.status.state === 'reconnecting') (off(), resolve());
      });
    });
    // The claim receives a promise; wrapped, so resolving the test's own promise does not wait for it.
    const dead = new Promise<{ sent: Promise<void> }>((resolve) => {
      void phone.client.call('thread/list', {} as never, { sent: (sent) => resolve({ sent }) }).catch(() => undefined);
    });
    const deadFrame = (await dead).sent;
    let deadSettled = false;
    void deadFrame.then(() => (deadSettled = true));
    // The frame is mid-seal, not merely queued: only then does the socket end.
    await sealStarted;
    legs[0].ws.onclose!({ code: 1006, reason: '' });
    await states;
    release();
    await sealed;
    // One macrotask: everything the sealing's continuation queued has run, so a settle that was going to happen has happened.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deadSettled, false, 'the dead leg\'s frame never leaves, so its claim never settles');

    await served[1];
    const live = new Promise<{ sent: Promise<void> }>((resolve) => {
      void phone.client.call('thread/list', {} as never, { sent: (sent) => resolve({ sent }) }).catch(() => undefined);
    });
    await (await live).sent;
  } finally {
    Object.defineProperty(subtle, 'encrypt', { configurable: true, writable: true, value: original });
    await phone.client.close();
  }
});