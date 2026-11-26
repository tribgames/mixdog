// The page's lifecycle link while the first connection is still being dialed (phone-boot.ts `link`): the post-approval recovery
// (remote-shim-pairing.ts `verifyApprovedConnection`, `ctx.phone.recycle()`) wakes the dial through it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
  type RelayE2EEChannel,
} from '../../desktop/src/shared/remote-e2ee.ts';
import { REMOTE_WAKE_EVENT } from '../../desktop/src/renderer/remote-connection-state.ts';
import type { RemoteShimContext } from '../../desktop/src/renderer/remote-shim-state.ts';
import type { RelaySocket } from './relay-connector.ts';

const conformance = new URL('../../../packages/protocol-client/conformance/', import.meta.url);
const conformanceOptions = JSON.parse(readFileSync(new URL('options.json', conformance), 'utf8'));

type Listener = (event?: Event) => void;
const windowListeners = new Map<string, Set<Listener>>();
const documentListeners = new Map<string, Set<Listener>>();
const addListener = (map: Map<string, Set<Listener>>, type: string, fn: Listener): void => {
  let set = map.get(type);
  if (!set) {
    set = new Set();
    map.set(type, set);
  }
  set.add(fn);
};
const removeListener = (map: Map<string, Set<Listener>>, type: string, fn: Listener): void => {
  map.get(type)?.delete(fn);
};
const emit = (map: Map<string, Set<Listener>>, type: string): void => {
  const event = { type } as Event;
  for (const fn of [...(map.get(type) ?? [])]) fn(event);
};
const resetPage = (): void => {
  windowListeners.clear();
  documentListeners.clear();
  doc.visibilityState = 'visible';
  doc.documentElement.dataset = {};
};

const doc = {
  visibilityState: 'visible',
  addEventListener: (type: string, fn: Listener) => addListener(documentListeners, type, fn),
  removeEventListener: (type: string, fn: Listener) => removeListener(documentListeners, type, fn),
  documentElement: { dataset: {} as Record<string, string | undefined> },
  getElementById: () => null,
};
const page = globalThis as unknown as Record<string, unknown>;
page.window = {
  addEventListener: (type: string, fn: Listener) => addListener(windowListeners, type, fn),
  removeEventListener: (type: string, fn: Listener) => removeListener(windowListeners, type, fn),
  dispatchEvent: (event: { type: string }) => {
    emit(windowListeners, event.type);
    return true;
  },
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  Event: class {
    constructor(readonly type: string) {}
  },
};
page.document = doc;

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

type Identity = Awaited<ReturnType<typeof generateRelayE2EEServerIdentity>>;

function makeCtx(identity: Identity): RemoteShimContext {
  return {
    deviceId: 'dev',
    browserId: 'browser-1',
    serverBase: 'https://relay.invalid',
    currentToken: 'tok',
    e2eePairing: relayE2EEPairingMaterial(identity),
    pairingKeys: { paired: 'paired' },
    everPaired: true,
    everConnected: false,
    pendingReconnectNotification: false,
    connectionReady: false,
    approvalVerificationInFlight: false,
    backgroundSuspended: false,
    mediaSid: null,
    peerBrowserWebrtc: 0,
    peerBrowserFit: null,
    restoredVisibleSessionIds: [],
    lastScreenSessionIds: [],
    limits: { resetLearnedCaps() {}, learnRoutingCaps() {} },
    waitForCredential: async () => undefined,
    ensureClientRegistration: async () => undefined,
    wsUrl: () => 'wss://relay.invalid/d/dev',
  } as unknown as RemoteShimContext;
}

