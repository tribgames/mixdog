import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageSurface } from './page-surface.ts';
import { normalizeBrowserPageControl } from '../../shared/browser-page-control.ts';

test('viewport changes discard old captures and cached images instead of stretching them into new geometry', async () => {
  const record = { documentGeneration: 1 };
  const guest = {
    id: 7, isDestroyed: () => false, getURL: () => 'https://a', getTitle: () => 'A',
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
      bounded: async work => work,
    },
    viewport: () => ({ width, height: 600, zoom: 1 }),
    capture: (...args) => capture(...args),
  });
  const first = await surface.frame('owner');
  let resolve;
  capture = () => new Promise(done => { resolve = done; });
  const old = surface.frame('owner');
  await new Promise(done => setImmediate(done));
  const finish = surface.beginViewportChange(guest);
  await assert.rejects(surface.frame('owner'), /page changed during capture/);
  resolve({ data: 'obsolete', width: 800, height: 600, mimeType: 'image/png', fullPage: false });
  await assert.rejects(old, /page changed during capture/);
  width = 390;
  finish();
  capture = async () => { throw new Error('UnknownVizError'); };
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
        ensureGuest: async () => guest, currentGuest: () => selected,
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
          sendCdpInput: async (...args) => { sent.push(args); },
        },
      });
      await assert.rejects(surface.control('owner', { ...input, documentId: 'p1:1' }, controller.signal),
        reason === 'cancel' ? /cancelled/ : reason === 'dialog' ? /dialog is blocking/ : /page changed/);
      assert.deepEqual(sent, []);
    }
  }
});

test('geometry updates bypass blocked execution but still respect document and session ownership', async () => {
  const sizes = [];
  const guest = { isDestroyed: () => false };
  const record = { documentGeneration: 1, pendingDialog: {} };
  let selected = guest;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest, currentGuest: () => selected,
    state: { pageId: () => 'p1', for: () => record },
    cdp: { waitForIdle: async () => { throw new Error('must not wait'); } },
    resize: (_guest, width, height) => sizes.push([width, height]),
  });
  const input = { type: 'resize', width: 1000, height: 700, documentId: 'p1:1' };
  await surface.control('owner', input);
  await assert.rejects(surface.control('owner', { ...input, documentId: 'p1:0' }), /page changed/);
  selected = {};
  await assert.rejects(surface.control('owner', input), /page changed/);
  assert.deepEqual(sizes, [[1000, 700]]);
});

test('native recovery bypasses cleanup and dialogs but still checks document ownership and cancellation', async () => {
  const sent = [];
  const guest = {
    isDestroyed: () => false,
    stop: () => sent.push('stop'), reload: () => sent.push('reload'),
  };
  const record = { documentGeneration: 1, pendingDialog: {} };
  let selected = guest;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest, currentGuest: () => selected,
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: { waitForIdle: async () => { throw new Error('cleanup still blocked'); } },
  });
  for (const type of ['stop', 'reload']) {
    await surface.control('owner', { type, documentId: 'p1:1' });
    await assert.rejects(surface.control('owner', { type, documentId: 'p1:0' }), /page changed/);
    selected = {};
    await assert.rejects(surface.control('owner', { type, documentId: 'p1:1' }), /page changed/);
    selected = guest;
    await assert.rejects(surface.control('owner', { type, documentId: 'p1:1' },
      AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  }
  await assert.rejects(surface.control('owner', { type: 'text', text: 'never', documentId: 'p1:1' }),
    /cleanup still blocked/);
  assert.deepEqual(sent, ['stop', 'reload']);
});

test('local input admission rejects unbounded data and preserves a validated document token', () => {
  assert.deepEqual(normalizeBrowserPageControl({ type: 'text', text: '한글', documentId: 'p1:2' }), {
    type: 'text', text: '한글', documentId: 'p1:2',
  });
  for (const type of ['select-tab', 'close-tab']) {
    assert.deepEqual(normalizeBrowserPageControl({ type, tabId: 'p2', documentId: 'p1:2' }), {
      type, tabId: 'p2', documentId: 'p1:2',
    });
    assert.throws(() => normalizeBrowserPageControl({ type, tabId: '../other', documentId: 'p1:2' }));
  }
  assert.deepEqual(normalizeBrowserPageControl({ type: 'new-tab', documentId: 'p1:2' }), {
    type: 'new-tab', documentId: 'p1:2',
  });
  for (const input of [
    { type: 'text', text: 'x', documentId: 'other' },
    { type: 'text', text: 'x'.repeat(32_001), documentId: 'p1:2' },
    { type: 'resize', width: Infinity, height: 600, documentId: 'p1:2' },
    { type: 'zoom', factor: 100, documentId: 'p1:2' },
    { type: 'pointer', phase: 'unknown', documentId: 'p1:2' },
  ]) assert.throws(() => normalizeBrowserPageControl(input));
});

test('a rejected display sample serves the last good frame until the outage outlasts the grace window', async () => {
  let now = 1_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const record = { documentGeneration: 1 };
    const guest = {
      id: 7, isDestroyed: () => false, getURL: () => 'https://a', getTitle: () => 'A',
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
        bounded: async work => work,
      },
      viewport: () => ({ width: 800, height: 600, zoom: 1 }),
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
    await assert.rejects(surface.frame('owner', first.frameId), /UnknownVizError/,
      'a new document must not inherit the previous document image during the grace window');
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
    await assert.rejects(surface.control('owner', { type: 'text', text: 'never', documentId: 'p1:1' }, controller.signal),
      reason !== 'cancel' ? /page changed/ : /cancelled/);
    assert.deepEqual(sent, []);
  }
});

test('display metadata remains available while page execution is fenced and never cancels that execution', async () => {
  const record = { documentGeneration: 1 };
  const guest = {
    id: 7, isDestroyed: () => false, getURL: () => 'https://a', getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  let nativeViewport = { width: 390, height: 844, zoom: 1 };
  let pageScale = 1;
  let targetReplaced = false;
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => record },
    cdp: {
      waitForIdle: async () => { throw new Error('execution is fenced'); },
      evaluate: async () => { throw new Error('execution is fenced'); },
      guestDebugger: async () => ({
        sendCommand: async method => {
          if (method !== 'Page.getLayoutMetrics') throw new Error('display must not execute or terminate scripts');
          if (targetReplaced) throw new Error('target closed while handling command');
          return { cssVisualViewport: { scale: pageScale } };
        },
      }),
      bounded: async work => work,
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
    nativeViewport = sample;
    pageScale = sample.pageScale;
    const next = await surface.frame('owner');
    assert.deepEqual([next.viewportWidth, next.viewportHeight], sample.expected);
  }
  targetReplaced = true;
  await assert.rejects(surface.frame('owner'), /Browser page changed during capture/);
  targetReplaced = false;
  assert.equal((await surface.frame('owner')).documentId, 'p1:1');
});
