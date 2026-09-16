import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { downloadToFileWithRetry, readResponseBuffer, streamResponseToFile } from './bounded-download.mjs';

function downloadPath(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-bounded-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'payload.bin');
}

test('bounded downloads enforce declared and streamed byte limits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-bounded-download-'));
  try {
    const good = join(root, 'good.bin');
    await streamResponseToFile(
      new Response('hello', {
        headers: { 'content-length': '5' },
      }),
      good,
      { maxBytes: 5, expectedBytes: 5, label: 'fixture' }
    );
    assert.equal(readFileSync(good, 'utf8'), 'hello');

    const oversized = join(root, 'oversized.bin');
    await assert.rejects(
      streamResponseToFile(new Response('too large'), oversized, {
        maxBytes: 3,
        label: 'fixture',
      }),
      /byte limit/
    );
    assert.equal(existsSync(oversized), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded response buffers reject advertised and streamed overflow', async () => {
  assert.equal(
    (await readResponseBuffer(new Response('hello'), { maxBytes: 5, label: 'fixture' })).toString(),
    'hello'
  );
  await assert.rejects(readResponseBuffer(new Response('overflow'), { maxBytes: 3, label: 'fixture' }), /byte limit/);
});

test('non-numeric expected sizes are rejected before a destination is created', async (t) => {
  const path = downloadPath(t);
  for (const expectedBytes of [NaN, 'not-a-size']) {
    await assert.rejects(
      streamResponseToFile(new Response('hello'), path, {
        maxBytes: 10,
        expectedBytes,
        label: 'fixture',
      }),
      /expected byte size is invalid/
    );
    assert.equal(existsSync(path), false);
  }
});

test('invalid download limits never fetch or enter the retry loop', async (t) => {
  const path = downloadPath(t);
  let fetches = 0;
  let retries = 0;
  await assert.rejects(
    downloadToFileWithRetry('https://example.test/file', path, {
      maxBytes: 0,
      retryDelaysMs: [0, 0],
      fetchFn: async () => {
        fetches += 1;
        return new Response('hello');
      },
      onRetry: () => {
        retries += 1;
      },
    }),
    /positive byte limit/
  );
  assert.equal(fetches, 0);
  assert.equal(retries, 0);
  assert.equal(existsSync(path), false);
});

test('retry classification follows HTTP status, not terminal words in unrelated errors', async (t) => {
  const path = downloadPath(t);
  let fetches = 0;
  const bytes = await downloadToFileWithRetry('https://example.test/file', path, {
    maxBytes: 10,
    retryDelaysMs: [0],
    fetchFn: async () => {
      fetches += 1;
      if (fetches === 1) throw new Error('connection diagnostic: (terminal) was only log text');
      return new Response('hello');
    },
  });
  assert.equal(fetches, 2);
  assert.equal(bytes, 5);
  assert.equal(readFileSync(path, 'utf8'), 'hello');
});

test('terminal HTTP failures cancel the body without retrying or waiting for cleanup', async (t) => {
  const path = downloadPath(t);
  let fetches = 0;
  let cancelled = 0;
  await assert.rejects(
    downloadToFileWithRetry('https://example.test/file', path, {
      maxBytes: 10,
      retryDelaysMs: [0],
      fetchFn: async () => {
        fetches += 1;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled += 1;
              return new Promise(() => {});
            },
          }),
          { status: 404 }
        );
      },
    }),
    /HTTP 404 \(terminal\)/
  );
  assert.equal(fetches, 1);
  assert.equal(cancelled, 1);
  assert.equal(existsSync(path), false);
});

test('server failures exhaust only the configured retry budget and release every response', async (t) => {
  const path = downloadPath(t);
  const responses = [];
  const retries = [];
  await assert.rejects(
    downloadToFileWithRetry('https://example.test/file', path, {
      maxBytes: 10,
      retryDelaysMs: [0, 0],
      fetchFn: async () => {
        const response = new Response('busy', { status: 503 });
        responses.push(response);
        return response;
      },
      onRetry: ({ attempt }) => retries.push(attempt),
    }),
    /HTTP 503/
  );
  assert.equal(responses.length, 3);
  assert.deepEqual(retries, [1, 2]);
  assert.ok(responses.every((response) => response.bodyUsed));
  assert.equal(existsSync(path), false);
});

test('progress callback failures reject and clean up instead of crashing the process', (t) => {
  const path = downloadPath(t);
  const source = `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { streamResponseToFile } from ${JSON.stringify(new URL('./bounded-download.mjs', import.meta.url).href)};
    for (const failAt of [1, 2]) {
      const failure = new Error('progress observer failed');
      let calls = 0;
      await assert.rejects(streamResponseToFile(new Response('hello'), process.env.DOWNLOAD_TEST_PATH, {
        maxBytes: 10,
        onProgress() { if (++calls === failAt) throw failure; },
      }), (error) => error === failure);
      assert.equal(existsSync(process.env.DOWNLOAD_TEST_PATH), false);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, DOWNLOAD_TEST_PATH: path },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
