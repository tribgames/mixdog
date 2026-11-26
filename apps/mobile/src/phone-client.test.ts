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
import { connectPhone, OFFLINE_LADDER_CAP_MS } from './phone-client.ts';
import { REMOTE_TOOL_OUTPUT_DISPLAY } from '../../desktop/src/shared/remote-tool-output-display.ts';
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

/** Resolves once `client` has folded thread `threadId` up to feed position `seq`. */
function foldedThrough(client: ProtocolClient<SessionFold>, threadId: string, seq: number): Promise<void> {
  return new Promise((resolve) => {
    const reached = () => (client.store.thread(threadId)?.feed.seq ?? -1) >= seq;
    if (reached()) return resolve();
    const off = client.store.subscribe(() => {
      if (!reached()) return;
      off();
      resolve();
    });
  });
}

/** `hear` passed as a callback; `happened` resolves at its first call whose arguments pass `passes`. */
function signal<A extends unknown[]>(passes: (...args: A) => boolean = () => true) {
  let resolve!: () => void;
  const happened = new Promise<void>((r) => (resolve = r));
  return {
    happened,
    hear: (...args: A) => {
      if (passes(...args)) resolve();
    },
  };
}

/** The `closed` code with which a ready session parks its socket on `desktop-gone` (relay-session.ts). */
const DESKTOP_LEG_GONE = 1012;

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
  let inbound: Promise<void> = Promise.resolve();
  const closes: Array<[number, string]> = [];
  const firstClose = signal();
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
    // One record at a time, as the carrier reads them: receiver.next() hands out the head box until it is committed.
    send: (data) => {
      inbound = inbound.then(() => fromPhone(data));
    },
    close: (code = 1000, reason = '') => {
      closes.push([code, reason]);
      firstClose.hear();
    },
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
    /** The phone's first close of this socket. */
    closed: firstClose.happened,
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
  await foldedThrough(client, 't1', 12);
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
    // `served` resolves once the last frame is handed to the socket; the phone still decrypts it on the crypto thread pool.
    await foldedThrough(phone.client, 't1', 12);

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
    assert.deepEqual(
      init.params.capabilities.toolOutput,
      REMOTE_TOOL_OUTPUT_DISPLAY,
      'the phone says what it shows of a tool output'
    );
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
  const reconnecting = signal((c: PhoneConnection) => c.state === 'reconnecting');
  const served = serve(far.next, far.send);
  far.start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: (c) => {
      states.push(c);
      reconnecting.hear(c);
    },
  });
  const resumed = phone.client.resumeThread('t1', { lastItems: 50 });
  await served;
  await resumed;
  far.ws.onclose!({ code: 4002, reason: 'version' });
  await reconnecting.happened;
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

test('each redial wait is announced with its length; an immediate retry is not', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  const waits: number[] = [];
  let made = 0;
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
    redialIn: (ms) => waits.push(ms),
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(made, 2, 'the first retry of the outage left at once');
  // createRedialSchedule: the second wait is drawn from [REDIAL_MIN_MS, 2 × REDIAL_MIN_MS]; random 0.5 is its middle.
  assert.deepEqual(waits, [750]);
  controller.abort();
  await assert.rejects(pending);
});

test('a hidden page does not redial; the wake that brings it back does', async () => {
  let visible = false;
  let made = 0;
  let link: { wake(): boolean } | undefined;
  const dialed = signal();
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      made++;
      dialed.hear();
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
  await dialed.happened;
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
  let redialed = signal();
  let link: { wake(): boolean } | undefined;
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      made++;
      redialed.hear();
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
  redialed = signal();
  visible = true;
  link!.wake();
  await redialed.happened;
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
  const opening = signal();
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      opening.hear();
      return ws;
    },
    signal: controller.signal,
    onConnection: () => undefined,
    linked: (l) => {
      link = l;
    },
  });
  pending.catch(() => undefined);
  await opening.happened;
  assert.equal(link!.wake(), false, 'nothing to probe yet');
  assert.deepEqual(sent, []);
  assert.deepEqual(closed, []);
  controller.abort();
  ws.onclose!({ code: 1000, reason: '' });
});

