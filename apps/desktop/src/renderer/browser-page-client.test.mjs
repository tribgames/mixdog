import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageClient } from './browser-page-client.ts';

const frame = (documentId = 'p1:1') => ({
  documentId, frameId: documentId, webContentsId: 1, url: 'https://example.test',
  title: 'Page', loading: false, canGoBack: false, canGoForward: false, width: 800, height: 600,
  viewportWidth: 800, viewportHeight: 600,
});

test('new frame coordinates are published only after decoding without holding up input to the visible frame', async () => {
  let latest = frame();
  let finish;
  const decoded = new Promise(resolve => { finish = resolve; });
  const updates = [];
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 'owner', failure: error => assert.fail(error),
    update: next => updates.push(next),
    prepare: async next => { if (next.documentId === 'p1:2') await decoded; },
    api: {
      browserPageFrame: async () => latest,
      browserPageControl: async (_owner, input) => { sent.push(input); },
    },
  });
  await client.poll();
  latest = frame('p1:2');
  const next = client.poll();
  await new Promise(resolve => setImmediate(resolve));
  await client.control({ type: 'text', text: 'visible page' });
  assert.equal(client.frame().documentId, 'p1:1');
  assert.equal(sent[0].documentId, 'p1:1');
  assert.equal(updates.length, 1);
  finish();
  await next;
  assert.equal(client.frame().documentId, 'p1:2');
});

test('queued human input retains the document seen at dispatch and never retargets to a later frame', async () => {
  let latest = frame();
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 'session-a', update() {}, failure() {},
    api: {
      browserPageFrame: async () => latest,
      async browserPageControl(session, input) {
        sent.push({ session, ...input });
        if (sent.length === 1) await gate;
      },
    },
  });
  await client.poll();
  const first = client.control({ type: 'text', text: 'first' });
  const second = client.control({ type: 'text', text: 'second' });
  latest = frame('p1:2');
  await client.poll();
  unblock();
  await Promise.all([first, second]);
  assert.deepEqual(sent.map(({ session, documentId, text }) => ({ session, documentId, text })), [
    { session: 'session-a', documentId: 'p1:1', text: 'first' },
    { session: 'session-a', documentId: 'p1:1', text: 'second' },
  ]);
});

test('overlapping refreshes share one read and disposed clients do not publish its result', async () => {
  let finish;
  let reads = 0;
  const updates = [];
  const client = createBrowserPageClient({
    sessionId: 'session-a', update: value => updates.push(value), failure() {},
    api: {
      browserPageFrame: () => { reads += 1; return new Promise(resolve => { finish = resolve; }); },
    },
  });
  const first = client.poll();
  const second = client.poll();
  assert.equal(reads, 1);
  client.dispose();
  finish(frame());
  await Promise.all([first, second]);
  assert.deepEqual(updates, []);
  client.activate();
  const resumed = client.poll();
  finish(frame('p1:2'));
  await resumed;
  assert.equal(updates[0].documentId, 'p1:2');
});

test('input failures do not replay the failed edit or strand subsequent input', async () => {
  const sent = [];
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: value => failures.push(value),
    api: {
      browserPageFrame: async () => frame(),
      async browserPageControl(_session, input) {
        sent.push(input.text);
        if (input.text === 'bad') throw new Error('document changed');
      },
    },
  });
  await client.poll();
  await assert.rejects(client.control({ type: 'text', text: 'bad' }), /document changed/);
  await client.control({ type: 'text', text: 'good' });
  assert.deepEqual(sent, ['bad', 'good']);
  assert.ok(failures.includes('document changed'));
});

test('pointer motion coalesces behind a busy page and disposal releases an already-sent press', async () => {
  const sent = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => assert.fail(error),
    api: {
      browserPageFrame: async () => frame(),
      async browserPageControl(_session, input) {
        sent.push({ ...input });
        if (input.phase === 'mousePressed') await gate;
      },
    },
  });
  await client.poll();
  const pointer = { type: 'pointer', phase: 'mousePressed', button: 'left', buttons: 1, modifiers: 0, clickCount: 1, x: 1, y: 1 };
  const down = client.control(pointer);
  await Promise.resolve();
  for (let x = 2; x <= 1000; x += 1) client.fire({ ...pointer, phase: 'mouseMoved', x });
  release();
  await down;
  await client.control({ type: 'text', text: 'barrier' });
  const moves = sent.filter(input => input.phase === 'mouseMoved');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].x, 1000);
  client.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).phase, 'mouseReleased');
  assert.equal(sent.at(-1).documentId, 'p1:1');
  assert.equal(sent.at(-1).buttons, 0);
});

