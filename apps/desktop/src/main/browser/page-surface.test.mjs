import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageSurface } from './page-surface.ts';
import { normalizeBrowserPageControl } from '../../shared/browser-page-control.ts';

test('GPU reads transfer exact frame identities, including a newly attached client facing a dialog', async () => {
  const record = { documentGeneration: 1 };
  const guest = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  let transfers = 0;
  let releases = 0;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => record },
    cdp: {
      guestDebugger: async () => ({
        sendCommand: async () => {
          assert.equal(record.pendingDialog, undefined);
          return { cssVisualViewport: { scale: 1 } };
        },
      }),
      bounded: async (work) => work,
    },
    viewport: () => ({ width: 800, height: 600, zoom: 1, pixels: { width: 800, height: 600 } }),
    capture: async () => {
      throw new Error('GPU display must not encode a screenshot');
    },
    captureTexture: () => ({
      id: 'gpu1',
      width: 800,
      height: 600,
      send: async (session) => {
        assert.equal(session, 'owner');
        transfers++;
      },
      release: () => {
        releases++;
      },
    }),
  });
  const frame = await surface.frame('owner', '', undefined, true);
  assert.equal(frame.textureId, 'gpu1');
  assert.equal(frame.frameId, 'gpu1');
  assert.equal(frame.image, undefined);
  record.pendingDialog = {};
  assert.equal((await surface.frame('owner', '', undefined, true)).textureId, 'gpu1');
  assert.equal(transfers, 2);
  assert.equal(releases, 2);
});

test('viewport changes discard old captures and cached images instead of stretching them into new geometry', async () => {
  const record = { documentGeneration: 1 };
  const guest = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  let width = 800;
  let capture = async () => ({ data: 'pixels', width, height: 600, mimeType: 'image/png', fullPage: false });
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => record },
    cdp: {
      guestDebugger: async () => ({ sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }) }),
      bounded: async (work) => work,
    },
    viewport: () => ({ width, height: 600, zoom: 1, pixels: { width, height: 600 } }),
    capture: (...args) => capture(...args),
  });
  const first = await surface.frame('owner');
  let resolve;
  capture = () =>
    new Promise((done) => {
      resolve = done;
    });
  const old = surface.frame('owner');
  await new Promise((done) => setImmediate(done));
  const finish = surface.beginViewportChange(guest);
  await assert.rejects(surface.frame('owner'), /page changed during capture/);
  resolve({ data: 'obsolete', width: 800, height: 600, mimeType: 'image/png', fullPage: false });
  await assert.rejects(old, /page changed during capture/);
  width = 390;
  finish();
  capture = async () => {
    throw new Error('UnknownVizError');
  };
  await assert.rejects(surface.frame('owner'), /UnknownVizError/, 'old geometry is not a fallback');
  capture = async () => ({ data: 'pixels', width, height: 600, mimeType: 'image/png', fullPage: false });
  const fresh = await surface.frame('owner');
  assert.notEqual(fresh.frameId, first.frameId, 'identical pixels with new geometry still update the client');
  assert.deepEqual([fresh.surfaceWidth, fresh.surfaceHeight], [390, 600]);
  assert.equal(fresh.image.data, 'pixels');
});

test('debugger initialization cannot retarget a local edit or bypass a newly opened dialog', async () => {
  const inputs = [
    { type: 'text', text: 'never' },
    { type: 'key', key: 'Enter' },
    { type: 'pointer', phase: 'mousePressed', x: 10, y: 10, button: 'left', buttons: 1, modifiers: 0, clickCount: 1 },
    { type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 10 },
  ];
  for (const reason of ['document', 'selection', 'dialog', 'cancel']) {
    for (const input of inputs) {
      const record = { documentGeneration: 1 };
      const guest = { isDestroyed: () => false };
      let selected = guest;
      const sent = [];
      const controller = new AbortController();
      const surface = createBrowserPageSurface({
        ensureGuest: async () => guest,
        currentGuest: () => selected,
        state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
        cdp: {
          waitForIdle: async () => {},
          guestDebugger: async () => {
            if (reason === 'document') record.documentGeneration++;
            if (reason === 'selection') selected = {};
            if (reason === 'dialog') record.pendingDialog = {};
            if (reason === 'cancel') controller.abort(new Error('cancelled'));
            return {};
          },
          sendCdpInput: async (...args) => {
            sent.push(args);
          },
        },
      });
      const expected = { cancel: /cancelled/, dialog: /dialog is blocking/ }[reason] ?? /page changed/;
      await assert.rejects(surface.control('owner', { ...input, documentId: 'p1:1' }, controller.signal), expected);
      assert.deepEqual(sent, []);
    }
  }
});