test('forced wake and post-hidden wake recycle an unready stuck dial immediately, while plain wake leaves a healthy dial alone', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const sockets: Array<{ ws: RelaySocket; closes: unknown[][] }> = [];
  const closeInfos: Array<{ code: number; reason: string; quiet: boolean }> = [];
  const redialIns: number[] = [];
  let dialed: (() => void) | undefined;
  const waitDial = (n: number) =>
    sockets.length >= n ? Promise.resolve() : new Promise<void>((resolve) => (dialed = resolve));
  let link: { hidden(): void; wake(options?: { force?: boolean }): boolean } | undefined;
  const controller = new AbortController();
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      const closes: unknown[][] = [];
      const ws: RelaySocket = {
        binaryType: '',
        bufferedAmount: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => {},
        close: (...args: unknown[]) => void closes.push(args),
      };
      sockets.push({ ws, closes });
      dialed?.();
      dialed = undefined;
      return ws;
    },
    signal: controller.signal,
    onConnection: () => undefined,
    onClose: (code, reason, info) => void closeInfos.push({ code, reason, quiet: info.quiet }),
    redialIn: (ms) => void redialIns.push(ms),
    linked: (l) => {
      link = l;
    },
  });
  pending.catch(() => undefined);
  try {
    await waitDial(1);
    assert.equal(link!.wake(), false, 'plain wake leaves a healthy never-hidden dial alone');
    assert.deepEqual(sockets[0].closes, []);
    assert.equal(sockets.length, 1);

    // Going hidden marks the in-flight dial unproven: returning to foreground recycles it silently at once.
    link!.hidden();
    assert.equal(link!.wake(), false);
    assert.deepEqual(sockets[0].closes, [[4000, 'wake dial restarted']]);
    assert.equal(closeInfos.at(-1)?.quiet, true);
    await waitDial(2);
    assert.deepEqual(redialIns, [], 'silent dial restart opens a fresh socket with no backoff');

    // A fresh dial that was never hidden stays untouched by plain wake, but force recycles it immediately.
    assert.equal(link!.wake(), false);
    assert.deepEqual(sockets[1].closes, []);
    assert.equal(sockets.length, 2);

    assert.equal(link!.wake({ force: true }), false);
    assert.deepEqual(sockets[1].closes, [[4000, 'wake dial restarted']]);
    assert.equal(closeInfos.at(-1)?.quiet, true);
    await waitDial(3);
    assert.deepEqual(redialIns, []);
  } finally {
    controller.abort();
  }
});

test('repeated wakes while a probe is in flight send one ping and keep the original wakeTimer deadline', async (t) => {
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

  let pings = 0;
  const originalSend = far.ws.send;
  far.ws.send = (data) => {
    if (data === '{"ping":1}') {
      pings += 1;
      return;
    }
    originalSend(data);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    assert.equal(phone.link.wake(), true);
    assert.equal(pings, 1);

    t.mock.timers.tick(1_500);
    assert.deepEqual(far.closes, [], 'probe has not expired yet');

    // Back-to-back wakes while the probe is running send no duplicate ping and do not extend the deadline.
    assert.equal(phone.link.wake(), true);
    assert.equal(phone.link.wake({ force: true }), true);
    assert.equal(pings, 1, 'only one ping was sent');

    t.mock.timers.tick(1_000);
    assert.deepEqual(far.closes.at(0), [4000, 'wake probe unanswered']);
  } finally {
    t.mock.timers.reset();
    await phone.client.close();
  }
});

test('a hide clears an in-flight wake probe so pre-hide traffic cannot certify a dead link after resume', async (t) => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  let mono = 1_000;
  let probeAnswered = 0;
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    now: () => mono,
    random: () => 0.5,
    onConnection: () => undefined,
    probeAnswered: () => {
      probeAnswered += 1;
    },
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  await foldedThrough(phone.client, 't1', 12);

  let pings = 0;
  const originalSend = far.ws.send;
  far.ws.send = (data) => {
    if (data === '{"ping":1}') {
      pings += 1;
      return;
    }
    originalSend(data);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    // First wake arms a probe; traffic arrives 1,200 ms later (past WAKE_TRAFFIC_PROOF_MS) before the page hides.
    assert.equal(phone.link.wake(), true);
    assert.equal(pings, 1);

    mono += 1_200;
    t.mock.timers.tick(1_200);
    await far.send(message(13, 'a2', 'agentMessage', { text: 'pre-hide' }));
    await foldedThrough(phone.client, 't1', 13);

    phone.link.hidden();
    mono += 200;
    t.mock.timers.tick(200);

    // Resuming before the old deadline must send a fresh ping rather than reusing the pre-hide timer.
    assert.equal(phone.link.wake(), true);
    assert.equal(pings, 2);

    // Past the old 2,500 ms deadline: pre-hide traffic must not certify the link.
    mono += 1_100;
    t.mock.timers.tick(1_100);
    assert.equal(probeAnswered, 0);
    assert.deepEqual(far.closes, []);

    // With no post-resume traffic, the fresh 2,500 ms probe expires and closes the dead link.
    mono += 1_400;
    t.mock.timers.tick(1_400);
    assert.equal(probeAnswered, 0);
    assert.deepEqual(far.closes.at(0), [4000, 'wake probe unanswered']);
  } finally {
    t.mock.timers.reset();
    await phone.client.close();
  }
});

