import assert from 'node:assert/strict';
import test from 'node:test';
import { registerComputerPixels } from './computer-pixels.ts';
import { createComputerSwitch, registerComputerScopes } from './computer-scope.ts';
import { HostRpcError } from './connection.ts';

/** A connection that serves its handlers in-process and can be closed. */
function connection() {
  const handlers = new Map();
  const closers = [];
  const pushed = [];
  return {
    pushed,
    notify: (method, params) => pushed.push([method, params.report]),
    handleRequest: (method, run) => handlers.set(method, run),
    onClose: (listener) => closers.push(listener),
    serve: (method, params, signal = new AbortController().signal) => handlers.get(method)(params, signal),
    close: () =>
      closers.forEach((listener) => {
        listener();
      }),
  };
}

/** A promise and its resolver: the barrier a capture waits on. */
function barrier() {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { open, opened };
}

const image = {
  getSize: () => ({ width: 10, height: 10 }),
  isEmpty: () => false,
  toJPEG: () => Buffer.from('jpeg'),
  toPNG: () => Buffer.from('png'),
  resize: () => image,
};
const display = {
  id: '1',
  index: 0,
  primary: true,
  geometry: { x: 0, y: 0, width: 10, height: 10 },
  scaleFactor: 1,
  pixelSize: { width: 10, height: 10 },
};
const ask = {
  target: { kind: 'display' },
  backend: 'screen',
  maxWidth: 10,
  format: 'jpeg',
  quality: 60,
  automationScope: 7,
};
const refused = (error) =>
  error instanceof HostRpcError && error.code === -32000 && /computer use is unavailable/.test(error.message);

/** Pixels whose capture holds until the test opens it; each capture is counted. */
function heldPixels() {
  const entered = barrier();
  const release = barrier();
  const sources = {
    captures: 0,
    displays: () => [display],
    ownedWindow: () => null,
    displayPixels: async () => {
      sources.captures++;
      entered.open();
      await release.opened;
      return image;
    },
    windowPixels: async () => image,
    screenAccess: () => undefined,
  };
  return { sources, entered, release };
}

test('a capture whose scope is revoked while it is taken returns no pixels', async () => {
  const wire = connection();
  const scopes = registerComputerScopes(wire, createComputerSwitch(true));
  const { sources, entered, release } = heldPixels();
  const uploads = [];
  registerComputerPixels(wire, {
    sources,
    scopes,
    callCore: async (_method, params) => {
      uploads.push(params);
      return {};
    },
  });
  const capture = wire.serve('host/computer/pixels', ask);
  await entered.opened;
  assert.deepEqual(await wire.serve('host/computer/revokeScopes', { scopes: [7] }), {
    revoked: 1,
    reports: [
      { scope: 7, revision: 1, admission: 'closed', unfinished_at_closure: 0, unfinished: 0, cleanup: 'complete' },
    ],
  });
  release.open();
  await assert.rejects(capture, refused);
  assert.equal(uploads.length, 0, 'nothing was uploaded');
  await assert.rejects(wire.serve('host/computer/pixels', ask), refused);
  assert.equal(sources.captures, 1, 'no capture after the revocation');
});

test('Computer Use switched off refuses every scope, and an old scope stays revoked when it is switched on again', async () => {
  const wire = connection();
  const computerSwitch = createComputerSwitch(true);
  const scopes = registerComputerScopes(wire, computerSwitch);
  const old = scopes.admit({ automationScope: 1 });
  computerSwitch.set(false);
  assert.throws(() => old.commit(), refused);
  assert.ok(old.signal.aborted);
  assert.throws(() => scopes.admit({ automationScope: 2 }), refused);
  computerSwitch.set(true);
  assert.throws(() => scopes.admit({ automationScope: 1 }), refused, 'the old scope stays revoked');
  assert.throws(() => scopes.admit({ automationScope: 2 }), refused, 'first seen while off: born revoked');
  scopes.admit({ automationScope: 3 }).commit();
  scopes.admit({}).commit();
});

test('a scope first named by its revocation never runs, and a closed connection revokes its scopes', async () => {
  const wire = connection();
  const scopes = registerComputerScopes(wire, createComputerSwitch(true));
  // A scope this connection never served (its work, if any, went to another connection) is revoked and not reported: nothing
  // complete is said of work this connection cannot have seen.
  const served = scopes.admit({ automationScope: 8 });
  const answer = await wire.serve('host/computer/revokeScopes', { scopes: [8, 9] });
  assert.deepEqual(
    answer.reports.map((report) => report.scope),
    [8]
  );
  assert.deepEqual(
    wire.pushed.map(([, report]) => report.scope),
    [8]
  );
  assert.throws(() => served.commit(), refused);
  assert.throws(() => scopes.admit({ automationScope: 9 }), refused);
  const held = scopes.admit({ automationScope: 10 });
  wire.close();
  assert.throws(() => held.commit(), refused);
  await assert.rejects(wire.serve('host/computer/revokeScopes', { scopes: ['x'] }), (error) => error.code === -32602);
});

test('each revocation reports its scope: the first closure snapshot of the calls outstanding is kept, never a fabricated zero', async () => {
  const wire = connection();
  const scopes = registerComputerScopes(wire, createComputerSwitch(true));
  const context = scopes.admit({ automationScope: 4 });
  const reply = barrier();
  context.track(reply.opened);
  const [first] = (await wire.serve('host/computer/revokeScopes', { scopes: [4] })).reports;
  assert.deepEqual(first, {
    scope: 4,
    revision: 1,
    admission: 'closed',
    unfinished_at_closure: 1,
    unfinished: 1,
    cleanup: 'pending',
  });
  assert.throws(() => context.commit(), refused, 'admission closed while the call is still out');
  reply.open();
  await reply.opened;
  await new Promise((resolve) => setImmediate(resolve));
  const [second] = (await wire.serve('host/computer/revokeScopes', { scopes: [4] })).reports;
  assert.deepEqual(second, {
    scope: 4,
    revision: 2,
    admission: 'closed',
    unfinished_at_closure: 1,
    unfinished: 0,
    cleanup: 'complete',
  });
});

test('a revoked scope pushes each change of its report, in revision order, and nothing after its connection closed', async () => {
  const wire = connection();
  const scopes = registerComputerScopes(wire, createComputerSwitch(true));
  const context = scopes.admit({ automationScope: 11 });
  const first = barrier();
  const second = barrier();
  context.track(first.opened);
  context.track(second.opened);
  const [snapshot] = (await wire.serve('host/computer/revokeScopes', { scopes: [11] })).reports;
  assert.deepEqual(
    wire.pushed,
    [['host/computer/scopeReport', snapshot]],
    'the snapshot is pushed before it is answered'
  );
  first.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(wire.pushed.at(-1), [
    'host/computer/scopeReport',
    { scope: 11, revision: 2, admission: 'closed', unfinished_at_closure: 2, unfinished: 1, cleanup: 'pending' },
  ]);
  wire.close();
  second.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    wire.pushed.length,
    2,
    'a closed connection reports nothing more: the core reads its end as unconfirmed'
  );
});
