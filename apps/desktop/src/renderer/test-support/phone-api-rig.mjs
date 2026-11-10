// The phone's DesktopApi table over the protocol router, with the adapter and the connection stood in by the test: the real
// `createRemoteApi` (remote-shim-api.ts) and the real `createProtocolRouter` (remote-shim-protocol.ts) over a real shim context, wired the
// way `createPhoneApi` wires them (remote-shim-phone.ts). The test's `adapter` is the group that owns the names (PH-2's
// `remote-protocol-<group>.ts` in the product); `calls` records what reached it, in order -- the phone's counterpart of what Node's tests read
// off the fake socket. The connection is always up and synced; the lifecycle against a core is replayed by remote-shim-lifecycle.slow.test.mjs.
import { createProtocolRouter } from '../remote-shim-protocol.ts';
import { createRemoteApi } from '../remote-shim-api.ts';
import { createRemoteShimContext } from '../remote-shim-state.ts';

const GLOBALS = ['window', 'document', 'localStorage', 'location'];

/** Runs `run` against a phone API whose adapter holds `handlers` (Node method name -> `(params) => result`), registered as calls and fires.
 *  `synced` replaces the view sync the router's gated calls wait for (default: already synced). */
export async function withPhoneApi(handlers, run, { synced } = {}) {
  const saved = GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, Event, CustomEvent }));
  define('document', { visibilityState: 'visible', cookie: '', documentElement: { dataset: {} }, getElementById: () => null });
  define('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  define('location', { origin: 'https://relay.test', pathname: '/', href: 'https://relay.test/' });
  try {
    const ctx = createRemoteShimContext();
    const calls = [];
    const record = (method) => (params) => {
      calls.push({ method, params });
      return handlers[method](params);
    };
    const adapter = {
      group: 'test',
      calls: Object.fromEntries(Object.keys(handlers).map((method) => [method, record(method)])),
      fires: Object.fromEntries(Object.keys(handlers).map((method) => [method, record(method)])),
    };
    const ready = Promise.resolve();
    const router = createProtocolRouter([adapter], {
      host: { ctx, client: () => { throw new Error('the test adapter does not reach a core'); }, declareLane() {} },
      started: () => ready,
      synced: synced ?? (() => ready),
      probe() {},
      silentSince: () => false,
          });
    const fanOut = (listeners, value) => {
      for (const listener of [...listeners]) listener(value);
    };
    Object.assign(ctx, {
      phone: { start: () => ready, synced: () => ready },
      fanOut,
      connect: () => ready,
      invoke: router.call,
      call: router.call,
      readCatalog: (_catalog, method) => router.call(method, []),
      fire: router.fire,
      // The lanes the page asks the core to push, as the phone's laneSubscription registers them (remote-shim-phone.ts).
      laneSubscription: (lane, listeners, listener) => {
        listeners.add(listener);
        if (listeners.size === 1) ctx.activeLanes.add(lane);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) ctx.activeLanes.delete(lane);
        };
      },
    });
    router.install();
    return await run({ ctx, api: createRemoteApi(ctx), calls });
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

/** Lets the router's asynchronous hand-over (connection, then sync) finish. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));