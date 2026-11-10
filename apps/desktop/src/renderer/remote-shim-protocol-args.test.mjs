// The page's arguments reach every adapter as Node's PC received them: Node's relay wrote each call's frame with JSON.stringify on the page
// and read it with JSON.parse on the PC (remote-shim-protocol.ts `relayed`), so the router applies that round trip, once, for calls and for
// fires alike, and nothing else.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router arms a per-call deadline on the page's window timers; nothing here waits for one.
globalThis.window ??= { setTimeout: () => 0, clearTimeout() {} };

/** A router over one adapter whose calls and fires report the arguments they were given. */
function routerSeeing() {
  const seen = [];
  const fired = [];
  let firedNext;
  const adapter = {
    group: 'probe',
    calls: {
      echo: (params) => (seen.push(params), null),
      // A coalesced read (Node's COALESCED_READS): identical reads share one request.
      readSettings: (params) => (seen.push(params), { settings: true }),
    },
    fires: {
      ping: (params) => {
        fired.push(params);
        firedNext?.();
      },
    },
  };
  const ready = Promise.resolve();
  const host = { ctx: {}, client: () => ({}), declareLane() {} };
  const router = createProtocolRouter([adapter], { host, started: () => ready, synced: () => ready, probe() {}, silentSince: () => false });
  const nextFire = () => new Promise((resolve) => (firedNext = resolve));
  return { router, seen, fired, nextFire };
}

// What the page passes when the app leaves things out or hands over values JSON cannot keep as they are.
const pageArguments = () => ['/repo', undefined, { kept: 1, gone: undefined, when: new Date(0), nested: [undefined, Number.NaN] }, -0, () => 1];

test('a call reaches its adapter with the arguments as the relay\'s JSON carried them', async () => {
  const { router, seen } = routerSeeing();
  await router.call('echo', pageArguments());
  assert.deepEqual(seen, [JSON.parse(JSON.stringify(pageArguments()))]);
  // The array's undefined is null, the object's undefined property is gone, as the PC's parse made them.
  assert.equal(seen[0][1], null);
  assert.equal(Object.hasOwn(seen[0][2], 'gone'), false);
});

test('a fire reaches its adapter with the arguments as the relay\'s JSON carried them', async () => {
  const { router, fired, nextFire } = routerSeeing();
  const reached = nextFire();
  router.fire('ping', pageArguments());
  await reached;
  assert.deepEqual(fired, [JSON.parse(JSON.stringify(pageArguments()))]);
});

test('a call whose arguments JSON cannot write fails without reaching its adapter, and such a fire is dropped', async () => {
  const { router, seen, fired } = routerSeeing();
  await assert.rejects(router.call('echo', [1n]), TypeError);
  assert.doesNotThrow(() => router.fire('ping', [1n]));
  assert.deepEqual([seen, fired], [[], []]);
});

test('identical coalesced reads still share one request: the read key is the same before and after the relay\'s JSON', async () => {
  const { router, seen } = routerSeeing();
  // Node's key was JSON.stringify of the page's arguments (remote-shim-calls.ts coalescedReadKey): `[undefined]` and `[null]` are one key.
  const first = router.call('readSettings', [undefined]);
  const second = router.call('readSettings', [null]);
  assert.equal(second, first);
  assert.deepEqual(await first, { settings: true });
  assert.deepEqual(seen, [[null]]);
});
