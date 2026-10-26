import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserPageClient } from './browser-page-client.ts';
import { createBrowserPixelPresentation } from './browser-pixel-presentation.ts';
import { watchBrowserPageEvents } from './browser-pane-page-state.ts';

const frame = (documentId = 'p1:1') => ({
  documentId,
  frameId: documentId,
  webContentsId: 1,
  url: 'https://example.test',
  title: 'Page',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  width: 800,
  height: 600,
  viewportWidth: 800,
  viewportHeight: 600,
});

for (const mode of ['capture-failure', 'capture-pending', 'decode-failure']) {
  test(`${mode}: native facts initialize tabs and navigation without accepting undisplayed pixels`, async () => {
    const facts = { ...frame(), tabs: [{ id: 'p1', active: true, title: 'Blank', url: 'about:blank' }] };
    const sent = [];
    const pixels = [];
    const metadata = [];
    let finish;
    const client = createBrowserPageClient({
      sessionId: 's',
      update: (value) => pixels.push(value),
      updateMetadata: (value) => metadata.push(value),
      prepare: async () => {
        if (mode === 'decode-failure') throw new Error('decode failed');
      },
      failure: (error) => assert.fail(error),
      api: {
        browserPageMetadata: async () => facts,
        browserPageFrame: async () => {
          if (mode === 'capture-failure') throw new Error('capture failed');
          if (mode === 'capture-pending')
            return new Promise((resolve) => {
              finish = resolve;
            });
          return frame();
        },
        browserPageControl: async (_session, action) => {
          sent.push(action);
          return { remainingTabs: 1 };
        },
      },
    });
    const read = client.poll();
    const settled = mode === 'capture-pending' ? read : assert.rejects(read, /capture failed|decode failed/);
    const node = new EventTarget();
    client.bind(node, () => {});
    await node.loadURL('https://example.test/next');
    await node.createTab();
    await node.closeTab('p1');
    assert.equal(node.getWebContentsId(), 1);
    assert.deepEqual(node.getTabs(), facts.tabs);
    assert.deepEqual(
      sent.map(({ type }) => type),
      ['navigate', 'new-tab', 'close-tab']
    );
    assert.ok(sent.every(({ documentId }) => documentId === facts.documentId));
    assert.equal(client.frame(), null);
    assert.equal(pixels.length, 0);
    assert.ok(metadata.length > 0);
    client.dispose();
    finish?.(frame());
    await settled;
  });
}

test('new native metadata cannot retarget input from old visible pixels or publish late after disposal', async () => {
  let latest = frame();
  let finish;
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure() {},
    api: {
      browserPageFrame: async () => frame(),
      browserPageMetadata: async () => latest,
      browserPageControl: async (_session, action) => {
        sent.push(action);
      },
    },
  });
  await client.poll();
  latest = frame('p2:1');
  await client.pollMetadata();
  await client.control({
    type: 'pointer',
    phase: 'mousePressed',
    x: 10,
    y: 20,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await client.control({ type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 40 });
  await client.control({ type: 'text', text: 'old visible document' });
  await client.control({ type: 'resize', width: 600, height: 400 });
  assert.deepEqual(
    sent.map(({ documentId }) => documentId),
    ['p1:1', 'p1:1', 'p1:1', 'p2:1']
  );
  client.dispose();
  const updates = [];
  const parked = createBrowserPageClient({
    sessionId: 'parked',
    update() {},
    updateMetadata: (value) => updates.push(value),
    failure() {},
    api: {
      browserPageMetadata: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const read = parked.pollMetadata();
  parked.dispose();
  finish(latest);
  await read;
  assert.deepEqual(updates, []);
  assert.equal(parked.metadata(), null);
});

test('a same-address reload that clears the fault between two samples clears the failure overlay', async () => {
  let latest = { ...frame(), fault: 'renderer crashed (exit 5)' };
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: { browserPageMetadata: async () => latest },
  });
  const node = new EventTarget();
  client.bind(node, () => {});
  let failure = null;
  const apply = (value) => {
    failure = typeof value === 'function' ? value(failure) : value;
  };
  const stop = watchBrowserPageEvents(node, {
    addressFocused: { current: false },
    agentViewports: { current: new Map() },
    refreshCredentialSuggestions() {},
    setAddress() {},
    setAddressHasFocus() {},
    setAgentViewport() {},
    setCanGoBack() {},
    setCanGoForward() {},
    setCredentialMenuOpen() {},
    setCredentialStatus() {},
    setCurrentUrl() {},
    setHistorySuggestions() {},
    setLoading() {},
    setPageFailure: apply,
    setTabs() {},
  });
  await client.pollMetadata();
  assert.match(failure?.detail ?? '', /renderer crashed/);
  // The reload landed between samples: same address, never loading, no new attach.
  latest = { ...frame(), fault: undefined };
  await client.pollMetadata();
  assert.equal(failure, null);
  stop();
  client.dispose();
});

test('a pixel read without a native metadata read attaches the page', async () => {
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: { browserPageFrame: async () => frame() },
  });
  const node = new EventTarget();
  const events = [];
  node.addEventListener('did-attach', () => events.push('did-attach'));
  client.bind(node, () => {});
  await client.poll();
  assert.equal(client.metadata().documentId, 'p1:1');
  assert.equal(node.getWebContentsId(), 1);
  assert.deepEqual(events, ['did-attach']);
  client.dispose();
});

