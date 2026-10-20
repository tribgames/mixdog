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
  await flush();
  assert.equal(settled, null, 'the probe decides first');
  assert.deepEqual(probes, ['probe']);
  t.mock.timers.tick(5_000);
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

// A burst of calls released at once (the app's reads waiting on a view sync)
// must stay inside the desktop's per-browser frame budget: past it, the PC
// drops the whole connection ("remote client backlog exceeded").
const { REMOTE_CLIENT_CALL_WINDOW, REMOTE_CLIENT_PENDING_FRAMES, REMOTE_CLIENT_PRIORITY_RESERVE } = await import(
  '../shared/remote-frame-budget.ts'
);
const ORDINARY_LIMIT = REMOTE_CLIENT_CALL_WINDOW - REMOTE_CLIENT_PRIORITY_RESERVE;

/** A shim whose frames reach a fake PC: `sent` is the wire, `answer(id)` is
 *  the PC's reply arriving (what the dispatcher does with a response frame),
 *  and `outstanding()` counts what the PC still owes — sent and unanswered,
 *  whatever this page did with the caller in between. */
function windowHarness() {
  const sent = [];
  const answered = new Set();
  const ws = { send: (frame) => sent.push(frame), close() {} };
  const ctx = {
    nextId: 1,
    pending: new Map(),
    e2eePairing: true,
    connectionReady: true,
    relayBinaryFrames: false,
    socket: ws,
    secureChannel: { encryptJson: async (payload) => payload },
    limits: { refuseOversize() {}, noteSentFrame() {} },
    probes: 0,
    // The relay answers every liveness probe: nothing ever retires the leg.
    wakeProbe() {
      ctx.probes += 1;
    },
    connect: async () => ws,
  };
  installRemoteCalls(ctx);
  const answer = (id, value = id) => {
    answered.add(id);
    ctx.settleCallCredit(id);
    const entry = ctx.pending.get(id);
    if (!entry) return;
    ctx.pending.delete(id);
    entry.resolve(value);
  };
  const outstanding = () => sent.filter((frame) => !answered.has(frame.id)).length;
  return { ctx, ws, sent, answer, outstanding };
}

test('the call window stays inside the desktop budget', () => {
  assert.ok(REMOTE_CLIENT_CALL_WINDOW < REMOTE_CLIENT_PENDING_FRAMES);
  assert.ok(REMOTE_CLIENT_PRIORITY_RESERVE > 0 && REMOTE_CLIENT_PRIORITY_RESERVE < REMOTE_CLIENT_CALL_WINDOW);
});

// The local deadline fails the CALLER; the PC still holds the frame in its
// queue. Freeing the credit there let a stalled PC accumulate more than the
// window, one deadline cycle at a time, and brought the eviction loop back.
test('a call that timed out keeps its credit until the PC answers it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, sent, answer, outstanding } = windowHarness();
  const settle = (promise) => promise.catch((error) => error);
  const calls = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    // The app keeps asking while the PC's work stays blocked.
    for (let index = 0; index < ORDINARY_LIMIT; index += 1) {
      calls.push(settle(ctx.invoke('statProjectFile', [cycle, index])));
    }
    await flush();
    assert.ok(outstanding() <= REMOTE_CLIENT_CALL_WINDOW, `cycle ${cycle}: ${outstanding()} outstanding`);
    assert.equal(outstanding(), ORDINARY_LIMIT);
    // The deadline probes the leg; the probe window then fails the callers.
    t.mock.timers.tick(20_000);
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
  }
  assert.ok(ctx.probes > 0, 'the deadlines fired and probed a leg that answers its probes');
  assert.equal(sent.length, ORDINARY_LIMIT, 'no deadline freed a credit');
  const first = await calls[0];
  assert.equal(first.message, 'mixdog remote call timed out.');

  // The PC finally answers one of the timed-out calls: exactly one more leaves.
  answer(sent[0].id);
  await flush();
  assert.equal(sent.length, ORDINARY_LIMIT + 1);
  assert.deepEqual(sent.at(-1).params, [1, 0], 'the oldest waiting call takes the credit');
  assert.equal(outstanding(), ORDINARY_LIMIT);
  for (const frame of [...sent]) answer(frame.id);
  t.mock.timers.tick(20_000);
});

