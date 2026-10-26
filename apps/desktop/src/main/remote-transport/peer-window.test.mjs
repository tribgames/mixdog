// The direct-transport peer host (docs/remote-transport.md §9 1B): window
// main's bridge (peer-window.ts) driven against the real page module
// (renderer/remote-transport-peer-host/main.ts) through a fake Electron window
// whose IPC hop is a queue pumped by the test, and a fake RTCPeerConnection.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const windows = [];

class FakeContents {
  constructor(owner) {
    this.owner = owner;
    this.handlers = new Map();
    this.ipcHandlers = new Map();
    /** main → page commands still on the IPC hop. */
    this.toPage = [];
    /** page → main events still on the IPC hop. */
    this.toMain = [];
    this.page = null;
    this.ipc = { on: (channel, listener) => this.ipcHandlers.set(channel, listener) };
  }
  on(name, listener) {
    this.handlers.set(name, listener);
  }
  setWindowOpenHandler() {}
  send(channel, payload) {
    assert.equal(channel, 'remote-transport-peer:command');
    // Structured clone, as Electron's IPC: binary stays binary.
    this.toPage.push(structuredClone(payload));
  }
  crash() {
    this.handlers.get('render-process-gone')?.({}, { reason: 'crashed' });
  }
}

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.handlers = new Map();
    this.webContents = new FakeContents(this);
    windows.push(this);
  }
  on(name, listener) {
    this.handlers.set(name, listener);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handlers.get('closed')?.();
  }
  loadFile(file) {
    this.loaded = file;
    startPage(this);
    return Promise.resolve();
  }
  loadURL(url) {
    this.loaded = url;
    startPage(this);
    return Promise.resolve();
  }
}

globalThis.__peerWindowElectron = { FakeWindow };
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const BrowserWindow=globalThis.__peerWindowElectron.FakeWindow;' +
            'export const app={getAppPath:()=>"/app"};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { createRemoteTransportPeerWindow, REMOTE_TRANSPORT_PEER_IPC } = await import('./peer-window.ts');
const { startRemoteTransportPeerHost } = await import('../../renderer/remote-transport-peer-host/main.ts');
const {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_BUFFER_LOW_BYTES,
  REMOTE_TRANSPORT_MAX_MESSAGE_BYTES,
  REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS,
} = await import('../../shared/remote-transport.ts');
/** App records stop the control reserve (the low-water mark, as on the phone) short of the shared bound. */
const APP_LIMIT = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_BUFFER_LOW_BYTES;

// ---------------------------------------------------------------------------
// Fake WebRTC
// ---------------------------------------------------------------------------

