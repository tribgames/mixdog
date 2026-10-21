import assert from 'node:assert/strict';
import test from 'node:test';

import { assertBrowserKeyDoesNotAccessClipboard, browserImagePointToCss, createBrowserInputDriver } from './input.ts';

test('browser CDP pointer input keeps CSS coordinates independent of WebContents zoom', async () => {
  const calls = [];
  const guest = { getZoomFactor: () => 0.75 };
  const driver = createBrowserInputDriver(async (_guest, method, params) => {
    calls.push({ method, params });
    return 'completed';
  });

  await driver.clickAt(guest, 440.4, 310.6);
  await driver.hoverAt(guest, 500.2, 320.8);
  await driver.dragAt(guest, { x: 300, y: 200 }, { x: 700, y: 220 });
  await driver.tapAt(guest, { x: 440, y: 311 });
  await driver.swipeAt(guest, { x: 100, y: 120 }, { x: 350, y: 125 });
  await driver.scrollAt(guest, { x: 600, y: 400 }, 120, 180);

  assert.deepEqual(
    calls.slice(0, 3).map(({ params }) => [params.x, params.y]),
    [
      [440, 311],
      [440, 311],
      [440, 311],
    ]
  );
  assert.deepEqual([calls[3].params.x, calls[3].params.y], [500, 321]);
  const dragCalls = calls.filter(({ method, params }) => method === 'Input.dispatchMouseEvent' && params.buttons === 1);
  assert.deepEqual([dragCalls.at(-1).params.x, dragCalls.at(-1).params.y], [700, 220]);
  const touchStarts = calls.filter(
    ({ method, params }) => method === 'Input.dispatchTouchEvent' && params.type === 'touchStart'
  );
  // Touch lands at the CSS point a click would: CDP reads both in CSS pixels,
  // so a zoomed page must not rescale a touch the mouse path leaves alone.
  assert.deepEqual(
    touchStarts.map(({ params }) => [params.touchPoints[0].x, params.touchPoints[0].y]),
    [
      [440, 311],
      [100, 120],
    ]
  );
  const touchMoves = calls.filter(
    ({ method, params }) => method === 'Input.dispatchTouchEvent' && params.type === 'touchMove'
  );
  assert.deepEqual(
    [
      touchMoves[0].params.touchPoints[0].x,
      touchMoves[0].params.touchPoints[0].y,
      touchMoves.at(-1).params.touchPoints[0].x,
      touchMoves.at(-1).params.touchPoints[0].y,
    ],
    [100, 120, 350, 125]
  );
  const wheel = calls.find(({ params }) => params.type === 'mouseWheel');
  assert.deepEqual([wheel.params.x, wheel.params.y, wheel.params.deltaX, wheel.params.deltaY], [600, 400, 120, 180]);
});

test('a page that starts its own HTML5 drag is finished with drag events, never a mouse release', async () => {
  const calls = [];
  const slots = {};
  const driver = createBrowserInputDriver(
    async (_guest, method, params) => {
      calls.push({ method, type: params.type, x: params.x, y: params.y, enabled: params.enabled, data: params.data });
      return 'completed';
    },
    {
      drags: {
        slots: { for: () => slots, peek: () => slots },
        // The page owns the source, and Chromium hands the payload over as
        // soon as the press turns into its own drag.
        evaluate: async () => {
          slots.interceptedDrag = { items: [{ mimeType: 'text/plain', data: 'card-42' }], dragOperationsMask: 1 };
          return true;
        },
      },
    }
  );

  await driver.dragAt({}, { x: 100, y: 100 }, { x: 300, y: 100 });

  assert.deepEqual(
    calls.filter((call) => call.method === 'Input.setInterceptDrags').map((call) => call.enabled),
    [true, false]
  );
  const dragEvents = calls.filter((call) => call.method === 'Input.dispatchDragEvent');
  assert.equal(dragEvents[0].type, 'dragEnter');
  assert.equal(dragEvents.filter((call) => call.type === 'dragOver').length, 8);
  assert.equal(dragEvents.at(-1).type, 'drop');
  assert.deepEqual([dragEvents.at(-1).x, dragEvents.at(-1).y], [300, 100]);
  assert.equal(dragEvents.at(-1).data.items[0].data, 'card-42');
  assert.equal(
    calls.filter((call) => call.type === 'mouseReleased').length,
    0,
    'releasing the button would cancel the drag Chromium is holding'
  );
});