test('a backward Date.now() jump across hide/resume cannot make pre-hide traffic certify a dead link', async (t) => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  let probeAnswered = 0;
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
    probeAnswered: () => {
      probeAnswered += 1;
    },
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  await foldedThrough(phone.client, 't1', 12);

  let pings = 0;
  const originalSend = far.ws.send;
  far.ws.send = (data) => {
    if (data === '{"ping":1}') {
      pings += 1;
      return;
    }
    originalSend(data);
  };
  const startWall = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: startWall });
  try {
    // Receive pre-hide traffic at the higher wall-clock timestamp.
    await far.send(message(13, 'a2', 'agentMessage', { text: 'pre-hide' }));
    await foldedThrough(phone.client, 't1', 13);

    // Hide, step the wall clock backward by 60 s, then resume with no post-resume traffic.
    phone.link.hidden();
    t.mock.timers.setTime(startWall - 60_000);
    assert.ok(Date.now() < startWall - 10_000);

    assert.equal(phone.link.wake(), true);
    assert.equal(pings, 1);

    t.mock.timers.tick(2_500);
    assert.equal(probeAnswered, 0, 'pre-hide traffic must not certify a dead link after a backward clock jump');
    assert.deepEqual(far.closes.at(0), [4000, 'wake probe unanswered']);
  } finally {
    t.mock.timers.reset();
    await phone.client.close();
  }
});

test('a pre-hide pong delayed behind an async decrypt cannot certify a dead link after resume', async (t) => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const served = serve(far.next, far.send);
  far.start();
  let probeAnswered = 0;
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
    probeAnswered: () => {
      probeAnswered += 1;
    },
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  await foldedThrough(phone.client, 't1', 12);

  let pings = 0;
  const originalSend = far.ws.send;
  far.ws.send = (data) => {
    if (data === '{"ping":1}') {
      pings += 1;
      return;
    }
    originalSend(data);
  };
  const subtle = globalThis.crypto.subtle;
  const originalDecrypt = subtle.decrypt.bind(subtle);
  let releaseDecrypt!: () => void;
  const decryptGate = new Promise<void>((resolve) => (releaseDecrypt = resolve));
  let decrypting!: () => void;
  const decryptStarted = new Promise<void>((resolve) => (decrypting = resolve));
  let holdNext = true;
  Object.defineProperty(subtle, 'decrypt', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof originalDecrypt>) => {
      if (!holdNext) return originalDecrypt(...args);
      holdNext = false;
      decrypting();
      return decryptGate.then(() => originalDecrypt(...args));
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    assert.equal(phone.link.wake(), true);
    assert.equal(pings, 1);

    // An encrypted frame blocks the inbound queue while a pre-hide pong arrives behind it.
    await far.send(message(13, 'a2', 'agentMessage', { text: 'pre-hide' }));
    await decryptStarted;
    far.ws.onmessage!({ data: JSON.stringify({ pong: 1 }) });

    // Page hides and resumes before the blocked decrypt finishes: a fresh probe starts.
    phone.link.hidden();
    t.mock.timers.tick(100);
    assert.equal(phone.link.wake(), true);
    assert.equal(pings, 2);

    // The pre-hide decrypt finishes and the queued pre-hide pong now reaches clearWord().
    releaseDecrypt();
    await foldedThrough(phone.client, 't1', 13);
    await settle();
    assert.equal(probeAnswered, 0, 'queued pre-hide pong must not satisfy the post-resume probe');
    assert.deepEqual(far.closes, []);

    // With no post-resume pong or traffic, the fresh deadline expires and closes the dead link.
    t.mock.timers.tick(2_500);
    assert.equal(probeAnswered, 0);
    assert.deepEqual(far.closes.at(0), [4000, 'wake probe unanswered']);
  } finally {
    Object.defineProperty(subtle, 'decrypt', { configurable: true, writable: true, value: originalDecrypt });
    t.mock.timers.reset();
    await phone.client.close();
  }
});