const hex = (seed) => Array.from({ length: 32 }, (_, index) => ((index * 7 + seed) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(':');
const LOCAL_FP = hex(1);
const REMOTE_FP = hex(2);
const sdpWith = (fingerprint) =>
  `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${fingerprint}\r\n` +
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const HOST_LINE = 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host';
const RELAY_LINE = 'candidate:2 1 udp 41885439 203.0.113.5 3478 typ relay raddr 192.168.1.2 rport 54321';

class FakeChannel extends EventTarget {
  constructor(label, init) {
    super();
    this.label = label;
    this.ordered = init.ordered;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'blob';
    this.sent = [];
    /** The threshold in force at each send. */
    this.thresholdAtSend = [];
    /** Set to drain silently while the page registers its low listener. */
    this.drainOnRegister = false;
  }
  addEventListener(type, listener) {
    super.addEventListener(type, listener);
    if (type === 'bufferedamountlow' && this.drainOnRegister) {
      // The drain happened before the listener existed: no event is ever fired.
      this.bufferedAmount = 0;
      this.drainOnRegister = false;
    }
  }
  send(data) {
    this.thresholdAtSend.push(this.bufferedAmountLowThreshold);
    this.sent.push(data);
    this.bufferedAmount += data.byteLength;
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
  drain(bytes) {
    const before = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, before - bytes);
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }
  receive(bytes) {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

const peers = [];

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.channels = [];
    this.connectionState = 'new';
    this.sctp = { maxMessageSize: 262_144, transport: { state: 'connected' } };
    this.localDescription = null;
    this.remoteDescription = null;
    this.remoteCandidates = [];
    this.offers = [];
    this.closed = false;
    this.certificate = { fingerprint: REMOTE_FP, fingerprintAlgorithm: 'sha-256' };
    this.localType = 'host';
    peers.push(this);
  }
  createDataChannel(label, init) {
    // Every channel exists before the offer is made.
    assert.equal(this.offers.length, 0, 'channels are created before the offer');
    const channel = new FakeChannel(label, init);
    this.channels.push(channel);
    return channel;
  }
  channel(label) {
    return this.channels.find((channel) => channel.label === label);
  }
  async createOffer(options) {
    this.offers.push(options ?? {});
    return { type: 'offer', sdp: sdpWith(LOCAL_FP) };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate) {
    this.remoteCandidates.push(candidate);
  }
  async getStats() {
    return new Map([
      ['t', { type: 'transport', remoteCertificateId: 'c', selectedCandidatePairId: 'p' }],
      ['c', { type: 'certificate', ...this.certificate }],
      ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', candidateType: this.localType }],
      ['r', { type: 'remote-candidate', candidateType: 'srflx' }],
    ]);
  }
  close() {
    this.closed = true;
  }
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
  failIce() {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
  localCandidate(line, extra = {}) {
    this.onicecandidate?.({
      candidate: { candidate: line, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd', ...extra },
      url: null,
    });
  }
}

/** The page of one window: the real host module on the fake hop. */
function startPage(window) {
  const contents = window.webContents;
  startRemoteTransportPeerHost({
    bridge: {
      onCommand(listener) {
        contents.page = listener;
      },
      emit(event) {
        contents.toMain.push(structuredClone(event));
      },
    },
    RTCPeerConnection: FakePeerConnection,
  });
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Moves everything across the IPC hop, both ways, until quiet. */
async function pump() {
  for (let round = 0; round < 100; round += 1) {
    await turn();
    let moved = false;
    for (const window of windows) {
      const contents = window.webContents;
      if (window.destroyed) {
        contents.toPage.length = 0;
        contents.toMain.length = 0;
        continue;
      }
      while (contents.toPage.length) {
        moved = true;
        contents.page(contents.toPage.shift());
      }
      while (contents.toMain.length) {
        moved = true;
        contents.ipcHandlers.get(REMOTE_TRANSPORT_PEER_IPC.event)?.({}, contents.toMain.shift());
      }
    }
    if (!moved) {
      await turn();
      if (windows.every((window) => !window.webContents.toPage.length && !window.webContents.toMain.length)) return;
    }
  }
  throw new Error('the IPC hop never went quiet');
}

function fixture() {
  windows.length = 0;
  peers.length = 0;
  const events = [];
  const reports = [];
  const bridge = createRemoteTransportPeerWindow({
    page: { file: '/app/out/renderer/remote-transport-peer.html' },
    report: (event, data) => reports.push({ event, ...data }),
  });
  bridge.onEvent((event) => events.push(event));
  const of = (type) => events.filter((event) => event.type === type);
  return { bridge, events, reports, of };
}

const ID = 'conn-0001';

/** create → offer → answer → connect → both channels open. */
async function openConnection(f, { id = ID, order = ['app', 'control'] } = {}) {
  assert.equal(f.bridge.create({ connectionId: id, session: 'session-a', iceServers: [] }), true);
  assert.equal(f.bridge.offer(id), true);
  await pump();
  const pc = peers.at(-1);
  const offer = f.of('offer').find((event) => event.connectionId === id);
  assert.ok(offer, 'an offer was emitted');
  assert.equal(
    f.bridge.answer(id, { sdp: sdpWith(REMOTE_FP), fingerprints: [{ algorithm: 'sha-256', value: REMOTE_FP }] }),
    true
  );
  await pump();
  pc.connect();
  await pump();
  for (const label of order) pc.channel(label === 'app' ? 'mixdog-transport' : 'mixdog-transport-control').open();
  await pump();
  return pc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the PC offers with both channels, applies the answer and candidates, and opens after the certificate check', async () => {
  const f = fixture();
  assert.equal(
    f.bridge.create({
      connectionId: ID,
      session: 'session-a',
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }],
    }),
    true
  );
  assert.equal(f.bridge.offer(ID), true);
  assert.equal(windows.length, 1, 'the hidden window opens on first use');
  assert.equal(windows[0].options.show, false);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.backgroundThrottling, false);
  assert.match(windows[0].options.webPreferences.preload, /remote-transport-peer\.js$/u);
  await pump();

  const pc = peers[0];
  // Servers as the caller gave them, normalized; the policy is `all` (§3).
  assert.deepEqual(pc.config.iceServers, [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' }]);
  assert.equal(pc.config.iceTransportPolicy, 'all');
  const app = pc.channel('mixdog-transport');
  const control = pc.channel('mixdog-transport-control');
  assert.equal(app.ordered, true);
  assert.equal(control.ordered, true);
  for (const channel of [app, control]) {
    assert.equal(channel.binaryType, 'arraybuffer');
    assert.equal(channel.bufferedAmountLowThreshold, REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
  }
  assert.deepEqual(f.of('offer'), [
    { type: 'offer', connectionId: ID, sdp: sdpWith(LOCAL_FP), fingerprints: [{ algorithm: 'sha-256', value: LOCAL_FP }] },
  ]);

  // A phone candidate before any answer is refused.
  assert.equal(f.bridge.candidate(ID, { candidate: HOST_LINE, sdpMid: '0', sdpMLineIndex: 0 }), false);
  assert.equal(
    f.bridge.answer(ID, { sdp: sdpWith(REMOTE_FP), fingerprints: [{ algorithm: 'sha-256', value: REMOTE_FP }] }),
    true
  );
  assert.equal(f.bridge.candidate(ID, { candidate: HOST_LINE, sdpMid: '0', sdpMLineIndex: 0 }), true);
  assert.equal(f.bridge.candidate(ID, { candidate: 'candidate:x bogus', sdpMid: '0' }), false);
  assert.equal(f.bridge.candidate(ID, null), true);
  await pump();
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: sdpWith(REMOTE_FP) });
  assert.deepEqual(pc.remoteCandidates, [
    { candidate: HOST_LINE, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null },
    undefined,
  ]);

  // Local candidates are validated and relayed; a TURN allocation is logged per session.
  pc.localCandidate(HOST_LINE, { type: 'host' });
  pc.localCandidate(RELAY_LINE, { type: 'relay', relayProtocol: 'udp', url: 'turn:turn.example:3478?transport=udp' });
  pc.localCandidate('candidate:x bogus', { type: 'host' });
  await pump();
  assert.deepEqual(
    f.of('candidate').map((event) => event.candidate.candidate),
    [HOST_LINE, RELAY_LINE]
  );
  assert.deepEqual(
    f.reports.filter((entry) => entry.event === 'turn-allocation'),
    [
      {
        event: 'turn-allocation',
        session: 'session-a',
        connectionId: ID,
        allocations: 1,
        relayProtocol: 'udp',
        url: 'turn:turn.example:3478?transport=udp',
      },
    ]
  );

  // Messages that arrive before `open` are held, then delivered after it in order.
  control.open();
  control.receive(new Uint8Array([1, 2, 3]));
  await pump();
  assert.equal(f.of('open').length, 0, 'one channel open is not open');
  pc.connect();
  await pump();
  assert.equal(f.of('open').length, 0, 'the app channel is still connecting');
  app.receive(new Uint8Array([4]));
  app.open();
  await pump();
  assert.deepEqual(f.of('open'), [
    { type: 'open', connectionId: ID, maxMessageSize: 262_144, fits: true, path: 'direct' },
  ]);
  const opened = f.events.findIndex((event) => event.type === 'open');
  const messages = f.events.slice(opened + 1).filter((event) => event.type === 'message');
  assert.deepEqual(
    messages.map((event) => [event.channel, [...event.data]]),
    [
      ['control', [1, 2, 3]],
      ['app', [4]],
    ]
  );
  assert.ok(messages.every((event) => event.data instanceof Uint8Array));
  assert.equal(f.of('failed').length, 0);
  f.bridge.dispose();
});

test('open waits for both channels in either order and reports maxMessageSize and the TURN path', async () => {
  for (const order of [
    ['app', 'control'],
    ['control', 'app'],
  ]) {
    const f = fixture();
    const pc = await openConnection(f, { order });
    assert.equal(f.of('open').length, 1);
    assert.equal(f.of('open')[0].fits, true);
    f.bridge.dispose();
    assert.equal(pc.closed, false, 'dispose destroys the page; its peers go with it');
  }

  // A TURN pair is reported as such; an SCTP size below the contract does not fit.
  const f = fixture();
  f.bridge.create({ connectionId: ID, session: 'session-a', iceServers: [] });
  f.bridge.offer(ID);
  await pump();
  const pc = peers[0];
  pc.localType = 'relay';
  pc.sctp.maxMessageSize = REMOTE_TRANSPORT_MAX_MESSAGE_BYTES - 1;
  f.bridge.answer(ID, { sdp: sdpWith(REMOTE_FP), fingerprints: [{ algorithm: 'sha-256', value: REMOTE_FP }] });
  pc.connect();
  pc.channel('mixdog-transport').open();
  pc.channel('mixdog-transport-control').open();
  await pump();
  assert.deepEqual(f.of('open'), [
    {
      type: 'open',
      connectionId: ID,
      maxMessageSize: REMOTE_TRANSPORT_MAX_MESSAGE_BYTES - 1,
      fits: false,
      path: 'turn',
    },
  ]);
  f.bridge.dispose();
});

test('a certificate other than the answer named fails fingerprint-mismatch and closes the peer', async () => {
  const f = fixture();
  f.bridge.create({ connectionId: ID, session: 'session-a', iceServers: [] });
  f.bridge.offer(ID);
  await pump();
  const pc = peers[0];
  pc.certificate = { fingerprint: hex(9), fingerprintAlgorithm: 'sha-256' };
  f.bridge.answer(ID, { sdp: sdpWith(REMOTE_FP), fingerprints: [{ algorithm: 'sha-256', value: REMOTE_FP }] });
  await pump();
  pc.connect();
  pc.channel('mixdog-transport').open();
  pc.channel('mixdog-transport-control').open();
  pc.channel('mixdog-transport').receive(new Uint8Array([9]));
  await pump();
  assert.deepEqual(f.of('failed'), [{ type: 'failed', connectionId: ID, reason: 'fingerprint-mismatch' }]);
  assert.equal(f.of('open').length, 0);
  assert.equal(f.of('message').length, 0, 'nothing from an unverified peer reaches the caller');
  assert.equal(pc.closed, true);
  f.bridge.dispose();
});

test('an answer whose SDP differs from its signaled fingerprints is refused', async () => {
  const f = fixture();
  f.bridge.create({ connectionId: ID, session: 'session-a', iceServers: [] });
  assert.equal(
    f.bridge.answer(ID, { sdp: sdpWith(REMOTE_FP), fingerprints: [{ algorithm: 'sha-256', value: REMOTE_FP }] }),
    false,
    'no answer without an outstanding offer'
  );
  f.bridge.offer(ID);
  await pump();
  assert.equal(
    f.bridge.answer(ID, { sdp: sdpWith(REMOTE_FP), fingerprints: [{ algorithm: 'sha-256', value: hex(5) }] }),
    false
  );
  await pump();
  assert.deepEqual(f.of('failed'), [{ type: 'failed', connectionId: ID, reason: 'fingerprint-mismatch' }]);
  assert.equal(peers[0].closed, true);
  assert.equal(peers[0].remoteDescription, null);

  // An SDP over the control plaintext budget is a protocol error.
  const g = fixture();
  g.bridge.create({ connectionId: ID, session: 'session-a', iceServers: [] });
  g.bridge.offer(ID);
  await pump();
  const huge = `${sdpWith(REMOTE_FP)}a=x:${'y'.repeat(70_000)}\r\n`;
  assert.equal(g.bridge.answer(ID, { sdp: huge, fingerprints: [{ algorithm: 'sha-256', value: REMOTE_FP }] }), false);
  assert.equal(g.of('failed')[0].reason, 'protocol-error');
  f.bridge.dispose();
  g.bridge.dispose();
});

test('backpressure counts the IPC hop with bufferedAmount and refuses above the high-water mark', async () => {
  const f = fixture();
  const pc = await openConnection(f);
  const app = pc.channel('mixdog-transport');
  const control = pc.channel('mixdog-transport-control');
  const message = new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES).fill(7);

  assert.equal(f.bridge.send(ID, 'app', new Uint8Array(0)), false, 'an empty message is refused');
  assert.equal(f.bridge.send(ID, 'app', new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES + 1)), false);

  // Bytes on the hop count before the page has seen them.
  const fit = Math.floor(APP_LIMIT / message.byteLength);
  for (let index = 0; index < fit; index += 1) assert.equal(f.bridge.send(ID, 'app', message), true);
  assert.equal(f.bridge.queued(ID, 'app'), fit * message.byteLength);
  assert.equal(app.sent.length, 0, 'nothing reached the channel yet');
  assert.equal(f.bridge.send(ID, 'app', message), false, 'IPC-hop bytes alone reach the app share of the bound');
  // The control reserve is left: control never waits behind bulk.
  assert.equal(f.bridge.send(ID, 'control', new Uint8Array([3, 1])), true);
  assert.equal(f.bridge.queued(ID), fit * message.byteLength + 2, 'the load spans both channels');

  await pump();
  // Handed to the channel: the hop is empty and bufferedAmount carries the bytes.
  assert.equal(app.sent.length, fit);
  assert.ok(app.sent.every((data) => data instanceof Uint8Array && data.byteLength === message.byteLength));
  assert.deepEqual([...control.sent[0]], [3, 1]);
  assert.ok(
    [...app.thresholdAtSend, ...control.thresholdAtSend].every((value) => value === REMOTE_TRANSPORT_BUFFER_LOW_BYTES),
    'the low threshold is set before the first send'
  );
  assert.equal(f.bridge.queued(ID, 'app'), app.bufferedAmount);
  assert.equal(f.bridge.send(ID, 'app', message), false, 'still at the high-water mark');

  // Draining part of the way is invisible until the low threshold (it errs high)…
  app.drain(app.bufferedAmount - REMOTE_TRANSPORT_BUFFER_LOW_BYTES - 1);
  await pump();
  assert.equal(f.bridge.queued(ID, 'app'), fit * message.byteLength);
  // …unless sampled.
  f.bridge.sample(ID);
  await pump();
  assert.equal(f.bridge.queued(ID, 'app'), REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 1);
  const drains = f.of('drain').filter((event) => event.channel === 'app');
  // A drain carries the connection's load: the two control bytes still count.
  assert.equal(drains.at(-1).queued, REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 1 + 2);

  // The drain to the low threshold is signaled.
  app.drain(1);
  await pump();
  assert.equal(f.bridge.queued(ID, 'app'), REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
  assert.equal(f.of('drain').at(-1).queued, REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 2);
  assert.equal(f.bridge.send(ID, 'app', message), true);
  await pump();
  assert.equal(f.bridge.queued(ID, 'app'), REMOTE_TRANSPORT_BUFFER_LOW_BYTES + message.byteLength);
  f.bridge.dispose();
});

test('control (ping, pong, ack) is sent and delivered at once while the app channel sits at the high-water mark', async () => {
  const { encodeRemoteTransportControl, decodeRemoteTransportMessage } = await import('../../shared/remote-transport.ts');
  // A sealed control box as remote-e2ee.ts frames it: its magic, a header and a tag.
  const box = (tag) => {
    const bytes = new Uint8Array(64).fill(tag);
    bytes.set([0x4d, 0x58, 0x43, 0x01], 0);
    return encodeRemoteTransportControl(bytes);
  };
  const PING = 0x11;
  const PONG = 0x22;
  const ACK = 0x33;

  const f = fixture();
  const pc = await openConnection(f);
  const app = pc.channel('mixdog-transport');
  const control = pc.channel('mixdog-transport-control');
  const bulk = new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES).fill(7);

  // Saturate: fill to the high-water mark, hand it to the channel (which never
  // drains), and refill the IPC hop as well.
  while (f.bridge.send(ID, 'app', bulk));
  await pump();
  while (f.bridge.send(ID, 'app', bulk));
  const saturated = f.bridge.queued(ID, 'app');
  assert.ok(saturated > APP_LIMIT - bulk.byteLength);
  assert.ok(saturated <= APP_LIMIT, 'app records stop the control reserve short of the bound');
  assert.equal(f.bridge.send(ID, 'app', bulk), false);
  const appSent = app.sent.length;

  // Outgoing control is admitted and reaches its channel in one hop, in order.
  for (const tag of [PING, ACK, PONG]) assert.equal(f.bridge.send(ID, 'control', box(tag)), true);
  assert.ok(f.bridge.queued(ID, 'control') < REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
  await pump();
  assert.deepEqual(
    control.sent.map((data) => decodeRemoteTransportMessage(data).box[4]),
    [PING, ACK, PONG]
  );
  // Bulk queued behind it on the hop went to its own channel, not in front.
  assert.ok(app.sent.length >= appSent);
  assert.equal(f.bridge.queued(ID, 'app'), app.bufferedAmount);
  assert.ok(f.bridge.queued(ID) <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES);

  // Incoming control while bulk is stuck: each delivered as its own event, in arrival order.
  const before = f.of('message').length;
  for (const tag of [PONG, PING, ACK]) control.receive(box(tag));
  await pump();
  const delivered = f.of('message').slice(before);
  assert.deepEqual(
    delivered.map((event) => [event.channel, decodeRemoteTransportMessage(event.data).box[4]]),
    [
      ['control', PONG],
      ['control', PING],
      ['control', ACK],
    ]
  );
  f.bridge.dispose();
});

test('both channels share one bound: the combined load never exceeds it and control keeps its reserve', async () => {
  const f = fixture();
  const pc = await openConnection(f);
  const app = pc.channel('mixdog-transport');
  const control = pc.channel('mixdog-transport-control');
  const bulk = new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES).fill(7);
  const small = new Uint8Array(64).fill(3);
  const check = () => {
    const load = f.bridge.queued(ID);
    assert.equal(load, f.bridge.queued(ID, 'app') + f.bridge.queued(ID, 'control'));
    assert.ok(load <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES, `load ${load} over the bound`);
    return load;
  };

  // Bulk alone: on the hop and in the channel (which never drains), it stops at its share.
  for (let round = 0; round < 2; round += 1) {
    while (f.bridge.send(ID, 'app', bulk)) check();
    await pump();
  }
  assert.ok(check() > APP_LIMIT - bulk.byteLength && check() <= APP_LIMIT);

  // Control (ping, ack, pong) still passes, then saturates the rest — bulk keeps
  // trying alongside and is never admitted, on the hop or once handed over.
  for (const box of [small, small, small]) assert.equal(f.bridge.send(ID, 'control', box), true);
  for (let round = 0; round < 2; round += 1) {
    for (;;) {
      assert.equal(f.bridge.send(ID, 'app', bulk), false);
      check();
      const admitted = f.bridge.send(ID, 'control', bulk);
      check();
      if (!admitted) break;
    }
    await pump();
    check();
  }
  const full = check();
  assert.ok(full > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - bulk.byteLength, 'the whole bound is in use');
  assert.equal(app.bufferedAmount + control.bufferedAmount, full, 'all of it reached the channels');
  assert.ok(control.bufferedAmount > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - APP_LIMIT - bulk.byteLength);
  assert.equal(f.bridge.send(ID, 'control', bulk), false, 'past the whole bound control is refused too');

  // Control drains: control passes again while bulk stays at its share.
  control.drain(control.bufferedAmount);
  f.bridge.sample(ID);
  await pump();
  assert.equal(f.of('drain').at(-1).channel, 'control');
  assert.equal(f.of('drain').at(-1).queued, app.bufferedAmount);
  assert.equal(f.bridge.send(ID, 'app', bulk), false);
  assert.equal(f.bridge.send(ID, 'control', small), true);
  check();
  f.bridge.dispose();
});