/** A plain-relay socket whose far end answers E2EE, `initialize`, and `app/subscribe`, and counts cleartext pings. */
function readyRelaySocket(identity: Identity, options: { autoPong?: boolean } = {}) {
  let server: RelayE2EEChannel | undefined;
  const challenge = createRelayE2EEChallenge();
  let pings = 0;
  const closes: Array<[number, string]> = [];
  let inbound: Promise<void> = Promise.resolve();
  const toPhone = async (value: unknown) => {
    ws.onmessage!({ data: await server!.encryptJson(value) });
  };
  const fromPhone = async (data: string | Uint8Array) => {
    if (!server) {
      server = await acceptRelayE2EEClientHello(identity, challenge, JSON.parse(String(data)));
      await toPhone({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() });
      return;
    }
    const msg = (await server.decryptJson(JSON.parse(String(data)))) as { id?: unknown; method?: string };
    if (msg.method === 'initialize') {
      await toPhone({ id: msg.id, result: conformanceOptions.initializeResult });
    } else if (msg.method === 'app/subscribe') {
      await toPhone({
        id: msg.id,
        result: { subscription: { id: 'app-sub', mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
      });
    } else if (msg.id !== undefined && msg.method !== 'initialized') {
      await toPhone({ id: msg.id, result: {} });
    }
  };
  const ws: RelaySocket = {
    binaryType: '',
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => {
      if (data === '{"ping":1}') {
        pings += 1;
        if (options.autoPong) ws.onmessage!({ data: JSON.stringify({ pong: 1 }) });
        return;
      }
      inbound = inbound.then(() => fromPhone(data));
    },
    close: (code = 1000, reason = '') => {
      closes.push([code, reason]);
    },
  };
  return {
    ws,
    closes,
    start: () =>
      queueMicrotask(() => {
        ws.onopen?.();
        ws.onmessage!({ data: JSON.stringify(challenge) });
      }),
    get pings() {
      return pings;
    },
    sendPong: () => ws.onmessage!({ data: JSON.stringify({ pong: 1 }) }),
  };
}

test('before the first connection the boot hands out the link being dialed, and its wake cuts the redial wait', async () => {
  resetPage();
  const { bootPhone } = await import('./phone-boot.ts');
  const identity = await generateRelayE2EEServerIdentity();
  let dials = 0;
  const dialed: Array<{ n: number; resolve(): void }> = [];
  const dial = (n: number) => new Promise<void>((resolve) => (dials >= n ? resolve() : dialed.push({ n, resolve })));
  const boot = bootPhone(makeCtx(identity), {
    version: '1.0.0',
    createSocket: () => {
      dials += 1;
      for (const waiter of dialed.filter((w) => w.n <= dials)) {
        dialed.splice(dialed.indexOf(waiter), 1);
        waiter.resolve();
      }
      return refusedSocket();
    },
    suspendApplies: () => false,
    visualizePanels: () => [],
    random: () => 0.5,
    updateRequired() {},
  });
  void boot.start().catch(() => undefined);
  const data = doc.documentElement.dataset;
  try {
    // The first redial of an outage leaves at once; the one after it waits out a backoff of hundreds of ms.
    await dial(2);
    assert.ok(boot.link, 'the link of the dial in progress');
    await new Promise((r) => setTimeout(r, 5));
    // The page's connection line counts down to that redial.
    assert.ok(Number(data.mixdogRemoteRedialAt) > Date.now(), 'the next redial time is published');
    boot.link.wake();
    await dial(3);
    assert.equal(data.mixdogRemoteRedialAt, undefined, 'a dial under way has no countdown');
  } finally {
    boot.resetPairing();
    resetPage();
  }
});

test('online, REMOTE_WAKE_EVENT, and post-hidden wake recycle a stuck dial immediately while plain focus does not', async () => {
  resetPage();
  const { bootPhone } = await import('./phone-boot.ts');
  const identity = await generateRelayE2EEServerIdentity();
  const sockets: Array<{ ws: RelaySocket; closes: unknown[][] }> = [];
  const dialed: Array<{ n: number; resolve(): void }> = [];
  const dial = (n: number) =>
    new Promise<void>((resolve) => (sockets.length >= n ? resolve() : dialed.push({ n, resolve })));
  const boot = bootPhone(makeCtx(identity), {
    version: '1.0.0',
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
      for (const waiter of dialed.filter((w) => w.n <= sockets.length)) {
        dialed.splice(dialed.indexOf(waiter), 1);
        waiter.resolve();
      }
      return ws;
    },
    suspendApplies: () => false,
    visualizePanels: () => [],
    random: () => 0.5,
    updateRequired() {},
  });
  void boot.start().catch(() => undefined);
  try {
    await dial(1);
    emit(windowListeners, 'focus');
    emit(windowListeners, 'pageshow');
    assert.deepEqual(sockets[0].closes, [], 'ordinary focus/pageshow does not interrupt a healthy first dial');
    assert.equal(sockets.length, 1);

    emit(windowListeners, 'online');
    assert.deepEqual(sockets[0].closes, [[4000, 'wake dial restarted']]);
    await dial(2);

    emit(windowListeners, REMOTE_WAKE_EVENT);
    assert.deepEqual(sockets[1].closes, [[4000, 'wake dial restarted']]);
    await dial(3);

    doc.visibilityState = 'hidden';
    emit(documentListeners, 'visibilitychange');
    doc.visibilityState = 'visible';
    emit(documentListeners, 'visibilitychange');
    assert.deepEqual(sockets[2].closes, [[4000, 'wake dial restarted']]);
    await dial(4);
  } finally {
    boot.resetPairing();
    resetPage();
  }
});

test('back-to-back visibilitychange, pageshow, and focus send one ping and keep the wakeTimer deadline', async (t) => {
  resetPage();
  const { bootPhone } = await import('./phone-boot.ts');
  const identity = await generateRelayE2EEServerIdentity();
  const far = readyRelaySocket(identity);
  const boot = bootPhone(makeCtx(identity), {
    version: conformanceOptions.clientInfo.version,
    createSocket: () => {
      far.start();
      return far.ws;
    },
    suspendApplies: () => false,
    visualizePanels: () => [],
    random: () => 0.5,
    updateRequired() {},
  });
  await boot.synced();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    doc.visibilityState = 'hidden';
    emit(documentListeners, 'visibilitychange');
    doc.visibilityState = 'visible';
    emit(documentListeners, 'visibilitychange');
    emit(windowListeners, 'pageshow');
    emit(windowListeners, 'focus');
    assert.equal(far.pings, 1, 'back-to-back wake events send only one ping');

    t.mock.timers.tick(1_500);
    emit(windowListeners, 'pageshow');
    emit(windowListeners, 'focus');
    assert.equal(far.pings, 1, 'later wake events while probe is in flight send no extra ping');
    assert.deepEqual(far.closes, []);

    t.mock.timers.tick(1_000);
    assert.deepEqual(far.closes.at(0), [4000, 'wake probe unanswered'], 'wakeTimer was not pushed back');
  } finally {
    t.mock.timers.reset();
    boot.resetPairing();
    resetPage();
  }
});