test('a delayed pixel capture never rolls back a newer dialog, and unchanged metadata keeps it', async (t) => {
  const dom = new JSDOM('<div id="pixels"></div>');
  for (const name of ['document', 'Image', 'HTMLCanvasElement', 'Event']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
  dom.window.Image.prototype.decode = async () => {};
  t.after(() => dom.window.close());
  // What the view renders: whatever was last handed to setFrame.
  let shown = null;
  const setFrame = (value) => {
    shown = value;
  };
  const presentation = createBrowserPixelPresentation({
    container: () => dom.window.document.getElementById('pixels'),
    image: { current: null },
    canvasId: 'gpu',
    metadata: setFrame,
  });
  const dialog = { id: 'd1', type: 'alert', message: 'Hello' };
  let facts = frame();
  let finish;
  const pixel = (id) => ({ ...frame(), frameId: id, image: { mimeType: 'image/png', data: id } });
  const client = createBrowserPageClient({
    sessionId: 's',
    prepare: presentation.prepare,
    update: presentation.update,
    updateMetadata: setFrame,
    failure: (error) => assert.fail(error),
    api: {
      browserPageMetadata: async () => facts,
      browserPageFrame: (_session, known) =>
        known === undefined
          ? Promise.resolve(pixel('one'))
          : new Promise((resolve) => {
              finish = resolve;
            }),
    },
  });
  await client.pollMetadata();
  await client.poll();
  const capture = client.poll();
  facts = { ...frame(), dialog };
  await client.pollMetadata();
  assert.equal(shown.dialog?.id, 'd1');
  finish({ ...pixel('two'), width: 1600, height: 1200 });
  await capture;
  assert.equal(client.frame().frameId, 'two');
  assert.equal(shown.dialog?.id, 'd1');
  await client.pollMetadata();
  assert.equal(shown.dialog?.id, 'd1');
  client.dispose();
});

test('a stalled pixel read does not block metadata refresh after a tab change', async () => {
  let facts = frame();
  let finish;
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: {
      browserPageMetadata: async () => facts,
      browserPageFrame: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      browserPageControl: async () => {
        facts = frame('p2:1');
      },
    },
  });
  const capture = client.poll();
  await client.control({ type: 'new-tab' });
  assert.equal(client.metadata().documentId, 'p2:1');
  assert.equal(client.frame(), null);
  finish(frame());
  await capture;
  assert.equal(client.metadata().documentId, 'p2:1');
  assert.equal(client.frame().documentId, 'p1:1');
  client.dispose();
});

test('pixel cadence and native geometry do not republish unchanged chrome facts', async () => {
  const updates = [];
  let id = 0;
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    updateMetadata: (value) => updates.push(value),
    failure() {},
    api: {
      browserPageMetadata: async () => ({ ...frame(), frameId: 'native' }),
      browserPageFrame: async () => ({ ...frame(), frameId: `pixel-${++id}`, width: 1600, height: 1200 }),
    },
  });
  await client.pollMetadata();
  await client.poll();
  await client.pollMetadata();
  await client.poll();
  assert.equal(updates.length, 1);
  assert.equal(client.frame().width, 1600);
  client.dispose();
});