test('navigation invalidates queued motion without sending it to the new document', async () => {
  let latest = frame();
  const sent = [];
  const failures = [];
  let refreshes = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => failures.push(error),
    api: {
      browserPageFrame: async () => latest,
      browserPageControl: async (_session, input) => {
        if (input.type === 'text') await gate;
        else sent.push(input);
      },
    },
  });
  await client.poll();
  const typing = client.control({ type: 'text', text: 'holds the input queue' });
  client.setRefresh(() => { refreshes += 1; });
  const move = client.control({ type: 'pointer', phase: 'mouseMoved', x: 1, y: 1, button: 'none', buttons: 0, modifiers: 0, clickCount: 0 });
  latest = frame('p1:2');
  await client.poll();
  release();
  await Promise.all([typing, move]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
  assert.deepEqual(failures, []);
  assert.equal(refreshes, 2);
});

test('stale hover is silent but rejected clicks and other errors report once without replay', async () => {
  const failures = [];
  const sent = [];
  let refreshes = 0;
  let message = 'Browser page changed; input was not sent.';
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => failures.push(error),
    api: {
      browserPageFrame: async () => frame(),
      async browserPageControl(_session, input) {
        sent.push(input);
        throw new Error(message);
      },
    },
  });
  await client.poll();
  client.setRefresh(() => { refreshes += 1; });
  const pointer = { type: 'pointer', phase: 'mouseMoved', x: 1, y: 1, button: 'none', buttons: 0, modifiers: 0, clickCount: 0 };
  client.fire(pointer);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, []);
  assert.equal(refreshes, 1);
  client.fire({ ...pointer, phase: 'mousePressed', button: 'left', buttons: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, [message]);
  failures.length = 0;
  message = 'Browser dialog is blocking input.';
  client.fire({ ...pointer });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, [message]);
  assert.equal(sent.length, 3);
});

test('fire reports an input admission failure only once', async () => {
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => failures.push(error), api: {},
  });
  client.fire({ type: 'text', text: 'not ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, ['Browser page is not ready.']);
});

test('pane chrome and hover motion before the first frame reject without a user-facing failure', async () => {
  const failures = [];
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => failures.push(error),
    api: { browserPageFrame: async () => frame(), browserPageControl: async (_session, input) => { sent.push(input); } },
  });
  const chrome = [
    { type: 'zoom', factor: 0.8 },
    { type: 'resize', width: 800, height: 600 },
    { type: 'navigate', url: 'https://example.test/next' },
    { type: 'reload' },
    { type: 'pointer', phase: 'mouseMoved', x: 1, y: 1, button: 'none', buttons: 0, modifiers: 0, clickCount: 0 },
  ];
  for (const action of chrome) {
    await assert.rejects(client.control(action), /Browser page is attaching/);
    client.fire(action);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, []);
  assert.deepEqual(sent, []);
  // Deliberate input still tells the user the page cannot take it yet.
  client.fire({ type: 'pointer', phase: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, modifiers: 0, clickCount: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, ['Browser page is not ready.']);
  // Once a frame attaches the same chrome action dispatches normally.
  await client.poll();
  await client.control({ type: 'zoom', factor: 0.8 });
  assert.deepEqual(sent.map(value => value.type), ['zoom']);
});

test('a page transition during capture recovers without publishing a stale frame or an error', async () => {
  let reads = 0;
  const updates = [];
  const client = createBrowserPageClient({
    sessionId: 's', update: value => updates.push(value), failure: error => assert.fail(error),
    api: { browserPageFrame: async () => {
      if (++reads === 1) throw new Error('Browser page changed during capture.');
      return frame('p1:2');
    } },
  });
  await client.poll();
  assert.equal(reads, 2);
  assert.deepEqual(updates.map(value => value.documentId), ['p1:2']);
});