test('plain focus on an active, recently-trafficked connection skips redundant ping while silent focus and pageshow still probe', async (t) => {
  resetPage();
  const { bootPhone } = await import('./phone-boot.ts');
  const identity = await generateRelayE2EEServerIdentity();
  const far = readyRelaySocket(identity);
  let mono = 1_000;
  const boot = bootPhone(makeCtx(identity), {
    version: conformanceOptions.clientInfo.version,
    createSocket: () => {
      far.start();
      return far.ws;
    },
    suspendApplies: () => false,
    visualizePanels: () => [],
    now: () => mono,
    random: () => 0.5,
    updateRequired() {},
  });
  await boot.synced();
  const startWall = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: startWall });
  try {
    emit(windowListeners, 'focus');
    assert.equal(far.pings, 0, 'plain focus with recent traffic skips redundant ping');

    // A backward wall-clock jump does not suppress plain focus after real monotonic silence.
    t.mock.timers.setTime(startWall - 60_000);
    mono += 1_100;
    t.mock.timers.tick(1_100);
    emit(windowListeners, 'focus');
    assert.equal(far.pings, 1, 'plain focus after silence probes normally');

    far.sendPong();
    await new Promise((r) => setImmediate(r));

    emit(windowListeners, 'focus');
    assert.equal(far.pings, 1, 'plain focus right after pong traffic skips redundant ping');

    emit(windowListeners, 'pageshow');
    assert.equal(far.pings, 2, 'pageshow still probes normally');
  } finally {
    t.mock.timers.reset();
    boot.resetPairing();
    resetPage();
  }
});