test('hover before the first pixels never loops through metadata bootstrap', async () => {
  let reads = 0;
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: {
      browserPageMetadata: async () => {
        reads++;
        return frame();
      },
      browserPageControl: async () => assert.fail('undisplayed hover must not be sent'),
    },
  });
  await assert.rejects(
    client.control({
      type: 'pointer',
      phase: 'mouseMoved',
      x: 1,
      y: 1,
      button: 'none',
      buttons: 0,
      modifiers: 0,
      clickCount: 0,
    }),
    /Browser page is attaching/
  );
  assert.equal(reads, 0);
  client.dispose();
});

test('new frame coordinates are published only after decoding without holding up input to the visible frame', async () => {
  let latest = frame();
  let finish;
  const decoded = new Promise((resolve) => {
    finish = resolve;
  });
  const updates = [];
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 'owner',
    failure: (error) => assert.fail(error),
    update: (next) => updates.push(next),
    prepare: async (next) => {
      if (next.documentId === 'p1:2') await decoded;
    },
    api: {
      browserPageFrame: async () => latest,
      browserPageControl: async (_owner, input) => {
        sent.push(input);
      },
    },
  });
  await client.poll();
  latest = frame('p1:2');
  const next = client.poll();
  await new Promise((resolve) => setImmediate(resolve));
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
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 'session-a',
    update() {},
    failure() {},
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
  assert.deepEqual(
    sent.map(({ session, documentId, text }) => ({ session, documentId, text })),
    [
      { session: 'session-a', documentId: 'p1:1', text: 'first' },
      { session: 'session-a', documentId: 'p1:1', text: 'second' },
    ]
  );
});

test('overlapping refreshes share one read and disposed clients do not publish its result', async () => {
  let finish;
  let reads = 0;
  const updates = [];
  const client = createBrowserPageClient({
    sessionId: 'session-a',
    update: (value) => updates.push(value),
    failure() {},
    api: {
      browserPageFrame: () => {
        reads += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
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
    sessionId: 's',
    update() {},
    failure: (value) => failures.push(value),
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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: {
      browserPageFrame: async () => frame(),
      async browserPageControl(_session, input) {
        sent.push({ ...input });
        if (input.phase === 'mousePressed') await gate;
      },
    },
  });
  await client.poll();
  const pointer = {
    type: 'pointer',
    phase: 'mousePressed',
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
    x: 1,
    y: 1,
  };
  const down = client.control(pointer);
  await Promise.resolve();
  for (let x = 2; x <= 1000; x += 1) client.fire({ ...pointer, phase: 'mouseMoved', x });
  release();
  await down;
  await client.control({ type: 'text', text: 'barrier' });
  const moves = sent.filter((input) => input.phase === 'mouseMoved');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].x, 1000);
  client.dispose();
  await new Promise((resolve) => setImmediate(resolve));
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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
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
  client.setRefresh(() => {
    refreshes += 1;
  });
  const move = client.control({
    type: 'pointer',
    phase: 'mouseMoved',
    x: 1,
    y: 1,
    button: 'none',
    buttons: 0,
    modifiers: 0,
    clickCount: 0,
  });
  latest = frame('p1:2');
  await client.poll();
  release();
  await Promise.all([typing, move]);
  await new Promise((resolve) => setImmediate(resolve));
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
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
    api: {
      browserPageFrame: async () => frame(),
      async browserPageControl(_session, input) {
        sent.push(input);
        throw new Error(message);
      },
    },
  });
  await client.poll();
  client.setRefresh(() => {
    refreshes += 1;
  });
  const pointer = {
    type: 'pointer',
    phase: 'mouseMoved',
    x: 1,
    y: 1,
    button: 'none',
    buttons: 0,
    modifiers: 0,
    clickCount: 0,
  };
  client.fire(pointer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, []);
  assert.equal(refreshes, 1);
  client.fire({ ...pointer, phase: 'mousePressed', button: 'left', buttons: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [message]);
  failures.length = 0;
  message = 'Browser dialog is blocking input.';
  client.fire({ ...pointer });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [message]);
  assert.equal(sent.length, 3);
});

test('tab controls refresh the displayed page while ordinary controls do not', async () => {
  let reads = 0;
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: {
      browserPageFrame: async () => frame(`p1:${++reads}`),
      browserPageControl: async () => {},
    },
  });
  await client.poll();
  for (const [action, expectedDocument] of [
    [{ type: 'new-tab' }, 'p1:2'],
    [{ type: 'select-tab', tabId: 'p2' }, 'p1:3'],
    [{ type: 'close-tab', tabId: 'p2' }, 'p1:4'],
    [{ type: 'text', text: 'edit' }, 'p1:4'],
    [{ type: 'reload' }, 'p1:4'],
    [{ type: 'stop' }, 'p1:4'],
  ]) {
    await client.control(action);
    assert.equal(client.frame().documentId, expectedDocument);
  }
  client.dispose();
});