test('a host reload fails every connection, frees their ids and resets the accounting', async () => {
  for (const reload of ['second ready', 'navigation']) {
    const f = fixture();
    await openConnection(f);
    f.bridge.create({ connectionId: 'conn-0002', session: 'session-b', iceServers: [] });
    const bulk = new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
    for (let index = 0; index < 4; index += 1) f.bridge.send(ID, 'app', bulk);
    await pump();
    // Two more on the IPC hop, one control box too.
    f.bridge.send(ID, 'app', bulk);
    f.bridge.send(ID, 'app', bulk);
    f.bridge.send(ID, 'control', new Uint8Array([1]));
    assert.equal(f.bridge.queued(ID), 6 * bulk.byteLength + 1);

    const contents = windows[0].webContents;
    if (reload === 'second ready') {
      // The page document is replaced: the host module starts over and reports ready again.
      startPage(windows[0]);
      await pump();
    } else {
      // Sub-frame and same-document navigations are no reload.
      contents.handlers.get('did-start-navigation')({ isMainFrame: false, isSameDocument: false });
      contents.handlers.get('did-start-navigation')({ isMainFrame: true, isSameDocument: true });
      assert.equal(f.of('failed').length, 0);
      contents.handlers.get('did-start-navigation')({ isMainFrame: true, isSameDocument: false });
    }

    assert.deepEqual(
      f.of('failed').map((event) => [event.connectionId, event.reason]),
      [
        [ID, 'peer-host-unavailable'],
        ['conn-0002', 'peer-host-unavailable'],
      ],
      reload
    );
    assert.equal(windows[0].destroyed, true, 'the reloaded page is discarded');
    assert.equal(f.reports.find((entry) => entry.event === 'host-lost').cause, reload === 'navigation' ? 'navigated' : 'reloaded');
    assert.equal(f.bridge.queued(ID), 0, 'its accounting went with it');
    assert.equal(f.bridge.queued('conn-0002'), 0);
    assert.equal(f.bridge.send(ID, 'app', bulk), false, 'no send without a live peer');
    await pump();

    // The ids are free and a fresh page starts with clean accounting: the full app share fits again.
    const pc = await openConnection(f);
    assert.equal(windows.length, 2);
    assert.equal(f.bridge.create({ connectionId: 'conn-0002', session: 'session-b', iceServers: [] }), true);
    assert.equal(f.bridge.queued(ID), 0);
    let sent = 0;
    while (f.bridge.send(ID, 'app', bulk)) sent += 1;
    assert.equal(sent, Math.floor(APP_LIMIT / bulk.byteLength));
    await pump();
    assert.equal(pc.channel('mixdog-transport').sent.length, sent, 'nothing of the old page leaked onto the new peer');
    assert.equal(f.of('failed').length, 2);
    f.bridge.dispose();
  }
});