test('geometry updates bypass blocked execution but still respect document and session ownership', async () => {
  const sizes = [];
  let zoom = 1;
  let invalidated = 0;
  const guest = {
    isDestroyed: () => false,
    getZoomFactor: () => zoom,
    setZoomFactor: (factor) => {
      zoom = factor;
    },
  };
  const record = { documentGeneration: 1, pendingDialog: {} };
  let selected = guest;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    currentGuest: () => selected,
    state: {
      pageId: () => 'p1',
      for: () => record,
      invalidateInteraction: () => {
        invalidated += 1;
      },
    },
    cdp: {
      waitForIdle: async () => {
        throw new Error('must not wait');
      },
    },
    resize: (_guest, width, height) => sizes.push([width, height]),
  });
  const input = { type: 'resize', width: 1000, height: 700, documentId: 'p1:1' };
  await surface.control('owner', input);
  // The pane reapplies its zoom on every attach and navigation: the factor the
  // guest already has changes nothing and never discards the agent's refs.
  await surface.control('owner', { type: 'zoom', factor: 0.8, documentId: 'p1:1' });
  await surface.control('owner', { type: 'zoom', factor: 0.8, documentId: 'p1:1' });
  assert.equal(zoom, 0.8);
  assert.equal(invalidated, 1);
  await assert.rejects(surface.control('owner', { ...input, documentId: 'p1:0' }), /page changed/);
  selected = {};
  await assert.rejects(surface.control('owner', input), /page changed/);
  assert.deepEqual(sizes, [[1000, 700]]);
});

test('native recovery bypasses cleanup and dialogs but still checks document ownership and cancellation', async () => {
  const sent = [];
  const guest = {
    isDestroyed: () => false,
    stop: () => sent.push('stop'),
    reload: () => sent.push('reload'),
  };
  const record = { documentGeneration: 1, pendingDialog: {} };
  let selected = guest;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    currentGuest: () => selected,
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: {
      waitForIdle: async () => {
        throw new Error('cleanup still blocked');
      },
    },
  });
  for (const type of ['stop', 'reload']) {
    await surface.control('owner', { type, documentId: 'p1:1' });
    await assert.rejects(surface.control('owner', { type, documentId: 'p1:0' }), /page changed/);
    selected = {};
    await assert.rejects(surface.control('owner', { type, documentId: 'p1:1' }), /page changed/);
    selected = guest;
    await assert.rejects(
      surface.control('owner', { type, documentId: 'p1:1' }, AbortSignal.abort(new Error('cancelled'))),
      /cancelled/
    );
  }
  await assert.rejects(
    surface.control('owner', { type: 'text', text: 'never', documentId: 'p1:1' }),
    /cleanup still blocked/
  );
  assert.deepEqual(sent, ['stop', 'reload']);
});

test('local input admission rejects unbounded data and preserves a validated document token', () => {
  assert.deepEqual(normalizeBrowserPageControl({ type: 'text', text: '한글', documentId: 'p1:2' }), {
    type: 'text',
    text: '한글',
    documentId: 'p1:2',
  });
  for (const type of ['select-tab', 'close-tab']) {
    assert.deepEqual(normalizeBrowserPageControl({ type, tabId: 'p2', documentId: 'p1:2' }), {
      type,
      tabId: 'p2',
      documentId: 'p1:2',
    });
    assert.throws(() => normalizeBrowserPageControl({ type, tabId: '../other', documentId: 'p1:2' }));
  }
  assert.deepEqual(normalizeBrowserPageControl({ type: 'new-tab', documentId: 'p1:2' }), {
    type: 'new-tab',
    documentId: 'p1:2',
  });
  for (const input of [
    { type: 'text', text: 'x', documentId: 'other' },
    { type: 'text', text: 'x'.repeat(32_001), documentId: 'p1:2' },
    { type: 'resize', width: Infinity, height: 600, documentId: 'p1:2' },
    { type: 'zoom', factor: 100, documentId: 'p1:2' },
    { type: 'pointer', phase: 'unknown', documentId: 'p1:2' },
  ])
    assert.throws(() => normalizeBrowserPageControl(input));
});