test('typing sends one key event per character, so keydown-driven widgets react', async () => {
  const calls = [];
  const driver = createBrowserInputDriver(async (_guest, method, params) => {
    calls.push({ method, ...params });
    return 'completed';
  });

  await driver.typeText({}, 'Hi.한');

  assert.deepEqual(
    calls.map((call) => [call.method, call.type ?? null, call.key ?? null, call.code ?? null, call.text ?? null]),
    [
      ['Input.dispatchKeyEvent', 'keyDown', 'H', 'KeyH', 'H'],
      ['Input.dispatchKeyEvent', 'keyUp', 'H', 'KeyH', null],
      ['Input.dispatchKeyEvent', 'keyDown', 'i', 'KeyI', 'i'],
      ['Input.dispatchKeyEvent', 'keyUp', 'i', 'KeyI', null],
      ['Input.dispatchKeyEvent', 'keyDown', '.', 'Period', '.'],
      ['Input.dispatchKeyEvent', 'keyUp', '.', 'Period', null],
      // No physical key produces it, so the character is inserted instead.
      ['Input.insertText', null, null, null, '한'],
    ]
  );
  assert.equal(calls[0].modifiers, 8, 'an uppercase letter is Shift plus its key');
  assert.equal(calls[2].modifiers, 0);
});

test('a drag no page claims stays a plain mouse gesture', async () => {
  const calls = [];
  const slots = {};
  const driver = createBrowserInputDriver(
    async (_guest, method, params) => {
      calls.push({ method, type: params.type });
      return 'completed';
    },
    { drags: { slots: { for: () => slots, peek: () => slots }, evaluate: async () => false } }
  );

  await driver.dragAt({}, { x: 100, y: 100 }, { x: 300, y: 100 });

  assert.equal(calls.filter((call) => call.method === 'Input.dispatchDragEvent').length, 0);
  assert.equal(calls.filter((call) => call.type === 'mouseReleased').length, 1);
});

test('a drag source the page owns is waited for until Chromium delivers its payload', async () => {
  const calls = [];
  const slots = {};
  const driver = createBrowserInputDriver(
    async (_guest, method, params) => {
      calls.push({ method, type: params.type, data: params.data });
      return 'completed';
    },
    { drags: { slots: { for: () => slots, peek: () => slots }, evaluate: async () => true } }
  );

  // The renderer runs its own dragstart well after the last move, which is
  // exactly when a busy page hands the payload over.
  setTimeout(() => {
    slots.interceptedDrag = { items: [{ mimeType: 'text/plain', data: 'card-42' }], dragOperationsMask: 1 };
    slots.notifyInterceptedDrag?.(slots.interceptedDrag);
  }, 250);
  await driver.dragAt({}, { x: 100, y: 100 }, { x: 300, y: 100 });

  const dropped = calls.filter((call) => call.type === 'drop');
  assert.equal(dropped.length, 1, 'the late payload still lands as a drop');
  assert.equal(dropped[0].data.items[0].data, 'card-42');
  assert.equal(calls.filter((call) => call.type === 'mouseReleased').length, 0);
});

test('a payload delivered too late belongs to no later gesture', async () => {
  const calls = [];
  const slots = {};
  const driver = createBrowserInputDriver(
    async (_guest, method, params) => {
      calls.push({ method, type: params.type, data: params.data });
      return 'completed';
    },
    { drags: { slots: { for: () => slots, peek: () => slots }, evaluate: async () => false } }
  );

  await driver.dragAt({}, { x: 100, y: 100 }, { x: 300, y: 100 });
  // Chromium answers the abandoned gesture after the driver has let it go.
  slots.interceptedDrag = { items: [{ mimeType: 'text/plain', data: 'stale' }], dragOperationsMask: 1 };
  await driver.dragAt({}, { x: 100, y: 100 }, { x: 300, y: 100 });

  assert.deepEqual(
    calls.filter((call) => call.type === 'drop'),
    [],
    "a stale payload never becomes the next gesture's drop"
  );
  assert.equal(calls.filter((call) => call.type === 'mouseReleased').length, 2);
});