test('a drain between the send and the low lister registration is not missed', async () => {
  const f = fixture();
  const pc = await openConnection(f);
  const app = pc.channel('mixdog-transport');
  const message = new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
  const count = Math.ceil((REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 1) / message.byteLength);
  for (let index = 0; index < count; index += 1) f.bridge.send(ID, 'app', message);
  // The page reads bufferedAmount above the threshold, then the channel drains
  // completely before its low listener exists: no event will ever fire.
  app.drainOnRegister = true;
  await pump();
  assert.equal(app.bufferedAmount, 0);
  assert.equal(f.bridge.queued(ID, 'app'), 0, 'the re-check after registration reported the drain');
  assert.equal(f.of('drain').at(-1).queued, 0);
  f.bridge.dispose();
});

test('a page crash fails every connection peer-host-unavailable and the next create opens a new page', async () => {
  const f = fixture();
  await openConnection(f);
  f.bridge.create({ connectionId: 'conn-0002', session: 'session-b', iceServers: [] });
  f.bridge.send(ID, 'app', new Uint8Array([1]));
  windows[0].webContents.crash();
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(
    f.of('failed').map((event) => [event.connectionId, event.reason]),
    [
      [ID, 'peer-host-unavailable'],
      ['conn-0002', 'peer-host-unavailable'],
    ]
  );
  assert.equal(f.bridge.queued(ID, 'app'), 0, 'its accounting went with it');
  assert.equal(f.bridge.send(ID, 'app', new Uint8Array([1])), false);
  await pump();

  // Recreated on next use; the old page's late events change nothing.
  const pc = await openConnection(f, { id: 'conn-0003' });
  assert.equal(windows.length, 2);
  assert.equal(f.of('open').at(-1).connectionId, 'conn-0003');
  assert.equal(pc.closed, false);
  f.bridge.dispose();
});

