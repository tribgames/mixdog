import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPriorityScheduler,
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