test('dropping files announces the payload before delivering it', async () => {
  const calls = [];
  const driver = createBrowserInputDriver(async (_guest, method, params) => {
    calls.push({ method, type: params.type, files: params.data?.files, x: params.x, y: params.y });
    return 'completed';
  });

  await driver.dropFilesAt({}, { x: 120.4, y: 80.6 }, ['C:\\tmp\\report.pdf']);

  assert.deepEqual(
    calls.map((call) => [call.method, call.type]),
    [
      ['Input.dispatchDragEvent', 'dragEnter'],
      ['Input.dispatchDragEvent', 'dragOver'],
      ['Input.dispatchDragEvent', 'drop'],
    ]
  );
  assert.deepEqual(calls.at(-1).files, ['C:\\tmp\\report.pdf']);
  assert.deepEqual([calls[0].x, calls[0].y], [120, 81]);
});

test('a drop check runs before the payload is announced and again right before the drop; a late refusal cancels', async () => {
  const calls = [];
  const driver = createBrowserInputDriver(async (_guest, method, params) => {
    calls.push(params.type);
    return 'completed';
  });
  let checks = 0;
  await driver.dropFilesAt({}, { x: 1, y: 1 }, ['C:\\tmp\\a.pdf'], undefined, async () => {
    checks++;
    calls.push('check');
  });
  assert.deepEqual(calls, ['check', 'dragEnter', 'dragOver', 'check', 'drop']);
  assert.equal(checks, 2);

  calls.length = 0;
  let seen = 0;
  await assert.rejects(
    driver.dropFilesAt({}, { x: 1, y: 1 }, ['C:\\tmp\\a.pdf'], undefined, async () => {
      // The page's dragover handler swapped an overlay in at the point.
      if (++seen === 2) throw new Error('upload target changed');
    }),
    /upload target changed/
  );
  assert.deepEqual(calls, ['dragEnter', 'dragOver', 'dragCancel'], 'never dropped, the drag session ended');

  calls.length = 0;
  await assert.rejects(
    driver.dropFilesAt({}, { x: 1, y: 1 }, ['C:\\tmp\\a.pdf'], undefined, async () => {
      throw new Error('upload target changed');
    }),
    /upload target changed/
  );
  assert.deepEqual(calls, [], 'a target refused up front sees no drag at all');
});

test('Browser Use keyboard input cannot read or overwrite the system clipboard', () => {
  assert.doesNotThrow(() => assertBrowserKeyDoesNotAccessClipboard('Control+A'));
  assert.throws(() => assertBrowserKeyDoesNotAccessClipboard('Control+V'), /cannot access the system clipboard/);
  assert.throws(() => assertBrowserKeyDoesNotAccessClipboard('Command+C'), /cannot access the system clipboard/);
  assert.throws(() => assertBrowserKeyDoesNotAccessClipboard('Shift+Insert'), /cannot access the system clipboard/);
});

test('agent copy shortcuts are rejected before any input is dispatched', async () => {
  const driver = createBrowserInputDriver(async () => assert.fail('agent clipboard input must not dispatch'));
  for (const key of ['Control+c', 'Control+C', 'Meta+c', 'Meta+C']) {
    await assert.rejects(driver.pressKey({}, key), /cannot access the system clipboard/);
  }
});

test('remote Browser Use maps screenshot pixels through pane zoom for every gesture', () => {
  assert.deepEqual(browserImagePointToCss({ x: 300, y: 200 }, 0.5), { x: 600, y: 400 });
  assert.deepEqual(browserImagePointToCss({ x: 300, y: 200 }, Number.NaN), { x: 300, y: 200 });
});
