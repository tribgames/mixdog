import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CAPTURE_BYTES, runProcess } from './process.mjs';
import { FILES_PER_SPAWN, chunkFiles, runChunked } from './runners/shared.mjs';

test('runProcess marks truncated when stdout exceeds the capture cap', async () => {
  const cap = 64;
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(200))'], {
    timeoutMs: 10_000,
    maxCaptureBytes: cap,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, cap);
  assert.equal(result.error, '');
  assert.ok(MAX_CAPTURE_BYTES >= 1024 * 1024);
});

test('runProcess does not mark truncated when output fits', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    timeoutMs: 10_000,
    maxCaptureBytes: 64,
  });
  assert.equal(result.truncated, false);
  assert.equal(result.stdout, 'ok');
});

test('runChunked splits file lists and ORs the truncated flag', async () => {
  assert.deepEqual(chunkFiles(['a', 'b', 'c', 'd'], 2), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.equal(FILES_PER_SPAWN, 80);
  const calls = [];
  const result = await runChunked({
    bin: 'engine',
    baseArgs: ['--flag'],
    files: ['a.js', 'b.js', 'c.js'],
    cwd: '/repo',
    filesPerSpawn: 2,
    run: async (bin, args) => {
      calls.push({ bin, args });
      return {
        code: 0,
        stdout: `out:${args.at(-1)}`,
        stderr: '',
        truncated: args.includes('b.js'),
        error: '',
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['--flag', 'a.js', 'b.js']);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, 'out:b.jsout:c.js');
});
