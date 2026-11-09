// The phone's world, for recording Node and replaying the protocol client: a virtual timer queue (due time, then registration order, one
// callback at a time, microtasks drained between callbacks), a browser surface (window, document, localStorage, WebSocket, fetch), and the
// desktop's end of the relay socket with a REAL E2EE handshake. The same scenario script drives either product; only the desktop's
// dialect differs (Node call frames, or JSON-RPC), and each dialect reduces what it received to the same "what the core knows" record.
//
// Nothing waits on wall-clock time: the product's timers run when the script advances the virtual clock, and every wait is on an event
// the product itself produces (a socket created, a state change, a frame reduced).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const importFrom = (tree, rel) => import(pathToFileURL(join(tree, rel)).href);

export async function createPhoneWorld({ tree, dialect, random = () => 0.5, paired = true, registration = 200, hidden = false }) {
  const E2EE = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
  const Recovery = await importFrom(tree, 'apps/desktop/src/renderer/remote-pairing-recovery.ts');
  const identity = await E2EE.generateRelayE2EEServerIdentity();
  const material = E2EE.relayE2EEPairingMaterial(identity);
  const deviceId = '0123456789abcdef0123456789abcdef';
  const origin = 'https://relay.test';
  const keys = Recovery.remotePairingKeys(origin, deviceId);
  const store = new Map([
    [keys.token, 'a'.repeat(64)],
    [keys.e2eePublicKey, material.serverPublicKey],
    [keys.e2eeSecret, material.pairingSecret],
    [keys.browserId, 'browser-1'],
    [keys.server, origin],
    ['mixdog.directBrowser', '1'],
    ...(paired ? [[keys.paired, '1']] : []),
  ]);

  const legs = new Map();
  const accepted = new Set();
  // The product's crypto and the desktop's end run on real asynchronous work (Web Crypto resolves on the thread pool), which no microtask
  // count bounds. Every Web Crypto call is counted from its start to its settlement, and settled means: no call in flight, the desktop's
  // frame queue empty, and a whole turn of the event loop (`setImmediate` runs after every microtask the last completion queued) in which
  // neither started anything. There is no sleep and no wall-clock quantum: a completion is what ends the wait.
  let cryptoInFlight = 0;
  let cryptoDone = () => {};
  const subtle = globalThis.crypto.subtle;
  const subtleProto = Object.getPrototypeOf(subtle);
  for (const name of Object.getOwnPropertyNames(subtleProto)) {
    const original = subtleProto[name];
    if (name === 'constructor' || typeof original !== 'function') continue;
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value: (...callArgs) => {
        cryptoInFlight += 1;
        const settled = () => {
          cryptoInFlight -= 1;
          cryptoDone();
        };
        const result = original.apply(subtle, callArgs);
        result.then(settled, settled);
        return result;
      },
    });
  }
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const settle = async () => {
    for (;;) {
      await turn();
      if (cryptoInFlight > 0) {
        await new Promise((resolve) => (cryptoDone = resolve));
        continue;
      }
      const queues = [...legs.values()].map((leg) => leg.queue);
      await Promise.all(queues);
      await turn();
      if (cryptoInFlight === 0 && [...legs.values()].every((leg, i) => leg.queue === queues[i])) return;
    }
  };

  // ── time ──
  const clock = { now: 1_000_000, seq: 0, timers: new Map() };
  const add = (fn, ms, every) => {
    const id = ++clock.seq;
    clock.timers.set(id, { id, fn, due: clock.now + Math.max(0, ms || 0), seq: id, every });
    return id;
  };
  const timerApi = {
    setTimeout: (fn, ms) => add(fn, ms),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => void clock.timers.delete(id),
    clearInterval: (id) => void clock.timers.delete(id),
  };
  const advance = async (ms) => {
    const target = clock.now + ms;
    await settle();
    for (;;) {
      let next;
      for (const timer of clock.timers.values()) {
        if (timer.due <= target && (!next || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq))) next = timer;
      }
      if (!next) break;
      clock.now = Math.max(clock.now, next.due);
      if (next.every) {
        next.due += next.every;
        next.seq = ++clock.seq;
      } else clock.timers.delete(next.id);
      next.fn();
      await settle();
    }
    clock.now = target;
    await settle();
  };

  // ── what happened ──
  const events = [];
  const waiters = [];
  const log = (entry) => {
    events.push({ at: clock.now, ...entry });
    for (const w of [...waiters]) if (w.pred(events.at(-1), events.length - 1)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  const waitFor = (pred, from = 0) =>
    new Promise((resolve) => {
      for (let i = from; i < events.length; i += 1) if (pred(events[i], i)) return resolve();
      waiters.push({ pred: (e, i) => i >= from && pred(e, i), resolve });
    });

  const until = (cond) =>
    new Promise((resolve) => {
      if (cond()) resolve();
      else waiters.push({ pred: () => cond(), resolve });
    });

  // ── browser surface ──
  const window = new EventTarget();
  const document = new EventTarget();
  Object.assign(document, {
    visibilityState: hidden ? 'hidden' : 'visible',
    cookie: '',
    body: null,
    documentElement: { dataset: {} },
    getElementById: () => null,
  });
  const location = { origin, host: 'relay.test', protocol: 'https:', pathname: `/d/${deviceId}/`, search: '', hash: '', assign() {} };
  Object.assign(window, {
    Event,
    CustomEvent,
    document,
    location,
    innerHeight: 800,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => timerApi.setTimeout(fn, 16),
    ...timerApi,
  });
  window.window = window;
  window.addEventListener('mixdog:remote-connection-state', () => {
    const data = document.documentElement.dataset;
    log({ ev: 'state', state: data.mixdogRemoteConnection ?? null, desktop: data.mixdogRemoteDesktop ?? null });
  });
  window.addEventListener('mixdog:remote-pairing-invalid', (event) => log({ ev: 'pairing-invalid', message: event.detail }));
  window.addEventListener('mixdog:remote-reconnected', () => log({ ev: 'reconnected' }));
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
  };
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      if (world.throwNext > 0) {
        world.throwNext -= 1;
        throw new Error('socket constructor refused');
      }
      this.url = url;
      this.readyState = 0;
      this.binaryType = '';
      this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      world.sockets.push(this);
      log({ ev: 'socket', n: world.sockets.length });
    }
    send(data) {
      world.legOf(this)?.fromPhone(data);
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      log({ ev: 'close', socket: world.sockets.indexOf(this) + 1, code: code ?? null, reason: reason ?? null });
    }
  }
  const globals = {
    window,
    document,
    location,
    localStorage,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36', platform: 'Android', language: 'en' },
    history: { replaceState() {} },
    WebSocket: FakeWebSocket,
    fetch: async (url, init) => {
      log({ ev: 'fetch', path: new URL(String(url)).pathname });
      return { ok: registration >= 200 && registration < 300, status: registration, json: async () => ({ clientId: 'browser-1', token: 'b'.repeat(64) }) };
    },
    ...timerApi,
    performance: { now: () => clock.now - 1_000_000, timeOrigin: 0 },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  Date.now = () => clock.now;
  window.performance = globalThis.performance;
  // The product reads Math.random for its redial spread: a script-controlled source.
  Math.random = () => random();

  // ── the desktop's end ──
  const world = {
    tree,
    E2EE,
    keys,
    store,
    sockets: [],
    /** How many of the next socket constructions throw (a browser that refuses to open one). */
    throwNext: 0,
    /** The desktop reads each hello but never answers it: a handshake that does not finish. */
    holdHello: false,
    events,
    advance,
    waitFor,
    until,
    mark: () => events.length,
    setRandom: (fn) => (random = fn),
    clock,
    legOf: (ws) => legs.get(ws),
    accepted: (ws) => accepted.has(ws),
    window,
    document,
    deviceId,
    setVisibility(state) {
      document.visibilityState = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    /** The next socket the product created that this world has not accepted yet: open it, challenge, handshake, ready. */
    async accept(flags = {}) {
      const ws = world.sockets.find((s) => !accepted.has(s));
      if (!ws) throw new Error('no socket to accept');
      accepted.add(ws);
      ws.readyState = 1;
      legs.set(ws, await world.leg(ws));
      ws.onopen?.();
      await world.handshake(ws, flags);
      return ws;
    },
    async leg(ws) {
      const leg = {
        ws,
        server: null,
        challenge: null,
        pings: 0,
        core: { foreground: null, browserId: null, screen: [], panels: [], view: [], lanes: [], resyncs: 0 },
        queue: Promise.resolve(),
        async toPhone(value) {
          ws.onmessage?.({ data: await leg.server.encryptJson(value) });
        },
        clear: (value) => ws.onmessage?.({ data: JSON.stringify(value) }),
        fromPhone(data) {
          if (data === '{"ping":1}') {
            leg.pings += 1;
            log({ ev: 'ping', socket: world.sockets.indexOf(ws) + 1 });
            return;
          }
          leg.queue = leg.queue.then(async () => {
            if (!leg.server && world.holdHello) {
              log({ ev: 'hello', socket: world.sockets.indexOf(ws) + 1 });
              return;
            }
            if (!leg.server) {
              leg.server = await E2EE.acceptRelayE2EEClientHello(identity, leg.challenge, JSON.parse(String(data)));
              await leg.toPhone({ type: 'e2ee-ready', version: 1, ...dialect.readyFields });
              return;
            }
            dialect.onFrame(leg, await leg.server.decryptJson(JSON.parse(String(data))), log);
            log({ ev: 'core' });
          });
        },
      };
      return leg;
    },
    /** A (new) challenge on this socket: the phone answers with its hello, the desktop answers `e2ee-ready`. */
    async handshake(ws, flags = {}) {
      const leg = legs.get(ws);
      leg.server = null;
      leg.challenge = { ...E2EE.createRelayE2EEChallenge(), ...flags };
      leg.core = { foreground: null, browserId: null, screen: [], panels: [], view: [], lanes: [], resyncs: 0 };
      ws.onmessage({ data: JSON.stringify(leg.challenge) });
    },
    peerClose(ws, code, reason = '') {
      ws.readyState = 3;
      legs.delete(ws);
      ws.onclose?.({ code, reason });
    },
    /** What the newest leg's core has been told. */
    core() {
      const leg = [...legs.values()].at(-1);
      return leg ? leg.core : null;
    },
    pongTo: (ws) => legs.get(ws).clear({ pong: 1 }),
    stray: (ws) => legs.get(ws).toPhone(dialect.stray),
  };
  return world;
}

/** The record both dialects reduce to: what the core knows of this phone. Foreground false hides the screen set (the core
 *  holds back pushes only for a thread a foreground phone is looking at). */
export const effectiveCore = (core) => ({
  foreground: core.foreground,
  screen: core.foreground ? [...core.screen].sort() : [],
  panels: [...core.panels].sort(),
  view: [...core.view].sort(),
  lanes: [...core.lanes].sort(),
  resyncs: core.resyncs,
});

/** Node's desktop: call frames `{id?, method, params}`; `synchronizeViews` is answered, and the report calls set what the core knows. */
export const nodeDialect = {
  readyFields: {
    viewSync: 1,
    hostName: 'Test PC',
    remoteOpenAccess: 1,
    uplinkCapacityBytes: 8_000_000,
    uplinkBinaryCeilingBytes: 4_000_000,
    uplinkTextCeilingBytes: 4_000_000,
  },
  /** Calls the script leaves unanswered, to see how a lost connection fails them. */
  unanswered: new Set(['deleteSession']),
  /** A reply to nothing the phone asked: traffic that proves a leg is delivering, whatever it carries. */
  stray: { id: 424242, ok: true, value: null },
  onFrame(leg, frame, log) {
    const [a] = frame.params ?? [];
    if (frame.method === 'setForeground') {
      leg.core.foreground = a;
      leg.core.browserId = frame.params[1];
    } else if (frame.method === 'setScreenSessions') leg.core.screen = a;
    else if (frame.method === 'setVisualizePanels') leg.core.panels = a;
    else if (frame.method === 'setRemoteLanes') leg.core.lanes = a;
    else if (frame.method === 'setVisibleSessions') leg.core.view = a;
    else if (frame.method === 'synchronizeViews') {
      // Synchronizing the view that is already held is a resync request (view-sync peers resync by synchronizing again); a different set is the page changing its view.
      if (leg.core.synced && JSON.stringify([...a].sort()) === JSON.stringify([...leg.core.view].sort())) {
        leg.core.resyncs += 1;
        log({ ev: 'resync' });
      }
      leg.core.synced = true;
      leg.core.view = a;
    }
    else if (frame.method === 'stateResync') {
      leg.core.resyncs += 1;
      log({ ev: 'resync' });
    }
    if (frame.id !== undefined && !this.unanswered.has(frame.method)) {
      void leg.toPhone({ id: frame.id, ok: true, value: frame.method === 'synchronizeViews' ? {} : null });
    }
  },
};

/** The protocol core's end for the phone client. */
export function protocolDialect(initializeResult) {
  const subscription = { id: 's', mode: 'snapshot', epoch: 'e', startSeq: 1 };
  return {
    // A server request the client does not know: it answers it and carries on (a response to nothing would end the connection).
    stray: { id: 'stray-1', method: 'test/unknown', params: {} },
    readyFields: { hostName: 'Test PC', remoteOpenAccess: 1 },
    onFrame(leg, frame, log) {
      const reply = (result) => void leg.toPhone({ id: frame.id, result });
      switch (frame.method) {
        case 'initialize':
          return reply(initializeResult);
        case 'app/subscribe':
          // The app feed is attached once per leg; asking again is the protocol's state resync (Node's stateResync).
          if (leg.core.appAttached) {
            leg.core.resyncs += 1;
            log({ ev: 'resync' });
          }
          leg.core.appAttached = true;
          return reply({ subscription });
        case 'thread/resume':
          leg.core.view = [...new Set([...leg.core.view, frame.params.threadId])];
          return reply({ thread: { id: frame.params.threadId }, subscription });
        case 'thread/unsubscribe':
          leg.core.view = leg.core.view.filter((id) => id !== frame.params.threadId);
          return reply({});
        case 'feed/subscribe':
          // The script's in-flight call (a call that the core never answers).
          if (frame.params.feedId === 'pending-call') return undefined;
          leg.core.lanes = [...new Set([...leg.core.lanes, frame.params.feedId.replace(/^feed:/u, '')])];
          return reply({});
        case 'feed/unsubscribe':
          leg.core.lanes = leg.core.lanes.filter((l) => l !== frame.params.feedId.replace(/^feed:/u, ''));
          return reply({});
        case 'ui/screenSessions/changed':
          leg.core.foreground = frame.params.foreground;
          leg.core.browserId = frame.params.browserId ?? leg.core.browserId;
          leg.core.screen = frame.params.sessionIds;
          leg.core.panels = frame.params.visualizeSessionIds ?? [];
          return undefined;
        default:
          return undefined;
      }
    },
  };
}