test('close ends a connection without an event; dispose fails the rest and refuses new ones', async () => {
  const f = fixture();
  const pc = await openConnection(f);
  f.bridge.close(ID);
  await pump();
  assert.equal(pc.closed, true);
  assert.equal(pc.channel('mixdog-transport').readyState, 'closed');
  assert.equal(f.of('failed').length, 0, 'the caller closed it');
  assert.equal(f.bridge.send(ID, 'app', new Uint8Array([1])), false);

  await openConnection(f, { id: 'conn-0002' });
  f.bridge.dispose();
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(f.of('failed'), [{ type: 'failed', connectionId: 'conn-0002', reason: 'peer-host-unavailable' }]);
  assert.equal(f.bridge.create({ connectionId: 'conn-0003', session: 's', iceServers: [] }), false);
  assert.equal(windows.length, 1);
});

test('channel and ICE failures are reported once and close the peer', async () => {
  const f = fixture();
  const pc = await openConnection(f);
  pc.channel('mixdog-transport-control').close();
  pc.failIce();
  await pump();
  assert.deepEqual(
    f.of('failed').map((event) => [event.connectionId, event.reason]),
    [[ID, 'channel-failed']]
  );
  assert.equal(pc.closed, true);

  const second = await openConnection(f, { id: 'conn-0002' });
  second.failIce();
  await pump();
  assert.deepEqual(f.of('failed').at(-1), { type: 'failed', connectionId: 'conn-0002', reason: 'ice-failed' });
  f.bridge.dispose();
});