test('a retired connection returns every credit its calls held', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, ws, sent } = windowHarness();
  const calls = Array.from({ length: ORDINARY_LIMIT + 3 }, (_, index) =>
    ctx.invoke('statProjectFile', [index]).catch((error) => error)
  );
  await flush();
  assert.equal(sent.length, ORDINARY_LIMIT);
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(sent.length, ORDINARY_LIMIT);
  ctx.retireCallCredits(ws);
  await flush();
  assert.equal(sent.length, ORDINARY_LIMIT + 3);
  for (const [id, entry] of [...ctx.pending]) {
    ctx.pending.delete(id);
    entry.resolve(id);
  }
  await Promise.all(calls);
});

// Ordinary reads stop at the reserve; priority calls fill it and jump the
// queue, in their own order, but the total never passes the window.
test('ordinary and priority calls together never pass the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, sent, answer, outstanding } = windowHarness();
  const calls = [];
  const track = (method, params) => {
    calls.push(ctx.invoke(method, params).catch((error) => error));
  };
  for (let index = 0; index < REMOTE_CLIENT_CALL_WINDOW; index += 1) track('statProjectFile', [index]);
  await flush();
  assert.equal(outstanding(), ORDINARY_LIMIT, 'ordinary calls leave the reserve free');
  const aborts = REMOTE_CLIENT_PRIORITY_RESERVE + 2;
  for (let index = 0; index < aborts; index += 1) track('abortSession', [`s${index}`]);
  track('synchronizeViews', [[]]);
  track('resolveToolApprovalForSession', ['s0']);
  await flush();
  assert.equal(outstanding(), REMOTE_CLIENT_CALL_WINDOW, 'priority calls fill the reserve and no more');
  assert.equal(sent.at(-1).method, 'abortSession');

  // Credits free one by one: the queued priority calls go first, in order —
  // the sync is never held behind a later approval or the ordinary reads.
  const ordinary = sent.filter((frame) => frame.method === 'statProjectFile');
  for (let step = 0; step < 4; step += 1) {
    answer(ordinary[step].id);
    await flush();
    assert.ok(outstanding() <= REMOTE_CLIENT_CALL_WINDOW, `${outstanding()} outstanding`);
  }
  assert.deepEqual(
    sent.slice(REMOTE_CLIENT_CALL_WINDOW).map((frame) => frame.method),
    ['abortSession', 'abortSession', 'synchronizeViews', 'resolveToolApprovalForSession']
  );
  // Drain: every round the PC answers what it holds; the waiting reads follow
  // and the ceiling holds throughout.
  while (outstanding() > 0) {
    for (const frame of [...sent]) answer(frame.id);
    await flush();
    assert.ok(outstanding() <= REMOTE_CLIENT_CALL_WINDOW, `${outstanding()} outstanding`);
  }
  await Promise.all(calls);
  assert.equal(sent.filter((frame) => frame.method === 'statProjectFile').length, REMOTE_CLIENT_CALL_WINDOW);
});

// The phone report: the leg died silently, the socket still read as open, and
// every call waited its full deadline. Silence after a send probes at once.
test('a call met by silence probes the leg early; any arriving frame proves it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ctx, probes, release } = harness();
  // The mocked clock starts at 0: the last frame arrived before it.
  Object.assign(ctx, { wakePongTimer: null, lastTrafficAt: -1 });
  release();
  const silent = ctx.invoke('readActivityRailPins', []).catch((error) => error);
  await flush();
  t.mock.timers.tick(4_999);
  assert.deepEqual(probes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(probes, ['probe']);

  const heard = ctx.invoke('readSettings', []).catch((error) => error);
  await flush();
  ctx.lastTrafficAt = Date.now() + 1;
  t.mock.timers.tick(5_000);
  assert.deepEqual(probes, ['probe'], 'a frame since the send proves the leg');
  for (const [id, entry] of [...ctx.pending]) {
    ctx.pending.delete(id);
    entry.resolve(id);
  }
  await Promise.all([silent, heard]);
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
  await flush();
  assert.equal(settled, null, 'the probe decides first');
  t.mock.timers.tick(5_000);
  await read;
  assert.equal(settled.error?.message, 'mixdog remote call timed out.');
  assert.equal(ctx.pending.size, 0);
  assert.deepEqual(probes, ['probe']);
});
