import assert from 'node:assert/strict';
import test, { after } from 'node:test';

const hadWindow = 'window' in globalThis;
globalThis.window ??= globalThis;
after(() => {
  if (!hadWindow) delete globalThis.window;
});
const { installRemoteCalls } = await import('./remote-shim-calls.ts');

// The phone-side failure behind "mixdog remote call timed out." on a side
// editor's first open: the read waited in this page's ordered E2EE send queue
// (behind dozens of transcript link checks while Monaco loaded) past the call
// deadline, and the desktop answered it in about a millisecond once sent.
function harness() {
  const sent = [];
  const probes = [];
  let release = () => {};
  const encrypted = new Promise((resolve) => {
    release = () => resolve('box');
  });
  const ws = { send: (frame) => sent.push(frame), close() {} };
  const ctx = {
    nextId: 1,
    pending: new Map(),
    e2eePairing: true,
    connectionReady: true,
    relayBinaryFrames: false,
    socket: ws,
    secureChannel: { encryptJson: () => encrypted },
    limits: { refuseOversize() {}, noteSentFrame() {} },
    wakeProbe: () => probes.push('probe'),
    connect: async () => ws,
  };
  installRemoteCalls(ctx);
  return { ctx, sent, probes, release: () => release() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a request queued behind a frozen page is not failed once it reaches the wire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, sent, probes, release } = harness();
  let settled = null;
  const read = ctx.invoke('readProjectFile', ['C:/p', 'biome.json', null]).then(
    (value) => (settled = { value }),
    (error) => (settled = { error })
  );
  await flush();
  // The main thread was blocked for 25 s (Monaco evaluating): the send-phase
  // deadline runs 5 s late and grants its grace instead of failing.
  t.mock.timers.setTime(25_000);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(settled, null, 'a deadline that fired late waits out a grace');
  assert.deepEqual(sent, []);

  release();
  await flush();
  assert.deepEqual(sent, ['box']);
  // On the wire the network deadline restarts: the old grace is gone.
  t.mock.timers.tick(19_000);
  await flush();
  assert.equal(settled, null);
  ctx.pending.get(1).resolve({ content: '{}' });
  await read;
  assert.deepEqual(settled, { value: { content: '{}' } });
  assert.deepEqual(probes, []);
});

test('a frame that can never be sent fails the call and probes the connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, sent, probes, release } = harness();
  let settled = null;
  const read = ctx.invoke('readProjectFile', ['C:/p', 'biome.json', null]).then(
    (value) => (settled = { value }),
    (error) => (settled = { error })
  );
  await flush();
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(settled, null);
  t.mock.timers.tick(1);
  await read;
  assert.equal(settled.error?.message, 'mixdog remote call timed out.');
  assert.equal(ctx.pending.size, 0);
  assert.deepEqual(probes, ['probe']);
  // A send that completes after the failure arms nothing new.
  release();
  await flush();
  assert.deepEqual(sent, ['box']);
  t.mock.timers.tick(60_000);
  assert.deepEqual(probes, ['probe']);
});

test('a request on the wire still fails on its own deadline and probes the connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, sent, probes, release } = harness();
  release();
  let settled = null;
  const read = ctx.invoke('readProjectFile', ['C:/p', 'biome.json', null]).then(
    (value) => (settled = { value }),
    (error) => (settled = { error })
  );
  await flush();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(settled, null);
  t.mock.timers.tick(1);
  await read;
  assert.equal(settled.error?.message, 'mixdog remote call timed out.');
  assert.equal(ctx.pending.size, 0);
  assert.deepEqual(probes, ['probe']);
});
