import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBrowserKeyDoesNotAccessClipboard,
  browserImagePointToCss,
  createBrowserInputDriver,
} from './browser-input.ts';

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
    [[440, 311], [440, 311], [440, 311]],
  );
  assert.deepEqual(
    [calls[3].params.x, calls[3].params.y],
    [500, 321],
  );
  const dragCalls = calls.filter(({ method, params }) => (
    method === 'Input.dispatchMouseEvent' && params.buttons === 1
  ));
  assert.deepEqual(
    [dragCalls.at(-1).params.x, dragCalls.at(-1).params.y],
    [700, 220],
  );
  const touchStarts = calls.filter(({ method, params }) => (
    method === 'Input.dispatchTouchEvent' && params.type === 'touchStart'
  ));
  assert.deepEqual(
    touchStarts.map(({ params }) => [params.touchPoints[0].x, params.touchPoints[0].y]),
    [[587, 415], [133, 160]],
  );
  const touchMoves = calls.filter(({ method, params }) => (
    method === 'Input.dispatchTouchEvent' && params.type === 'touchMove'
  ));
  assert.deepEqual(
    [
      touchMoves[0].params.touchPoints[0].x,
      touchMoves[0].params.touchPoints[0].y,
      touchMoves.at(-1).params.touchPoints[0].x,
      touchMoves.at(-1).params.touchPoints[0].y,
    ],
    [133, 160, 467, 167],
  );
  const wheel = calls.find(({ params }) => params.type === 'mouseWheel');
  assert.deepEqual(
    [wheel.params.x, wheel.params.y, wheel.params.deltaX, wheel.params.deltaY],
    [600, 400, 120, 180],
  );
});

test('Browser Use keyboard input cannot read or overwrite the system clipboard', () => {
  assert.doesNotThrow(() => assertBrowserKeyDoesNotAccessClipboard('Control+A'));
  assert.throws(
    () => assertBrowserKeyDoesNotAccessClipboard('Control+V'),
    /cannot access the system clipboard/,
  );
  assert.throws(
    () => assertBrowserKeyDoesNotAccessClipboard('Command+C'),
    /cannot access the system clipboard/,
  );
  assert.throws(
    () => assertBrowserKeyDoesNotAccessClipboard('Shift+Insert'),
    /cannot access the system clipboard/,
  );
});

test('remote Browser Use maps screenshot pixels through pane zoom for every gesture', () => {
  assert.deepEqual(
    browserImagePointToCss({ x: 300, y: 200 }, 0.5),
    { x: 600, y: 400 },
  );
  assert.deepEqual(
    browserImagePointToCss({ x: 300, y: 200 }, Number.NaN),
    { x: 300, y: 200 },
  );
});