test('a connection not open within the negotiation timeout fails negotiation-timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.bridge.create({ connectionId: ID, session: 'session-a', iceServers: [] });
  f.bridge.offer(ID);
  await pump();
  t.mock.timers.tick(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS - 1);
  assert.equal(f.of('failed').length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(f.of('failed'), [{ type: 'failed', connectionId: ID, reason: 'negotiation-timeout' }]);
  await pump();
  assert.equal(peers[0].closed, true);

  // An open connection is past negotiation: the timer is gone.
  await openConnection(f, { id: 'conn-0002' });
  t.mock.timers.tick(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  assert.equal(f.of('failed').length, 1);
  f.bridge.dispose();
});

test('an ICE restart offers again on the same peer and keeps the verified certificate', async () => {
  const f = fixture();
  const pc = await openConnection(f);
  assert.equal(f.bridge.offer(ID, { iceRestart: true }), true);
  await pump();
  assert.deepEqual(pc.offers.at(-1), { iceRestart: true });
  assert.equal(f.of('offer').length, 2);
  // An answer naming a different certificate than the one DTLS runs on is refused.
  assert.equal(
    f.bridge.answer(ID, { sdp: sdpWith(hex(5)), fingerprints: [{ algorithm: 'sha-256', value: hex(5) }] }),
    false
  );
  assert.equal(f.of('failed').at(-1).reason, 'fingerprint-mismatch');
  f.bridge.dispose();
});

test('malformed or out-of-order page events are ignored', async () => {
  const f = fixture();
  f.bridge.create({ connectionId: ID, session: 'session-a', iceServers: [] });
  await pump();
  const deliver = (event) => windows[0].webContents.ipcHandlers.get(REMOTE_TRANSPORT_PEER_IPC.event)({}, event);
  deliver(null);
  deliver({ type: 'message', connectionId: ID, channel: 'app', data: 'text' });
  deliver({ type: 'message', connectionId: ID, channel: 'app', data: new Uint8Array([1]) });
  deliver({ type: 'offer', connectionId: ID, sdp: sdpWith(LOCAL_FP) });
  deliver({ type: 'sent', connectionId: ID, channel: 'app', bytes: -1, bufferedAmount: 0 });
  deliver({ type: 'failed', connectionId: ID, reason: 'made-up' });
  assert.deepEqual(f.events, [], 'no offer was asked for, nothing is open');
  // `open` before the certificate check is a protocol error.
  deliver({ type: 'open', connectionId: ID, maxMessageSize: 65_536, path: null });
  assert.deepEqual(f.of('failed'), [
    { type: 'failed', connectionId: ID, reason: 'protocol-error', detail: 'open before the certificate check' },
  ]);
  assert.equal(f.bridge.create({ connectionId: 'short', session: 's', iceServers: [] }), false);
  assert.equal(f.bridge.create({ connectionId: 'conn-0009', session: 's', iceServers: [{ urls: 'http://x' }] }), false);
  f.bridge.dispose();
});
