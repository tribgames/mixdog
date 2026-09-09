import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('media defaults remember lane and model per kind on disk and reject bad input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-media-defaults-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const defaults = await import('./defaults.mjs');
    assert.equal(defaults.getMediaDefault('image'), null, 'nothing remembered yet');

    assert.deepEqual(
      defaults.setMediaDefault({ kind: 'image', lane: ' gemini ', model: 'nano' }),
      { kind: 'image', lane: 'gemini', model: 'nano' },
    );
    assert.deepEqual(defaults.getMediaDefault('image'), { kind: 'image', lane: 'gemini', model: 'nano' });
    assert.equal(existsSync(join(root, 'media', 'defaults.json')), true, 'persisted beside the asset index');

    assert.equal(defaults.getMediaDefault('video'), null, 'kinds are independent');
    defaults.setMediaDefault({ kind: 'video', lane: 'grok' });
    assert.deepEqual(defaults.getMediaDefault('video'), { kind: 'video', lane: 'grok', model: '' });
    assert.deepEqual(defaults.getMediaDefault('image'), { kind: 'image', lane: 'gemini', model: 'nano' }, 'the other kind is untouched');

    assert.throws(() => defaults.setMediaDefault({ kind: 'audio', lane: 'x' }), /kind must be one of/);
    assert.throws(() => defaults.setMediaDefault({ kind: 'image', lane: '  ' }), /lane is required/);
    assert.equal(defaults.getMediaDefault('audio'), null);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
