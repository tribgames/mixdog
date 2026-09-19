import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  cacheRendition,
  createPriorityScheduler,
  ensureRendition,
  pruneRenditionCache,
  videoPosterArguments,
} from './renditions.mjs';

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

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
  const blocked = (name) =>
    schedule(
      () =>
        new Promise((resolve) => {
          started.push(name);
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve(name);
          });
        }),
      'background'
    );
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
  assert.deepEqual(started, ['background-a', 'foreground'], 'one slot must stay available for a visible request');
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
    assert.equal(
      cacheRendition({
        id: 'oversized',
        variant: 'thumb',
        mime: 'image/jpeg',
        buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
        cacheDir: root,
      }),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache-miss stills generate a valid webp rendition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rendition-generate-'));
  try {
    const sourcePath = join(root, 'source.png');
    writeFileSync(sourcePath, PIXEL_PNG);
    const result = await ensureRendition({
      id: 'still-miss',
      kind: 'image',
      sourcePath,
      variant: 'thumb',
      cacheDir: root,
    });
    assert.ok(result);
    assert.equal(result.mime, 'image/webp');
    assert.ok(result.bytes > 0);
    assert.equal(existsSync(result.path), true);
    const body = readFileSync(result.path);
    assert.equal(body.toString('ascii', 0, 4), 'RIFF');
    assert.equal(body.toString('ascii', 8, 12), 'WEBP');
    assert.equal(body.length, result.bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generate:false skips creation on a cache miss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rendition-nogen-'));
  try {
    const sourcePath = join(root, 'source.png');
    writeFileSync(sourcePath, PIXEL_PNG);
    const result = await ensureRendition({
      id: 'still-nogen',
      kind: 'image',
      sourcePath,
      variant: 'thumb',
      cacheDir: root,
      generate: false,
    });
    assert.equal(result, null);
    assert.equal(existsSync(join(root, 'thumb')), false);
    assert.equal(existsSync(join(root, 'display')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cached rendition reads still succeed without regenerating', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rendition-cached-'));
  try {
    const sourcePath = join(root, 'source.png');
    writeFileSync(sourcePath, PIXEL_PNG);
    const created = await ensureRendition({
      id: 'still-cached',
      kind: 'image',
      sourcePath,
      variant: 'thumb',
      cacheDir: root,
    });
    assert.ok(created);
    const cached = await ensureRendition({
      id: 'still-cached',
      kind: 'image',
      sourcePath,
      variant: 'thumb',
      cacheDir: root,
      generate: false,
    });
    assert.deepEqual(
      { path: cached.path, mime: cached.mime, bytes: cached.bytes },
      { path: created.path, mime: created.mime, bytes: created.bytes }
    );
    assert.equal(existsSync(created.path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
