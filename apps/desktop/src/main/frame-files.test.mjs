import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDirectory = await mkdtemp(join(tmpdir(), 'mixdog-frames-'));
process.env.MIXDOG_DATA_DIR = dataDirectory;
const { persistFrameImage, setFrameRemoverForTest } = await import('./frame-files.ts');
test.after(() => rm(dataDirectory, { recursive: true, force: true }));

const image = (text) => ({ mimeType: 'image/png', data: Buffer.from(text).toString('base64') });

test('persistFrameImage writes asynchronously, prunes old frames and keeps the newest', async () => {
  const directory = join(dataDirectory, 'browser-frames');
  // A frame from an earlier run is found by the first scan and ages out first.
  await mkdir(directory, { recursive: true });
  const old = join(directory, 'old-run.png');
  await writeFile(old, 'x');
  await utimes(old, new Date(1_000), new Date(1_000));

  const pending = persistFrameImage('browser', 's', 'first', image('first'));
  assert.ok(pending instanceof Promise);
  const first = await pending;
  assert.equal(first.bytes, 5);
  assert.equal(first.path, join(directory, 's-first.png'));

  for (let index = 0; index < 45; index += 1) {
    const stored = await persistFrameImage('browser', 's', `f${index}`, image(`frame-${index}`));
    assert.ok(stored);
  }
  const names = await readdir(directory);
  assert.equal(names.length, 40);
  assert.ok(names.includes('s-f44.png'), 'the newest frame survives');
  assert.ok(!names.includes('old-run.png'), 'the oldest frame is pruned');
});

test('a delayed eviction never deletes a frame rewritten after the prune decision', async (t) => {
  const directory = join(dataDirectory, 'computer-frames');
  for (let index = 0; index < 40; index += 1) {
    await persistFrameImage('computer', 's', `f${index}`, image(`frame-${index}`));
  }
  const f0 = join(directory, 's-f0.png');
  const delayed = [];
  const { unlink } = await import('node:fs/promises');
  setFrameRemoverForTest(
    (path) =>
      new Promise((resolve) => {
        delayed.push(() =>
          unlink(path)
            .catch(() => undefined)
            .then(resolve)
        );
        setTimeout(delayed.at(-1), 50);
      })
  );
  t.after(() => setFrameRemoverForTest());
  // The 41st frame evicts f0; its unlink is slow while f0 is rewritten.
  const evicting = persistFrameImage('computer', 's', 'f40', image('frame-40'));
  const rewriting = persistFrameImage('computer', 's', 'f0', image('fresh-f0'));
  const [, rewritten] = await Promise.all([evicting, rewriting]);
  assert.equal(rewritten.path, f0);
  const names = await readdir(directory);
  assert.ok(names.includes('s-f0.png'), 'the rewritten frame still exists');
  assert.ok(names.includes('s-f40.png'));
  assert.equal(names.length, 40);
});

test('persistFrameImage returns nothing for an empty or invalid image', async () => {
  assert.equal(await persistFrameImage('computer', 's', 'bad', { mimeType: 'image/png', data: '' }), undefined);
});
