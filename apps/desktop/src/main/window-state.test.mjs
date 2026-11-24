import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { clampBoundsToWorkArea, persistWindowState } from './window-state.ts';

const workArea = { x: 0, y: 0, width: 1280, height: 760 };

test('default 1200x800 bounds are clamped to a 1280x800-class work area', () => {
  const clamped = clampBoundsToWorkArea({ width: 1200, height: 800 }, workArea);
  assert.deepEqual(clamped, { width: 1200, height: 760 });
});

test('saved bounds are moved inside the work area', () => {
  const clamped = clampBoundsToWorkArea({ x: 900, y: 500, width: 1200, height: 800 }, workArea);
  assert.deepEqual(clamped, { width: 1200, height: 760, x: 80, y: 0 });
});

test('maximize-transition resize events never overwrite the stored normal bounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mx-winstate-'));
  const file = join(dir, 'state.json');
  const normal = { x: 10, y: 10, width: 1200, height: 760 };
  const window = Object.assign(new EventEmitter(), {
    maximized: false,
    bounds: normal,
    getNormalBounds: () => normal,
    getBounds() {
      return this.bounds;
    },
    isMaximized() {
      return this.maximized;
    },
    isMinimized: () => false,
    isFullScreen: () => false,
    isDestroyed: () => false,
  });
  const persisted = persistWindowState(window, file);
  window.bounds = { x: 0, y: 0, width: 1280, height: 760 };
  window.emit('resize');
  window.maximized = true;
  window.emit('maximize');
  await persisted.flush();
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(state, { bounds: normal, maximized: true });
  persisted.dispose();
});

test('a window closed right after a resize still saves its final bounds, and later flushes stay usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mx-winstate-'));
  const file = join(dir, 'state.json');
  const final = { x: 30, y: 40, width: 1100, height: 700 };
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    bounds: { x: 10, y: 10, width: 1200, height: 760 },
    getNormalBounds() {
      return this.bounds;
    },
    getBounds() {
      return this.bounds;
    },
    isMaximized() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return false;
    },
    isMinimized: () => false,
    isFullScreen: () => false,
    isDestroyed() {
      return this.destroyed;
    },
  });
  const persisted = persistWindowState(window, file);
  window.bounds = final;
  window.emit('resize');
  window.emit('close');
  window.destroyed = true;
  await persisted.flush();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { bounds: final, maximized: false });
  persisted.dispose();
});