test('a socket parked on desktop-gone is closed by a suspension', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const parked = signal((code: number) => code === DESKTOP_LEG_GONE);
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
    onClose: parked.hear,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  // The word queues behind frames still decrypting on the crypto thread pool: the park is its signal.
  far.ws.onmessage!({ data: JSON.stringify({ resync: 'desktop-gone' }) });
  await parked.happened;
  phone.link.suspend();
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
  await far.closed;
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
  await far.closed;
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
  const parked = signal((code: number) => code === DESKTOP_LEG_GONE);
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    onConnection: () => undefined,
    onClose: (code) => {
      closes.push(code);
      parked.hear(code);
    },
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({ data: JSON.stringify({ resync: 'desktop-gone' }) });
  await parked.happened;
  const before = closes.length;
  phone.link.suspend();
  const afterSuspend = closes.length;
  far.ws.onclose!({ code: 1006, reason: 'late' });
  // Absence: nothing signals that the late close was ignored, so a later report would show here.
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
  const parked = signal((code: number) => code === DESKTOP_LEG_GONE);
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => far.ws,
    random: () => 0.5,
    signal: controller.signal,
    onConnection: () => undefined,
    onClose: parked.hear,
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served]);
  far.ws.onmessage!({ data: JSON.stringify({ resync: 'desktop-gone' }) });
  await parked.happened;
  const before = far.closes.length;
  controller.abort();
  assert.equal(far.closes.length, before + 1, 'the parked socket was closed');
});

test('a followed thread with no mounted conversation still has its window kept as the thread changes', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const far = relayPair(identity, false);
  const pos = (id: string) => `h1:0:${id}`;
  const unit = (id: string, ordinal: number) => ({
    position: pos(id),
    ordinal,
    items: [{ type: 'agentMessage', id, text: id, meta: { ext: { historyPosition: pos(id) } } }],
  });
  far.start();
  const sent: any[] = [];
  const phoneOptions = {
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
    onConnection: () => undefined,
  };
  const server = (async () => {
    const hello = await far.next();
    assert.equal(hello.method, 'initialize');
    await far.send({ id: hello.id, result: options.initializeResult });
    for (;;) {
      const frame = await far.next();
      sent.push(frame);
      if (frame.method === 'thread/resume') {
        await far.send({
          id: frame.id,
          result: { thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 11 } },
        });
        await far.send({
          method: 'thread/snapshot',
          params: {
            thread,
            items: [],
            state: {},
            hasOlder: false,
            window: {
              windowVersion: 10,
              lineage: 1,
              ranges: [{ id: 'tail', older: { kind: 'end' }, newer: { kind: 'end' } }],
              added: [{ range: 'tail', units: [unit('r1', 10), unit('r2', 20)] }],
              followTail: true,
            },
          },
          feed: feed(10),
        });
        // A record past one the tail does not hold: the window owes a read, whether a conversation shows it or not.
        await far.send({
          method: 'thread/transcript/changed',
          params: { lineage: 1, change: { op: 'insert', after: pos('r4'), unit: unit('r5', 50) } },
          feed: feed(11),
        });
      } else if (frame.method === 'thread/window/set') {
        await far.send({ id: frame.id, result: {} });
        return;
      } else if (frame.id !== undefined && frame.method !== 'initialized') {
        await far.send({ id: frame.id, result: {} });
      }
    }
  })();
  const phone = await connectPhone(phoneOptions);
  await phone.client.resumeThread('t1', { lastItems: 50 });
  await server;
  assert.ok(sent.some((frame) => frame.method === 'thread/window/set'));
  await phone.client.close();
});