test('a rejected display sample serves the last good frame until the outage outlasts the grace window', async () => {
  let now = 1_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const record = { documentGeneration: 1 };
    const guest = {
      id: 7,
      isDestroyed: () => false,
      getURL: () => 'https://a',
      getTitle: () => 'A',
      isLoadingMainFrame: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    let fail = true;
    const surface = createBrowserPageSurface({
      ensureGuest: async () => guest,
      state: { pageId: () => 'p1', for: () => record },
      cdp: {
        guestDebugger: async () => ({
          sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }),
        }),
        bounded: async (work) => work,
      },
      viewport: () => ({ width: 800, height: 600, zoom: 1, pixels: { width: 800, height: 600 } }),
      capture: async () => {
        if (fail) throw new Error('UnknownVizError');
        return { data: 'pixels', width: 800, height: 600, mimeType: 'image/jpeg', fullPage: false };
      },
    });
    await assert.rejects(surface.frame('owner'), /UnknownVizError/, 'nothing to reuse before the first frame');
    fail = false;
    const first = await surface.frame('owner');
    assert.equal(first.image.data, 'pixels');
    fail = true;
    now += 500;
    const reused = await surface.frame('owner', first.frameId);
    assert.equal(reused.frameId, first.frameId);
    assert.equal(reused.image, undefined, 'an unchanged frame carries no pixels');
    now += 4_000;
    await assert.rejects(surface.frame('owner', first.frameId), /UnknownVizError/, 'a lasting outage surfaces');
    fail = false;
    const recovered = await surface.frame('owner', first.frameId);
    assert.equal(recovered.frameId, first.frameId);
    fail = true;
    now += 500;
    const reusedAgain = await surface.frame('owner', first.frameId);
    assert.equal(reusedAgain.frameId, first.frameId, 'recovery resets the grace window');
    record.documentGeneration += 1;
    await assert.rejects(
      surface.frame('owner', first.frameId),
      /UnknownVizError/,
      'a new document must not inherit the previous document image during the grace window'
    );
    fail = false;
    const navigated = await surface.frame('owner', first.frameId);
    assert.notEqual(navigated.frameId, first.frameId, 'identical pixels still belong to a new document');
    assert.equal(navigated.documentId, 'p1:2');
    assert.equal(navigated.image.data, 'pixels');
  } finally {
    Date.now = realNow;
  }
});

test('navigation, tab selection, or cancellation during a cleanup wait prevents every local input effect', async () => {
  for (const reason of ['navigation', 'selection', 'cancel']) {
    const controller = new AbortController();
    const record = { documentGeneration: 1 };
    const sent = [];
    const guest = { isDestroyed: () => false, getZoomFactor: () => 1 };
    let selected = guest;
    const surface = createBrowserPageSurface({
      ensureGuest: async () => guest,
      currentGuest: () => selected,
      state: { pageId: () => 'p1', for: () => record, invalidateInteraction: () => sent.push('invalidate') },
      cdp: {
        async waitForIdle() {
          if (reason === 'navigation') record.documentGeneration += 1;
          else if (reason === 'selection') selected = {};
          else controller.abort(new Error('cancelled'));
        },
        guestDebugger: async () => ({}),
        sendCdpInput: async () => sent.push('input'),
      },
    });
    await assert.rejects(
      surface.control('owner', { type: 'text', text: 'never', documentId: 'p1:1' }, controller.signal),
      reason !== 'cancel' ? /page changed/ : /cancelled/
    );
    assert.deepEqual(sent, []);
  }
});

