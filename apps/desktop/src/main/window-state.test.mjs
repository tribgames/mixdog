import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateWindowState } from './window-state.ts';
import { DESKTOP_WINDOW_MIN_WIDTH } from '../shared/window-layout.ts';

const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

test('window state accepts visible production-sized bounds', () => {
  assert.deepEqual(
    validateWindowState(
      { bounds: { x: 100, y: 80, width: 1280, height: 820 }, maximized: true },
      displays,
    ),
    { bounds: { x: 100, y: 80, width: 1280, height: 820 }, maximized: true },
  );
});

test('window state rejects corrupt, undersized, and disconnected-display bounds', () => {
  assert.equal(validateWindowState(null, displays), null);
  assert.equal(
    validateWindowState({
      bounds: { x: 0, y: 0, width: DESKTOP_WINDOW_MIN_WIDTH - 1, height: 600 },
    }, displays),
    null,
  );
  assert.deepEqual(
    validateWindowState({
      bounds: { x: 0, y: 0, width: DESKTOP_WINDOW_MIN_WIDTH, height: 600 },
    }, displays),
    {
      bounds: { x: 0, y: 0, width: DESKTOP_WINDOW_MIN_WIDTH, height: 600 },
      maximized: false,
    },
  );
  assert.equal(
    validateWindowState({ bounds: { x: 4000, y: 4000, width: 1280, height: 820 } }, displays),
    null,
  );
});
