import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  GLIDE_SEED_OFFSET,
  glideAllowed,
  glideFinished,
  glidePosition,
  planGlide,
  seedGlideStart,
} from './cursor-glide.ts';

const display = { x: 0, y: 0, width: 1920, height: 1080 };

test('only background action effects travel; foreground and tracking movement stay put', () => {
  assert.equal(glideAllowed({ mode: 'background', effect: 'prepare' }), true);
  assert.equal(glideAllowed({ mode: 'background', effect: 'click' }), true);
  assert.equal(glideAllowed({ mode: 'background', effect: 'type' }), true);
  assert.equal(glideAllowed({ mode: 'background', effect: 'move' }), false);
  assert.equal(glideAllowed({ mode: 'background', effect: 'drag' }), false);
  assert.equal(glideAllowed({ mode: 'foreground', effect: 'click' }), false);
});

test('a never-shown pointer seeds up-left inside its display and never collapses onto the target', () => {
  assert.deepEqual(seedGlideStart({ x: 800, y: 600 }, display), {
    x: 800 - GLIDE_SEED_OFFSET,
    y: 600 - GLIDE_SEED_OFFSET,
  });
  assert.deepEqual(seedGlideStart({ x: 3, y: 3 }, display), { x: 3 + GLIDE_SEED_OFFSET, y: 3 + GLIDE_SEED_OFFSET });
  const edge = seedGlideStart({ x: 1919, y: 1079 }, display);
  assert.ok(edge.x >= display.x && edge.x <= display.x + display.width);
  assert.ok(edge.y >= display.y && edge.y <= display.y + display.height);
  const offset = seedGlideStart({ x: 2600, y: 100 }, { x: 2560, y: 0, width: 1440, height: 2560 });
  assert.ok(offset.x >= 2560, 'seed stays on the display that holds the target');
});

test('travel time follows distance within bounds and lands exactly on the target', () => {
  assert.equal(planGlide({ x: 10, y: 10 }, { x: 12, y: 11 }, display), null, 'tiny moves do not animate');
  const short = planGlide({ x: 0, y: 0 }, { x: 30, y: 40 }, display);
  assert.equal(short.durationMs, GLIDE_MIN_MS);
  const long = planGlide({ x: 0, y: 0 }, { x: 1900, y: 1000 }, display);
  assert.equal(long.durationMs, GLIDE_MAX_MS, 'the worker waits at most this long before acting');
  assert.deepEqual(glidePosition(long, 0), { x: 0, y: 0 });
  assert.deepEqual(glidePosition(long, long.durationMs), { x: 1900, y: 1000 });
  assert.deepEqual(glidePosition(long, long.durationMs * 5), { x: 1900, y: 1000 });
  const midway = glidePosition(long, long.durationMs / 2);
  assert.deepEqual(midway, { x: 950, y: 500 });
  const early = glidePosition(long, long.durationMs / 4);
  assert.ok(early.x < 950 / 2, 'ease-in starts slowly');
  assert.equal(glideFinished(long, long.durationMs - 1), false);
  assert.equal(glideFinished(long, long.durationMs), true);
  const seeded = planGlide(undefined, { x: 800, y: 600 }, display);
  assert.deepEqual(seeded.from, { x: 800 - GLIDE_SEED_OFFSET, y: 600 - GLIDE_SEED_OFFSET });
});
