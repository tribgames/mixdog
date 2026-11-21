// Fold (lifecycle-remote §9 test 6): the phone client over the E2EE relay connector — on the plain relay lane and on the
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

const thread = {
  id: 't1',
  preview: '',
  title: 'T',
  updatedAt: 1,
  messageCount: 0,
  cwd: '/w',
  classification: {},
  projectPath: null,
};
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
  await send({
    id: resume.id,
    result: { thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 11 } },
  });
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
  const challenge = {
    ...createRelayE2EEChallenge(),
    ...(transport ? { binaryFrames: 1 as const, transportWebrtc: 1 as const } : {}),
  };
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
  const served = serve(
    async () => JSON.parse(await conn.nextSent()),
    (f) => conn.serverSend(f)
  );
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
    assert.deepEqual(
      states.map((s) => s.state),
      ['connecting', 'connected']
    );
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
  assert.deepEqual(
    states.map((s) => s.state),
    ['connecting', 'pairing-lost']
  );
});

test('initialize refusal preserves which side is out of date without retrying', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  for (const reason of ['clientOutdated', 'serverOutdated'] as const) {
    const far = relayPair(identity, false);
    const states: PhoneConnection[] = [];
    const result = connectPhone({
      deviceId: 'dev',
      version: '2.0.0',
      pairing: () => relayE2EEPairingMaterial(identity),
      socketUrl: () => 'wss://relay.invalid/d/dev',
      createSocket: () => far.ws,
      onConnection: (state) => states.push(state),
    });
    const rejected = assert.rejects(result, { message: 'versionRefused' });
    far.start();
    const init = await far.next();
    assert.equal(init.method, 'initialize');
    await far.send({
      id: init.id,
      error: {
        code: -32600,
        message: 'Version refused',
        data: { reason, clientVersion: '2.0.0', serverVersion: reason === 'clientOutdated' ? '3.0.0' : '1.0.0' },
      },
    });
    await rejected;
    assert.deepEqual(states, [{ state: 'connecting' }, { state: 'update-required', reason }]);
  }
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
  assert.deepEqual(
    states.map((s) => s.state),
    ['connecting', 'connected', 'reconnecting']
  );
  assert.equal(phone.client.status.state, 'reconnecting');
  await phone.client.close();
});

test("a frame still sealing when its socket ends rejects its claim; the next connection's frame settles its own", async () => {
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
      sealed = gate.then(() => original(...args));
      return sealed;
    },
  });
  try {
    const states = new Promise<void>((resolve) => {
      const off = phone.client.on((event) => {
        if (event.type === 'status' && event.status.state === 'reconnecting') {
          off();
          resolve();
        }
      });
    });
    // The claim receives a promise; wrapped, so resolving the test's own promise does not wait for it.
    const dead = new Promise<{ sent: Promise<void> }>((resolve) => {
      void phone.client.call('thread/list', {} as never, { sent: (sent) => resolve({ sent }) }).catch(() => undefined);
    });
    const deadFrame = (await dead).sent;
    let deadSettled: 'left' | 'rejected' | null = null;
    deadFrame.then(
      () => (deadSettled = 'left'),
      () => (deadSettled = 'rejected')
    );
    // The frame is mid-seal, not merely queued: only then does the socket end.
    await sealStarted;
    legs[0].ws.onclose!({ code: 1006, reason: '' });
    await states;
    release();
    await sealed;
    // One macrotask: everything the sealing's continuation queued has run, so a settle that was going to happen has happened.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      deadSettled,
      'rejected',
      "the dead leg's frame never leaves, so its claim is rejected, never left pending or resolved"
    );

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
/** A socket the relay refuses at once (the PC is offline): its dial ends before ready. */
const refusedSocket = (): RelaySocket => {
  const ws: RelaySocket = {
    binaryType: '',
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
  queueMicrotask(() => ws.onclose!({ code: 4002, reason: 'offline' }));
  return ws;
};

test('a wake before the first connection cuts the redial wait short', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  let made = 0;
  let link: { wake(): boolean } | undefined;
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      made++;
      return refusedSocket();
    },
    signal: controller.signal,
    random: () => 0.5,
    onConnection: () => undefined,
    linked: (l) => {
      link = l;
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(made, 2, 'the next dial is waiting out a backoff of hundreds of ms');
  link!.wake();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(made >= 3, 'the wake released the wait');
  controller.abort();
  await assert.rejects(pending);
});

test('a hidden page does not redial; the wake that brings it back does', async () => {
  let visible = false;
  let made = 0;
  let link: { wake(): boolean } | undefined;
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      made++;
      return refusedSocket();
    },
    visible: () => visible,
    random: () => 0,
    signal: controller.signal,
    onConnection: () => undefined,
    linked: (l) => {
      link = l;
    },
  });
  pending.catch(() => undefined);
  await settle();
  assert.equal(made, 0, 'a hidden page opens no socket');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(made, 0);
  visible = true;
  link!.wake();
  await settle();
  assert.ok(made >= 1, 'the foreground wake dials');
  controller.abort();
  visible = false;
});

