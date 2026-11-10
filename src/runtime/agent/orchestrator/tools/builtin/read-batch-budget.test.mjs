import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBuiltinTool } from '../builtin.mjs';
import { sliceReadBodyByLines } from './read-batch.mjs';

const lines = (n, tag) => `${Array.from({ length: n }, (_, i) => `${tag}${i + 1} ${'x'.repeat(24)}`).join('\n')}\n`;

test('a large file in a batch of small files is returned whole when the sum fits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-budget-'));
  try {
    await writeFile(join(root, 'big.txt'), lines(480, 'B')); // ~14 KB
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, `${n}.txt`), lines(170, n.toUpperCase())); // ~5 KB
    const out = await executeBuiltinTool(
      'read',
      { file_path: ['big.txt', 'a.txt', 'b.txt', 'c.txt'].map((file_path) => ({ file_path })) },
      root
    );
    assert.match(out, /\bB480 /);
    assert.match(out, /\bC170 /);
    assert.doesNotMatch(out, /output capped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nearby windows of one large file both come back from the shared union read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-budget-'));
  try {
    await writeFile(join(root, 'big.txt'), lines(1103, 'L'));
    const out = await executeBuiltinTool(
      'read',
      {
        file_path: [
          { file_path: 'big.txt', offset: 160, limit: 5 },
          { file_path: 'big.txt', offset: 376, limit: 5 },
        ],
      },
      root
    );
    assert.match(out, /\bL164 /);
    assert.match(out, /\bL376 /);
    assert.match(out, /\bL380 /);
    assert.doesNotMatch(out, /\bL381 /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a window past a truncated union read says it was not returned instead of claiming a range', () => {
  const body = [
    '160→a',
    '161→b',
    '',
    '[output capped at 1 KB; 2 of 900 lines shown (50 KB file); offset:162 for more]',
  ].join('\n');
  const past = sliceReadBodyByLines(body, 375, 5, 1);
  assert.match(past, /lines 376-380 were NOT returned/);
  assert.doesNotMatch(past, /\[lines 376-380/);
});

test('a batch exceeding the budget still truncates and the marker shows the file size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-budget-'));
  try {
    const names = ['a', 'b', 'c', 'd'];
    for (const n of names) await writeFile(join(root, `${n}.txt`), lines(1000, n.toUpperCase())); // ~28 KB each
    const out = await executeBuiltinTool('read', { file_path: names.map((n) => ({ file_path: `${n}.txt` })) }, root);
    assert.match(out, /\[output capped at \d+ KB; \d+ KB file; offset:\d+ for more\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