test("a close-tab control resolves with the host's remaining tab count, other controls with nothing", async () => {
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: {
      browserPageFrame: async () => frame('p1:1'),
      browserPageControl: async (_session, input) => (input.type === 'close-tab' ? { remainingTabs: 0 } : undefined),
    },
  });
  await client.poll();
  assert.deepEqual(await client.control({ type: 'close-tab', tabId: 'p1' }), { remainingTabs: 0 });
  assert.equal(await client.control({ type: 'new-tab' }), undefined);
  client.dispose();
});

test('a navigation superseded by a newer one (ERR_ABORTED) is not reported as a failure, other errors are', async () => {
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (message) => failures.push(message),
    api: {
      browserPageFrame: async () => frame('p1:1'),
      browserPageControl: async (_session, input) => {
        throw new Error(input.url.includes('blank') ? "ERR_ABORTED (-3) loading 'about:blank'" : 'refused');
      },
    },
  });
  await client.poll();
  await assert.rejects(client.control({ type: 'navigate', url: 'about:blank' }), /ERR_ABORTED/);
  await assert.rejects(client.control({ type: 'navigate', url: 'https://x.test/' }), /refused/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(failures, ['refused']);
  client.dispose();
});

test('a compositor miss on the display sample after a tab control is not reported as an input failure', async () => {
  const failures = [];
  let reads = 0;
  let missNext = false;
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
    api: {
      browserPageFrame: async () => {
        if (missNext) {
          missNext = false;
          throw new Error("Error invoking remote method 'mixdog:browser-page-frame': Error: VizSentEmptyBitmap");
        }
        return frame(`p1:${++reads}`);
      },
      browserPageControl: async () => {},
    },
  });
  await client.poll();
  missNext = true;
  await client.control({ type: 'new-tab' });
  assert.deepEqual(failures, []);
  await client.poll();
  assert.equal(client.frame().documentId, 'p1:2', 'the next display sample still refreshes the page');
  client.dispose();
});

test('fire reports an input admission failure only once', async () => {
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
    api: {},
  });
  client.fire({ type: 'text', text: 'not ready' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, ['Browser page is not ready.']);
});

test('pane chrome and hover motion before the first frame reject without a user-facing failure', async () => {
  const failures = [];
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
    api: {
      browserPageFrame: async () => frame(),
      browserPageControl: async (_session, input) => {
        sent.push(input);
      },
    },
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, []);
  assert.deepEqual(sent, []);
  // Deliberate input still tells the user the page cannot take it yet.
  client.fire({
    type: 'pointer',
    phase: 'mousePressed',
    x: 1,
    y: 1,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, ['Browser page is not ready.']);
  // Once a frame attaches the same chrome action dispatches normally.
  await client.poll();
  await client.control({ type: 'zoom', factor: 0.8 });
  assert.deepEqual(
    sent.map((value) => value.type),
    ['zoom']
  );
});

test('a page transition during capture recovers without publishing a stale frame or an error', async () => {
  let reads = 0;
  const updates = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update: (value) => updates.push(value),
    failure: (error) => assert.fail(error),
    api: {
      browserPageFrame: async () => {
        if (++reads === 1) throw new Error('Browser page changed during capture.');
        return frame('p1:2');
      },
    },
  });
  await client.poll();
  assert.equal(reads, 2);
  assert.deepEqual(
    updates.map((value) => value.documentId),
    ['p1:2']
  );
});

test('resize recovers onto the latest document and queued resizes retain only the latest dimensions', async () => {
  let latest = frame();
  const sent = [];
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
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
  const sizes = sent.filter((value) => value.type === 'resize');
  assert.deepEqual(
    sizes.map(({ documentId, width, height }) => ({ documentId, width, height })),
    [
      { documentId: 'p1:1', width: 900, height: 700 },
      { documentId: 'p1:2', width: 900, height: 700 },
    ]
  );
  assert.deepEqual(failures, []);
});