test('display metadata remains available while page execution is fenced and never cancels that execution', async () => {
  const record = { documentGeneration: 1 };
  const guest = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  let nativeViewport = { width: 390, height: 844, zoom: 1, pixels: { width: 1170, height: 2532 } };
  let pageScale = 1;
  let targetReplaced = false;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => record },
    cdp: {
      waitForIdle: async () => {
        throw new Error('execution is fenced');
      },
      evaluate: async () => {
        throw new Error('execution is fenced');
      },
      guestDebugger: async () => ({
        sendCommand: async (method) => {
          if (method !== 'Page.getLayoutMetrics') throw new Error('display must not execute or terminate scripts');
          if (targetReplaced) throw new Error('target closed while handling command');
          return { cssVisualViewport: { scale: pageScale } };
        },
      }),
      bounded: async (work) => work,
    },
    viewport: () => nativeViewport,
    capture: async () => ({ data: 'pixels', width: 1170, height: 2532, mimeType: 'image/jpeg', fullPage: false }),
  });
  const frame = await surface.frame('owner');
  assert.equal(frame.viewportWidth, 390);
  assert.equal(frame.viewportHeight, 844);
  assert.equal(frame.width, 1170);
  assert.equal(frame.image.data, 'pixels');
  for (const sample of [
    { width: 1366, height: 768, zoom: 1, pageScale: 1, expected: [1366, 768] },
    { width: 1366, height: 768, zoom: 1.25, pageScale: 1, expected: [1093, 615] },
    { width: 390, height: 844, zoom: 1, pageScale: 390 / 980, expected: [980, 2121] },
  ]) {
    nativeViewport = { ...sample, pixels: { width: sample.width, height: sample.height } };
    pageScale = sample.pageScale;
    const next = await surface.frame('owner');
    assert.deepEqual([next.viewportWidth, next.viewportHeight], sample.expected);
  }
  targetReplaced = true;
  await assert.rejects(surface.frame('owner'), /Browser page changed during capture/);
  targetReplaced = false;
  assert.equal((await surface.frame('owner')).documentId, 'p1:1');
});

test('a scaled display samples at the window pixel size while input keeps CSS geometry', async () => {
  const guest = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const pixels = { width: 1602, height: 902 };
  const requested = [];
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => ({ documentGeneration: 1 }) },
    cdp: {
      guestDebugger: async () => ({ sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }) }),
      bounded: async (work) => work,
    },
    viewport: () => ({ width: 1280, height: 720, zoom: 1, pixels }),
    capture: async (_guest, _key, size) => {
      requested.push(['bitmap', size]);
      return { data: 'pixels', ...size, mimeType: 'image/png', fullPage: false };
    },
    captureTexture: (_guest, _document, size) => {
      requested.push(['texture', size]);
      return { id: 'gpu1', ...size, send: async () => {}, release: () => {} };
    },
  });
  const bitmap = await surface.frame('owner');
  const texture = await surface.frame('owner', '', undefined, true);
  assert.deepEqual(requested, [
    ['bitmap', pixels],
    ['texture', pixels],
  ]);
  for (const frame of [bitmap, texture]) {
    assert.deepEqual([frame.width, frame.height], [1602, 902]);
    assert.deepEqual([frame.viewportWidth, frame.viewportHeight], [1280, 720]);
    assert.deepEqual([frame.surfaceWidth, frame.surfaceHeight], [1280, 720]);
  }
});

test('a pane resize that lands a DIP off at a fractional scale presents as the requested surface', async () => {
  const record = { documentGeneration: 1 };
  const guest = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  let content = { width: 800, height: 600 };
  const pixelsOf = (size) => ({ width: Math.ceil(size.width * 1.25), height: Math.ceil(size.height * 1.25) });
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: {
      guestDebugger: async () => ({ sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }) }),
      bounded: async (work) => work,
    },
    viewport: () => ({ ...content, zoom: 1, pixels: pixelsOf(content) }),
    resize: (_guest, width, height) => {
      content = { width, height: height + 1 };
      return content;
    },
    capture: async (_guest, _key, size) => ({ data: 'pixels', ...size, mimeType: 'image/png', fullPage: false }),
  });
  const first = await surface.frame('owner');
  assert.deepEqual([first.surfaceWidth, first.surfaceHeight], [800, 600]);
  await surface.control('owner', { type: 'resize', width: 900, height: 700, documentId: first.documentId });
  const resized = await surface.frame('owner');
  assert.deepEqual([resized.surfaceWidth, resized.surfaceHeight], [900, 700]);
  assert.deepEqual([resized.width, resized.height], [1125, 877]);
  content = { width: 905, height: 701 };
  const external = await surface.frame('owner');
  assert.deepEqual(
    [external.surfaceWidth, external.surfaceHeight],
    [905, 701],
    'a window size no pane request produced is reported as it is'
  );
});

