import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  cacheRendition,
  createPriorityScheduler,
  pruneRenditionCache,
  videoPosterArguments,
} from './renditions.mjs';

test('video posters seek off frame zero and encode one JPEG without a second still pass', () => {
  const args = videoPosterArguments('clip.mp4', { maxEdge: 512 });
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2), ['-ss', '0.12']);
  assert.equal(args[args.indexOf('-vcodec') + 1], 'mjpeg');
  assert.equal(args.includes('png'), false);
});

test('rendition scheduler bounds work and prioritizes visible requests over queued warmups', async () => {
  const schedule = createPriorityScheduler(2);
  const releases = [];
  const started = [];
  let active = 0;
  let peak = 0;
  const blocked = (name) => schedule(() => new Promise((resolve) => {
    started.push(name);
    active += 1;
    peak = Math.max(peak, active);
    releases.push(() => {
      active -= 1;
      resolve(name);
    });
  }), 'background');
  const first = blocked('background-a');
  const second = blocked('background-b');
  const third = blocked('background-c');
  const foreground = schedule(async () => {
    started.push('foreground');
    active += 1;
    peak = Math.max(peak, active);
    active -= 1;
    return 'foreground';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['background-a', 'foreground'],
    'one slot must stay available for a visible request');
  assert.equal(await foreground, 'foreground');
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['background-a', 'foreground', 'background-b']);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['background-a', 'foreground', 'background-b', 'background-c']);
  releases.shift()();
  await Promise.all([first, second, third]);
  assert.equal(peak, 2);
});

test('rendition files reject oversized entries and obey a total disk budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rendition-cache-'));
  try {
    const first = cacheRendition({
      id: 'first',
      variant: 'thumb',
      mime: 'image/jpeg',
      buffer: Buffer.alloc(10, 1),
      cacheDir: root,
    });
    const second = cacheRendition({
      id: 'second',
      variant: 'thumb',
      mime: 'image/jpeg',
      buffer: Buffer.alloc(10, 2),
      cacheDir: root,
    });
    assert.ok(first && second);
    utimesSync(first.path, new Date(1_000), new Date(1_000));
    const pruned = pruneRenditionCache(root, { maxBytes: 10 });
    assert.equal(pruned.bytes, 10);
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), true);
    assert.equal(cacheRendition({
      id: 'oversized',
      variant: 'thumb',
      mime: 'image/jpeg',
      buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
      cacheDir: root,
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