test('a requested address from a stale frame loads into the page the host shows now', async () => {
  // A parked pane keeps its last frame while the host selects a new blank tab.
  let latest = frame();
  const sent = [];
  const failures = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
    api: {
      browserPageFrame: async () => latest,
      browserPageControl: async (_session, input) => {
        sent.push({ ...input });
        if (input.documentId !== latest.documentId) throw new Error('Browser page changed; input was not sent.');
      },
    },
  });
  await client.poll();
  latest = { ...frame('p2:1'), webContentsId: 2, url: 'about:blank' };
  await client.control({ type: 'navigate', url: 'https://example.test/requested' });
  assert.deepEqual(
    sent.map(({ type, url, documentId }) => ({ type, url, documentId })),
    [
      { type: 'navigate', url: 'https://example.test/requested', documentId: 'p1:1' },
      { type: 'navigate', url: 'https://example.test/requested', documentId: 'p2:1' },
    ]
  );
  assert.deepEqual(failures, []);
});

test('page-change edits report rejection after refresh without replay, and resize/navigation recovery is bounded', async () => {
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
      sessionId: 's',
      update() {},
      failure: (error) => failures.push(error),
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
    assert.equal(calls, action.type === 'resize' || action.type === 'navigate' ? 2 : 1);
    assert.equal(reads, 2);
    assert.equal(client.frame().documentId, 'p1:2');
    assert.deepEqual(failures, deliberate ? ['Browser page changed; input was not sent.'] : []);
  }
});

test('capture recovery does not retry connection failures or loop over repeated page changes', async () => {
  for (const message of ['disconnected', 'Browser page changed during capture.']) {
    let reads = 0;
    const client = createBrowserPageClient({
      sessionId: 's',
      update() {},
      failure() {},
      api: {
        browserPageFrame: async () => {
          reads++;
          throw new Error(message);
        },
      },
    });
    await assert.rejects(client.poll(), (error) => error.message === message);
    assert.equal(reads, message === 'disconnected' ? 1 : 2);
  }
});

test('a pending display sample does not delay motion, resize, or the keystroke behind them', {
  timeout: 1000,
}, async () => {
  let finish;
  let slow = false;
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => assert.fail(error),
    api: {
      browserPageFrame: () =>
        slow
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(frame()),
      browserPageControl: async (_session, input) => {
        sent.push(input);
      },
    },
  });
  await client.poll();
  slow = true;
  const sample = client.poll();
  try {
    const move = client.control({
      type: 'pointer',
      phase: 'mouseMoved',
      x: 1,
      y: 1,
      button: 'none',
      buttons: 0,
      modifiers: 0,
      clickCount: 0,
    });
    const resize = client.control({ type: 'resize', width: 900, height: 700 });
    const key = client.control({ type: 'key', key: 'Tab' });
    await Promise.all([move, resize, key]);
    // Geometry now uses the independent native-control lane. Human inputs
    // retain their order, and neither lane waits for the display sample.
    assert.deepEqual(
      sent.filter((input) => input.type !== 'resize').map((input) => input.type),
      ['pointer', 'key']
    );
    assert.equal(sent.filter((input) => input.type === 'resize').length, 1);
    assert.ok(sent.every((input) => input.documentId === 'p1:1'));
  } finally {
    finish(frame());
    await sample;
    client.dispose();
  }
});

test('a page dialog takes the page input silently while its answer and a release still go out', async () => {
  const failures = [];
  const preserved = [];
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    failure: (error) => failures.push(error),
    unconfirmedText: (text) => preserved.push(text),
    api: {
      browserPageFrame: async () => ({ ...frame(), dialog: { id: 'd1', type: 'alert', message: 'Done' } }),
      browserPageControl: async (_session, input) => {
        sent.push(input.type === 'pointer' ? input.phase : input.type);
      },
    },
  });
  await client.poll();
  const pointer = { type: 'pointer', x: 1, y: 1, button: 'left', buttons: 1, modifiers: 0, clickCount: 1 };
  await client.control({ ...pointer, phase: 'mousePressed' });
  await client.control({ type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 40 });
  await client.control({ type: 'text', text: 'typed under the dialog' });
  await client.control({ ...pointer, phase: 'mouseReleased', buttons: 0 });
  await client.control({ type: 'answer-dialog', requestId: 'd1', accept: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['mouseReleased', 'answer-dialog']);
  assert.deepEqual(failures, []);
  assert.deepEqual(preserved, []);
  client.dispose();
});