test('a fatal transport error closes the socket with a status code a browser accepts', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  const closed: unknown[][] = [];
  let firstClose!: () => void;
  const closedOnce = new Promise<void>((resolve) => {
    firstClose = resolve;
  });
  // A browser WebSocket: close(1002) throws and leaves the socket open.
  far.ws.close = (...args: unknown[]) => {
    closed.push(args);
    firstClose();
    if (args[0] === 1002) throw new Error('InvalidAccessError');
  };
  far.ws.send = () => {
    throw new Error('send failed');
  };
  try {
    void phone.client.call('thread/list', {}).catch(() => undefined);
    // Sealing the frame runs on the crypto thread pool, so its failure lands after a time no tick count bounds.
    await closedOnce;
    assert.deepEqual(closed[0], [4000, 'frame failed'], 'closed with a code a browser accepts, naming why');
  } finally {
    await phone.client.close();
  }
});

test('a relay frame-too-large notice reaches the page with its size and ceiling', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const hints: Array<Record<string, unknown>> = [];
  let hinted!: () => void;
  const hintedOnce = new Promise<void>((resolve) => {
    hinted = resolve;
  });
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
    resyncHint: (word) => {
      hints.push({ ...word });
      hinted();
    },
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({
    data: JSON.stringify({ resync: 1, error: 'frame-too-large', bytes: 2_000_000, limit: 1_000_000 }),
  });
  // The notice queues behind frames still decrypting on the crypto thread pool, so no tick count bounds its arrival.
  await hintedOnce;
  assert.deepEqual(hints, [{ resync: 1, error: 'frame-too-large', bytes: 2_000_000, limit: 1_000_000 }]);
  await phone.client.close();
});

test('a redial timer that fires after the page was hidden waits for the wake', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  let visible = true;
  let made = 0;
  let link: { wake(): boolean } | undefined;
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      made++;
      return refusedSocket();
    },
    visible: () => visible,
    random: () => 0,
    signal: controller.signal,
    onConnection: () => undefined,
    linked: (l) => {
      link = l;
    },
  });
  pending.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
  const dialed = made;
  assert.ok(dialed >= 1);
  visible = false;
  await new Promise((r) => setTimeout(r, 1_700));
  assert.equal(made, dialed, 'the armed backoff fired while hidden and dialed nothing');
  const parkedAt = made;
  visible = true;
  link!.wake();
  await settle();
  assert.ok(made > parkedAt, 'the wake dials');
  controller.abort();
});

test('aborting the first connection ends a redial wait', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => refusedSocket(),
    visible: () => false,
    random: () => 0,
    signal: controller.signal,
    onConnection: () => undefined,
  });
  await new Promise((r) => setTimeout(r, 30));
  controller.abort();
  await assert.rejects(pending);
});

test('a wake does not probe a socket that is still opening', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const sent: unknown[] = [];
  const closed: unknown[] = [];
  const ws: RelaySocket = {
    binaryType: '',
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (d) => void sent.push(d),
    close: (...a: unknown[]) => void closed.push(a),
  };
  let link: { wake(): boolean } | undefined;
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => ws,
    signal: controller.signal,
    onConnection: () => undefined,
    linked: (l) => {
      link = l;
    },
  });
  pending.catch(() => undefined);
  await settle();
  assert.equal(link!.wake(), false, 'nothing to probe yet');
  assert.deepEqual(sent, []);
  assert.deepEqual(closed, []);
  controller.abort();
  ws.onclose!({ code: 1000, reason: '' });
});

test('a socket parked on desktop-gone is closed by a suspension', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({ data: JSON.stringify({ resync: 'desktop-gone' }) });
  await settle();
  phone.link.suspend();
  await settle();
  assert.deepEqual(far.closes.at(-1), [1000, 'background']);
  await phone.client.close();
});

test('a socket this page ends for a reason of its own tells the relay that reason', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({ data: 'not a frame' });
  await settle();
  assert.deepEqual(far.closes.at(0), [4000, 'frame failed']);
  await phone.client.close();
});

test('the relay reads only the category of a close, never the feed or the error behind it', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  // Seq 20 after 12: a feed gap, which the library names with the feed's id.
  await far.send(message(20, 'a2', 'agentMessage', { text: 'later' }));
  await settle();
  assert.deepEqual(far.closes.at(0), [4000, 'feed gap']);
  await phone.client.close();
});

test('an abort that already happened when a dial fails ends the attempt at once', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  let made = 0;
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      made++;
      controller.abort();
      return refusedSocket();
    },
    random: () => 0,
    signal: controller.signal,
    onConnection: () => undefined,
  });
  await assert.rejects(pending);
  assert.equal(made, 1);
});

test('the late close of a parked socket the connector no longer owns reports nothing', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const closes: number[] = [];
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
    onClose: (code) => void closes.push(code),
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({ data: JSON.stringify({ resync: 'desktop-gone' }) });
  await settle();
  const before = closes.length;
  phone.link.suspend();
  await settle();
  const afterSuspend = closes.length;
  far.ws.onclose!({ code: 1006, reason: 'late' });
  await settle();
  assert.equal(closes.length, afterSuspend, 'a socket no longer owned is silent');
  assert.ok(afterSuspend >= before);
  await phone.client.close();
});

test('an abort closes a socket parked on desktop-gone', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  const controller = new AbortController();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    signal: controller.signal,
    onConnection: () => undefined,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({ data: JSON.stringify({ resync: 'desktop-gone' }) });
  await settle();
  const before = far.closes.length;
  controller.abort();
  await settle();
  assert.equal(far.closes.length, before + 1, 'the parked socket was closed');
});