test('resize recovers onto the latest document and queued resizes retain only the latest dimensions', async () => {
  let latest = frame();
  const sent = [];
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => failures.push(error),
    api: {
      browserPageFrame: async () => latest,
      browserPageControl: async (_session, input) => {
        sent.push({ ...input });
        if (sent.length === 1) {
          latest = frame('p1:2');
          throw new Error('Browser page changed; input was not sent.');
        }
      },
    },
  });
  await client.poll();
  client.fire({ type: 'resize', width: 800, height: 600 });
  client.fire({ type: 'resize', width: 900, height: 700 });
  await client.control({ type: 'text', text: 'barrier' });
  const sizes = sent.filter(value => value.type === 'resize');
  assert.deepEqual(sizes.map(({ documentId, width, height }) => ({ documentId, width, height })), [
    { documentId: 'p1:1', width: 900, height: 700 },
    { documentId: 'p1:2', width: 900, height: 700 },
  ]);
  assert.deepEqual(failures, []);
});

test('page-change edits report rejection after refresh without replay, and resize recovery is bounded', async () => {
  for (const action of [
    { type: 'pointer', phase: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, modifiers: 0, clickCount: 1 },
    { type: 'text', text: 'do not replay' },
    { type: 'zoom', factor: 0.8 },
    { type: 'navigate', url: 'https://example.test/next' },
    { type: 'reload' },
    { type: 'resize', width: 800, height: 600 },
  ]) {
    let calls = 0;
    let reads = 0;
    const failures = [];
    const client = createBrowserPageClient({
      sessionId: 's', update() {}, failure: error => failures.push(error),
      api: {
        browserPageFrame: async () => frame(`p1:${++reads}`),
        browserPageControl: async () => {
          calls++;
          throw new Error('Browser page changed; input was not sent.');
        },
      },
    });
    await client.poll();
    const deliberate = action.type === 'pointer' || action.type === 'text';
    if (deliberate) await assert.rejects(client.control(action), /input was not sent/);
    else await client.control(action);
    assert.equal(calls, action.type === 'resize' ? 2 : 1);
    assert.equal(reads, 2);
    assert.equal(client.frame().documentId, 'p1:2');
    assert.deepEqual(failures, deliberate ? ['Browser page changed; input was not sent.'] : []);
  }
});

test('capture recovery does not retry connection failures or loop over repeated page changes', async () => {
  for (const message of ['disconnected', 'Browser page changed during capture.']) {
    let reads = 0;
    const client = createBrowserPageClient({
      sessionId: 's', update() {}, failure() {},
      api: { browserPageFrame: async () => { reads++; throw new Error(message); } },
    });
    await assert.rejects(client.poll(), error => error.message === message);
    assert.equal(reads, message === 'disconnected' ? 1 : 2);
  }
});

test('a pending display sample does not delay motion, resize, or the keystroke behind them', { timeout: 1000 }, async () => {
  let finish;
  let slow = false;
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's', update() {}, failure: error => assert.fail(error),
    api: {
      browserPageFrame: () => slow ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(frame()),
      browserPageControl: async (_session, input) => { sent.push(input); },
    },
  });
  await client.poll();
  slow = true;
  const sample = client.poll();
  try {
    const move = client.control({
      type: 'pointer', phase: 'mouseMoved', x: 1, y: 1,
      button: 'none', buttons: 0, modifiers: 0, clickCount: 0,
    });
    const resize = client.control({ type: 'resize', width: 900, height: 700 });
    const key = client.control({ type: 'key', key: 'Tab' });
    await Promise.all([move, resize, key]);
    // Geometry now uses the independent native-control lane. Human inputs
    // retain their order, and neither lane waits for the display sample.
    assert.deepEqual(sent.filter(input => input.type !== 'resize').map(input => input.type), ['pointer', 'key']);
    assert.equal(sent.filter(input => input.type === 'resize').length, 1);
    assert.ok(sent.every(input => input.documentId === 'p1:1'));
  } finally {
    finish(frame());
    await sample;
    client.dispose();
  }
});
