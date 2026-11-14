import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeScreenDisplay } from '../remote-screen/screen-geometry.ts';
import { HOST_SCREEN_DISPLAYS, registerScreenDisplaysHost } from './screen-displays.ts';

function serve(list) {
  const handlers = new Map();
  registerScreenDisplaysHost({ handleRequest: (method, handler) => handlers.set(method, handler) }, () => ({ list }));
  return (params) => handlers.get(HOST_SCREEN_DISPLAYS)(params, new AbortController().signal);
}

const display = (id, primary) => ({
  screenId: id,
  label: `Display ${id}`,
  primary,
  scaleFactor: 1.5,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  captureSourceId: `screen:${id}:0`,
});

test('displays are forwarded as the summaries the screen sources give', async () => {
  const call = serve(async () => [display('1', true), display('2', false)].map(summarizeScreenDisplay));
  assert.deepEqual(await call({}), [
    { screenId: '1', label: 'Display 1', primary: true, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1.5 },
    { screenId: '2', label: 'Display 2', primary: false, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1.5 },
  ]);
});

test('no display with a capture source answers an empty list', async () => {
  assert.deepEqual(await serve(() => [])({}), []);
});

test('a provider failure (no screen source on this PC) reaches the core', async () => {
  const call = serve(async () => {
    throw new Error('Remote screen is unavailable.');
  });
  await assert.rejects(call({}), /Remote screen is unavailable/);
});

test('non-object params are refused with -32602', async () => {
  const call = serve(() => []);
  for (const bad of [null, undefined, [], 'x', 3]) {
    await assert.rejects(call(bad), (error) => error.code === -32602);
  }
});