test('a primary display scale change re-sizes presented offscreen pages and keeps the requested surface', async () => {
  const record = { documentGeneration: 1 };
  const page = (offscreen) => ({
    id: offscreen ? 7 : 8,
    isOffscreen: () => offscreen,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  });
  const guests = { offscreen: page(true), native: page(false) };
  const contents = new Map();
  let drift = 1;
  const resizes = [];
  const surface = createBrowserPageSurface({
    ensureGuest: async (sessionId) => guests[sessionId],
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: {
      guestDebugger: async () => ({ sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }) }),
      bounded: async (work) => work,
    },
    viewport: (guest) => {
      const content = contents.get(guest) ?? { width: 800, height: 600 };
      return { ...content, zoom: 1, pixels: content };
    },
    resize: (guest, width, height) => {
      resizes.push([guest.id, width, height]);
      const landed = { width, height: height + drift };
      contents.set(guest, landed);
      return landed;
    },
    capture: async (_guest, _key, size) => ({ data: 'pixels', ...size, mimeType: 'image/png', fullPage: false }),
  });
  for (const sessionId of ['offscreen', 'native']) {
    await surface.frame(sessionId);
    await surface.control(sessionId, { type: 'resize', width: 900, height: 700, documentId: 'p1:1' });
  }
  resizes.length = 0;
  drift = 2;
  surface.refreshScale();
  assert.deepEqual(
    resizes,
    [
      [7, 900, 701],
      [7, 900, 700],
    ],
    'only offscreen pages are moved off their pane size and back'
  );
  const after = await surface.frame('offscreen');
  assert.deepEqual([after.surfaceWidth, after.surfaceHeight], [900, 700]);
  assert.equal(after.height, 702, 'the frame follows the window size the page landed at after the change');
});

test('a page not presented during a scale change is re-scaled when it is shown again', async () => {
  const record = { documentGeneration: 1 };
  const page = (id) => ({
    id,
    isOffscreen: () => true,
    isDestroyed: () => false,
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  });
  const tabs = [page(1), page(2)];
  let current = tabs[0];
  const contents = new Map();
  const resizes = [];
  const surface = createBrowserPageSurface({
    ensureGuest: async () => current,
    currentGuest: () => current,
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: {
      guestDebugger: async () => ({ sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }) }),
      bounded: async (work) => work,
    },
    viewport: (guest) => {
      const content = contents.get(guest) ?? { width: 800, height: 600 };
      return { ...content, zoom: 1, pixels: content };
    },
    resize: (guest, width, height) => {
      resizes.push([guest.id, width, height]);
      const landed = { width, height };
      contents.set(guest, landed);
      return landed;
    },
    capture: async (_guest, _key, size) => ({ data: 'pixels', ...size, mimeType: 'image/png', fullPage: false }),
  });
  await surface.frame('s');
  await surface.control('s', { type: 'resize', width: 900, height: 700, documentId: 'p1:1' });
  current = tabs[1];
  await surface.frame('s');
  current = tabs[0];
  await surface.frame('s');
  surface.refreshScale();
  resizes.length = 0;
  current = tabs[1];
  await surface.frame('s');
  assert.deepEqual(
    resizes,
    [
      [2, 900, 701],
      [2, 900, 700],
    ],
    'the background page is moved off its size and back when shown'
  );
  resizes.length = 0;
  current = tabs[0];
  await surface.frame('s');
  current = tabs[1];
  await surface.frame('s');
  assert.deepEqual(resizes.filter(([id]) => id === 2), [[2, 900, 700]], 'an already re-scaled page is only sized');
});

test('a GPU frame that lands after the session moved on is refused and released', async () => {
  for (const change of ['selection', 'document']) {
    const record = { documentGeneration: 1 };
    const guest = {
      id: 7,
      isDestroyed: () => false,
      getURL: () => 'https://a',
      getTitle: () => 'A',
      isLoadingMainFrame: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    let selected = guest;
    let releases = 0;
    const surface = createBrowserPageSurface({
      ensureGuest: async () => guest,
      currentGuest: () => selected,
      state: { pageId: () => 'p1', for: () => record },
      cdp: {
        guestDebugger: async () => ({ sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }) }),
        bounded: async (work) => work,
      },
      viewport: () => ({ width: 800, height: 600, zoom: 1, pixels: { width: 800, height: 600 } }),
      capture: async () => {
        throw new Error('GPU display must not encode a screenshot');
      },
      captureTexture: () => ({
        id: 'gpu1',
        width: 800,
        height: 600,
        send: async () => {
          if (change === 'selection') selected = {};
          else record.documentGeneration += 1;
        },
        release: () => {
          releases++;
        },
      }),
    });
    await assert.rejects(surface.frame('owner', '', undefined, true), /Browser page changed during capture/);
    assert.equal(releases, 1, 'a refused transfer still releases its lease');
  }
});
