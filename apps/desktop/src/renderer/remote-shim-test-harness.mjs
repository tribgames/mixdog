// Test support: the real browser-hop shim modules (pairing and view sync
// replaced by inert fakes) driven over a fake WebSocket with a REAL E2EE
// handshake, so tests can assert what the shim does on the wire instead of
// pinning its source text.
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee.ts';

export const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

export const until = async (condition, what = 'condition') => {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`${what} did not settle`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    FakeSocket.instances.push(this);
  }

  send(frame) {
    this.sent.push(frame);
  }

  close() {
    this.closeCalls += 1;
  }
}

const GLOBALS = ['window', 'document', 'localStorage', 'WebSocket'];

/** Published ceilings, as the relay hands them over in `e2ee-ready`. */
export const publishedCeilings = (binary, text, capacity = Math.max(binary, text) + 1_000) => ({
  uplinkCapacityBytes: capacity,
  uplinkBinaryCeilingBytes: binary,
  uplinkTextCeilingBytes: text,
});

/** Run `run` against a live shim context. `secure` selects the E2EE transport
 *  (the default in production); otherwise the supported legacy direct mode. */
export const withShim = async ({ secure = true } = {}, run) => {
  const saved = GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const events = [];
  const timers = { live: new Map(), armed: 0, cleared: 0, next: 1 };
  FakeSocket.instances = [];
  define('window', {
    Event,
    CustomEvent,
    setTimeout: (fn, ms) => {
      const id = timers.next++;
      timers.armed += 1;
      timers.live.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.cleared += 1;
      timers.live.delete(id);
    },
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
    addEventListener() {},
    removeEventListener() {},
  });
  define('document', { visibilityState: 'visible', documentElement: { dataset: {} }, getElementById: () => null });
  define('localStorage', { getItem: () => null, setItem() {} });
  define('WebSocket', FakeSocket);
  try {
    const [limitsModule, calls, dispatch, socket] = await Promise.all([
      import('./remote-shim-payload-limit.ts'),
      import('./remote-shim-calls.ts'),
      import('./remote-shim-dispatch.ts'),
      import('./remote-shim-socket.ts'),
    ]);
    const identity = await generateRelayE2EEServerIdentity();
    const pending = new Map();
    let resyncs = 0;
    const ctx = {
      pending,
      limits: limitsModule.createRelayPayloadLimits({ pending, showToast: limitsModule.showRemoteToast }),
      e2eePairing: secure ? relayE2EEPairingMaterial(identity) : null,
      nextId: 1,
      browserId: 'browser',
      token: 'token',
      serverBase: '',
      socket: null,
      openPromise: null,
      openingSocket: null,
      openingStartedAt: 0,
      retireConnection: null,
      lastVisibleSessionIds: [],
      everConnected: false,
      everPaired: true,
      retryMs: 500,
      secureChannel: null,
      connectionReady: false,
      peerViewSync: false,
      peerRemoteParity: false,
      peerNativePush: false,
      peerBrowserParity: false,
      approvalVerificationInFlight: false,
      relayBinaryFrames: false,
      awaitingPong: false,
      backgroundSuspended: false,
      resyncOnWake: false,
      lastTrafficAt: 0,
      viewResumeToken: null,
      carriedResumeToken: null,
      pendingReconnectNotification: false,
      quietRecycledSockets: new WeakSet(),
      stateListeners: new Set(),
      activityRailPinsListeners: new Set(),
      providerModelsListeners: new Set(),
      remoteBrowserFrameListeners: new Set(),
      browserOpenListeners: new Set(),
      remoteBrowserTabListeners: new Set(),
      browserImportProgressListeners: new Set(),
      activeLanes: new Set(),
      compactFrames: { reset() {} },
      viewBaselines: { restore: (value) => value, clear() {} },
      viewSync: { open() {}, close() {}, ready: async () => {}, request: async () => {} },
      waitForCredential: async () => {},
      ensureClientRegistration: async () => {},
      wsUrl: () => 'ws://relay/ws',
      scheduleReconnect() {},
      resetApprovalAndAsk() {},
      resetDeltaState() {},
      refreshBroadcastLanes() {},
      clearWakePongTimer() {},
      wakeProbe() {},
      requestResync: () => {
        resyncs += 1;
      },
    };
    dispatch.installRemoteDispatch(ctx);
    calls.installRemoteCalls(ctx);
    socket.installRemoteSocket(ctx);

    /** Open one socket attempt to the end of its handshake (secure) or to
     *  `onopen` (legacy). Returns what a test needs to talk to that leg. */
    const dial = async ({ binaryFrames = false, remoteParity = false, browserParity = false, nativePush = false, ready = {} } = {}) => {
      const known = FakeSocket.instances.length;
      const connecting = ctx.connect();
      await until(() => FakeSocket.instances.length === known + 1, 'a socket attempt');
      const ws = FakeSocket.instances[known];
      ws.readyState = FakeSocket.OPEN;
      ws.onopen();
      const leg = { ws, server: null, connecting };
      if (!secure) {
        await connecting;
        leg.deliver = async (frame) => {
          ws.onmessage({ data: JSON.stringify(frame) });
          await settle();
        };
        return leg;
      }
      const challenge = { ...createRelayE2EEChallenge(), ...(binaryFrames ? { binaryFrames: 1 } : {}),
        ...(remoteParity ? { remoteParity: 1 } : {}),
        ...(browserParity ? { browserParity: 1 } : {}),
        ...(nativePush ? { nativePush: 1 } : {}),
      };
      ws.onmessage({ data: JSON.stringify(challenge) });
      await until(() => ws.sent.length === 1, 'the client hello');
      leg.challenge = challenge;
      leg.server = await acceptRelayE2EEClientHello(identity, challenge, JSON.parse(ws.sent[0]));
      leg.deliver = async (frame) => {
        ws.onmessage({ data: await leg.server.encryptJson(frame) });
        await settle();
      };
      await leg.deliver({ type: 'e2ee-ready', version: 1, ...ready });
      await connecting;
      // What the shim sent after the handshake, decrypted by the desktop side
      // in wire order (the channel enforces it).
      let cursor = 1;
      leg.nextPayload = async () => {
        await until(() => ws.sent.length > cursor, 'the next frame on the wire');
        return leg.server.decryptJson(ws.sent[cursor++]);
      };
      return leg;
    };

    return await run({
      ctx,
      events,
      timers,
      dial,
      resyncs: () => resyncs,
      /** The 20-second per-call deadlines currently armed. */
      deadlines: () => [...timers.live.values()].filter((timer) => timer.ms === 20_000).length,
      toasts: () => events.filter((event) => event.type === 'mixdog:desktop-toast').map((event) => event.detail.text),
    });
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
};
