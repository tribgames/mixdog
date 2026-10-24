import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDispatch } from './input-dispatch.ts';

test('offscreen child-frame input uses child coordinates and rechecks local ownership at dispatch', async () => {
  const sent = [];
  let current = true;
  const dispatch = createBrowserInputDispatch({
    documentId: () => 'document',
    frames: () => new Map([['child-session', { frameId: 'child-frame' }]]),
    frameOffset: async () => ({ x: 100, y: 200 }),
    cdp: {
      call: async (_guest, _method, params) => {
        assert.equal(params.x, 120);
        assert.equal(params.y, 230);
        return { frameId: 'child-frame' };
      },
      guestDebugger: async () => ({}),
      sendCdpInput: async (_guest, _cdp, method, params, _signal, session, guard) => {
        guard?.();
        sent.push({ method, params, session });
        return 'completed';
      },
    },
  });
  const input = { type: 'mousePressed', x: 120.25, y: 230.25 };
  const guard = () => {
    if (!current) throw new Error('document changed');
  };
  await dispatch(
    { isOffscreen: () => true, getZoomFactor: () => 1 },
    'Input.dispatchMouseEvent',
    input,
    undefined,
    guard
  );
  assert.deepEqual(sent, [
    {
      method: 'Input.dispatchMouseEvent',
      params: { ...input, x: 20.25, y: 30.25 },
      session: 'child-session',
    },
  ]);
  current = false;
  await assert.rejects(
    dispatch({ isOffscreen: () => true, getZoomFactor: () => 1 }, 'Input.dispatchMouseEvent', input, undefined, guard),
    /document changed/
  );
  assert.equal(sent.length, 1);
});

test('ordinary keys and text are sent to whatever document is committed; only the caller guard can stop them', async () => {
  let document = 'document-1';
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const sent = [];
  const dispatch = createBrowserInputDispatch({
    documentId: () => document,
    frames: () => new Map(),
    cdp: {
      call: async () => assert.fail('a key needs no hit test'),
      guestDebugger: () => ready,
      sendCdpInput: async (_guest, _cdp, method, params, _signal, _session, guard) => {
        guard();
        sent.push({ method, params });
        return 'completed';
      },
    },
  });
  const guest = { isOffscreen: () => false, getZoomFactor: () => 1 };
  const key = { type: 'rawKeyDown', key: 'Enter' };
  const pressed = dispatch(guest, 'Input.dispatchKeyEvent', key);
  document = 'document-2'; // the page navigates while the debugger is not ready
  release({});
  await pressed; // as before: no document rule of its own for non-mouse input
  const typed = await dispatch(guest, 'Input.dispatchKeyEvent', { type: 'char', text: 'a' });
  assert.equal(typed, 'completed');
  assert.equal(sent.length, 2);
  sent.length = 0;
  // The caller's own page guard (the saved-login sign-in passes one) runs
  // right before the send and can still stop the key.
  let url = 'https://a.test/';
  const bound = dispatch(guest, 'Input.dispatchKeyEvent', key, undefined, () => {
    if (url !== 'https://a.test/') throw new Error('url changed');
  });
  url = 'https://b.test/';
  await assert.rejects(bound, /url changed/);
  assert.deepEqual(sent, []);
  // An undisturbed key still goes out.
  await dispatch(guest, 'Input.dispatchKeyEvent', key);
  assert.equal(sent.length, 1);
});

test('emulated input compensates host zoom without scaling normal desktop CSS coordinates', async () => {
  for (const layoutZoom of [0.75, 1]) {
    const sent = [];
    const guest = { getZoomFactor: () => 0.75 };
    const dispatch = createBrowserInputDispatch({
      documentId: () => 'document',
      frames: () => new Map(),
      cdp: {
        call: async (_guest, method) => {
          assert.equal(method, 'Page.getLayoutMetrics');
          return { cssVisualViewport: { zoom: layoutZoom } };
        },
        guestDebugger: async () => ({}),
        sendCdpInput: async (_guest, _cdp, _method, input, _signal, _session, guard) => {
          guard();
          sent.push(input);
          return 'completed';
        },
      },
    });
    await dispatch(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 225 });
    await dispatch(guest, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 225, id: 0 }] });
    const expected = layoutZoom === 1 ? { x: 200, y: 300 } : { x: 150, y: 225 };
    assert.deepEqual(sent[0], { type: 'mousePressed', ...expected });
    assert.deepEqual(sent[1].touchPoints, [{ ...expected, id: 0 }]);
  }
});