test('link.probe does not reset offline redial backoff up to 60 s while link.wake does', async (t) => {
  const identity = await generateRelayE2EEServerIdentity();
  const controller = new AbortController();
  const waits: number[] = [];
  let link: { probe(): boolean; wake(): boolean } | undefined;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const pending = connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => refusedSocket(),
    signal: controller.signal,
    random: () => 1,
    onConnection: () => undefined,
    redialIn: (ms) => waits.push(ms),
    linked: (l) => {
      link = l;
    },
  });
  pending.catch(() => undefined);
  try {
    // Advance through the full offline ladder while probing repeatedly (simulating call deadlines).
    for (let i = 0; i < 8; i++) {
      await settle();
      assert.equal(link!.probe(), false, 'no ready socket to probe while offline');
      t.mock.timers.tick(OFFLINE_LADDER_CAP_MS);
    }
    await settle();
    assert.deepEqual(
      waits.slice(0, 7),
      [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, OFFLINE_LADDER_CAP_MS],
      'offline backoff grows up to 60 s despite link.probe() calls'
    );
    assert.equal(waits.at(-1), OFFLINE_LADDER_CAP_MS, 'stays capped at 60 s');

    // Explicit wake resets the ladder and cuts the wait short.
    const countBeforeWake = waits.length;
    link!.wake();
    await settle();
    t.mock.timers.tick(1_000);
    await settle();
    assert.ok(waits.length > countBeforeWake);
    assert.equal(waits[countBeforeWake], 1_000, 'wake reset backoff to the first step');
  } finally {
    controller.abort();
    t.mock.timers.reset();
    await assert.rejects(pending);
  }
});

test('link.wake({ recycle }) is quiet only when no call is in flight, matching recycle()', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const legs = [relayPair(identity, false), relayPair(identity, false), relayPair(identity, false)];
  let made = 0;
  const dialed: Array<{ n: number; resolve(): void }> = [];
  const waitDial = (n: number) => new Promise<void>((resolve) => (made >= n ? resolve() : dialed.push({ n, resolve })));
  const closeInfos: Array<{ code: number; reason: string; quiet: boolean }> = [];
  const served = [serve(legs[0].next, legs[0].send)];
  legs[0].start();
  const phone = await connectPhone({
    deviceId: 'dev',
    version: options.clientInfo.version,
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => 'wss://relay.invalid/d/dev',
    createSocket: () => {
      const leg = legs[made++];
      for (const waiter of dialed.filter((w) => w.n <= made)) {
        dialed.splice(dialed.indexOf(waiter), 1);
        waiter.resolve();
      }
      if (made >= 2) leg.start();
      return leg.ws;
    },
    random: () => 0.5,
    onConnection: () => undefined,
    onClose: (code, reason, info) => void closeInfos.push({ code, reason, quiet: info.quiet }),
  });
  await Promise.all([phone.client.resumeThread('t1', { lastItems: 50 }), served[0]]);
  try {
    // With nothing in flight, immediate recycle is quiet.
    assert.equal(phone.link.wake({ force: true, recycle: 'network changed' }), false);
    assert.deepEqual(legs[0].closes, [[4000, 'network changed']]);
    assert.equal(closeInfos.at(-1)?.quiet, true, 'idle recycleNow is quiet');

    // Bring up the second leg and send a call whose reply is held back.
    await waitDial(2);
    let callSent!: () => void;
    const inflightDelivered = new Promise<void>((resolve) => (callSent = resolve));
    const serveLeg2 = (async () => {
      for (;;) {
        const frame = await legs[1].next();
        if (frame === undefined) return;
        if (frame.method === 'initialize') {
          await legs[1].send({ id: frame.id, result: options.initializeResult });
        } else if (frame.method === 'thread/list') {
          callSent();
          return;
        } else if (frame.id !== undefined && frame.method !== 'initialized') {
          await legs[1].send({ id: frame.id, result: {} });
        }
      }
    })();
    const pendingCall = phone.client.call('thread/list', {} as never);
    pendingCall.catch(() => undefined);
    await inflightDelivered;

    // With a call in flight, recycleNow must not be quiet (matching recycle()).
    assert.equal(phone.link.wake({ force: true, recycle: 'network changed' }), false);
    assert.deepEqual(legs[1].closes, [[4000, 'network changed']]);
    assert.equal(closeInfos.at(-1)?.quiet, false, 'recycleNow with an in-flight call surfaces the outage');
    await waitDial(3);
    await serveLeg2;
  } finally {
    await phone.client.close();
  }
});
