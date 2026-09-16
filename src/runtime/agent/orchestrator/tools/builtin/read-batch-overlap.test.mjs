import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBuiltinTool } from '../builtin.mjs';
import { mergeOverlappingReadEntries } from './read-batch.mjs';

const lines = (n) => Array.from({ length: n }, (_, i) => `L${i + 1} ${'x'.repeat(24)}`).join('\n') + '\n';
const count = (text, re) => (text.match(re) || []).length;

test('overlapping windows of one file render once; adjacent windows stay separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-overlap-'));
  try {
    await writeFile(join(root, 'f.txt'), lines(120));
    const out = await executeBuiltinTool(
      'read',
      {
        file_path: [
          { file_path: 'f.txt', offset: 10, limit: 20 }, // 10..29
          { file_path: 'f.txt', offset: 25, limit: 20 }, // 25..44 overlaps 25..29 → merged
          { file_path: 'f.txt', offset: 45, limit: 5 }, // 45..49 adjacent → separate block
        ],
      },
      root
    );
    assert.match(out, /^read 2\b/m);
    assert.equal(count(out, /f\.txt \[ok\]/g), 2);
    assert.equal(count(out, /\bL27 /g), 1, 'overlapping line delivered once');
    assert.equal(count(out, /\bL10 /g), 1);
    assert.equal(count(out, /\bL44 /g), 1);
    assert.equal(count(out, /\bL45 /g), 1);
    assert.equal(count(out, /\bL49 /g), 1);
    assert.equal(count(out, /\bL50 /g), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gapped windows stay separate and unrequested lines are not delivered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-read-gap-'));
  try {
    await writeFile(join(root, 'f.txt'), lines(120));
    const out = await executeBuiltinTool(
      'read',
      {
        file_path: [
          { file_path: 'f.txt', offset: 10, limit: 20 }, // 10..29
          { file_path: 'f.txt', offset: 35, limit: 10 }, // 35..44
        ],
      },
      root
    );
    assert.match(out, /^read 2\b/m);
    assert.equal(count(out, /\bL29 /g), 1);
    assert.equal(count(out, /\bL32 /g), 0, 'gap line not delivered');
    assert.equal(count(out, /\bL35 /g), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mergeOverlappingReadEntries leaves other files, adjacent, implicit and full reads untouched', () => {
  const raw = [
    { path: 'a', offset: 0, limit: 10 },
    { path: 'b', offset: 5, limit: 10 },
    { path: 'a' }, // implicit default read
    { path: 'a', full: true }, // whole-file read
    { path: 'a', offset: 8, limit: 4 }, // overlaps entry 0 → merged into it
    { path: 'a', offset: 12, limit: 3 }, // adjacent to merged 0..11 → separate
  ];
  const out = mergeOverlappingReadEntries(raw);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { path: 'a', offset: 0, limit: 12 });
  assert.deepEqual(out[1], raw[1]);
  assert.equal(out[2], raw[2]);
  assert.equal(out[3], raw[3]);
  assert.equal(out[4], raw[5]);
});
