import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readResponseBuffer, streamResponseToFile } from './bounded-download.mjs';

test('bounded downloads enforce declared and streamed byte limits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-bounded-download-'));
  try {
    const good = join(root, 'good.bin');
    await streamResponseToFile(new Response('hello', {
      headers: { 'content-length': '5' },
    }), good, { maxBytes: 5, expectedBytes: 5, label: 'fixture' });
    assert.equal(readFileSync(good, 'utf8'), 'hello');

    const oversized = join(root, 'oversized.bin');
    await assert.rejects(
      streamResponseToFile(new Response('too large'), oversized, {
        maxBytes: 3,
        label: 'fixture',
      }),
      /byte limit/,
    );
    assert.equal(existsSync(oversized), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded response buffers reject advertised and streamed overflow', async () => {
  assert.equal(
    (await readResponseBuffer(new Response('hello'), { maxBytes: 5, label: 'fixture' })).toString(),
    'hello',
  );
  await assert.rejects(
    readResponseBuffer(new Response('overflow'), { maxBytes: 3, label: 'fixture' }),
    /byte limit/,
  );
});
