import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lstatPathsForMtime, statPathsForMtime } from './cache-layers.mjs';

test('statPathsForMtime: a hung stat resolves to a null-stat entry at the deadline', async () => {
  const hung = () => new Promise(() => {});
  const started = Date.now();
  const [entry] = await statPathsForMtime(['never.txt'], process.cwd(), 4, { deadlineMs: 50, _statImpl: hung });
  assert.equal(entry.stat, null);
  assert.equal(entry.size, 0);
  assert.equal(entry.mtimeMs, 0);
  assert.ok(Date.now() - started < 5000);
});

test('lstatPathsForMtime: real, duplicate and missing paths keep their index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-layers-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'abc');
    let calls = 0;
    const counting = (path) => {
      calls += 1;
      return lstat(path);
    };
    const out = await lstatPathsForMtime([file, file, join(dir, 'missing.txt')], dir, 2, { _lstatImpl: counting });
    assert.equal(out[0].size, 3);
    assert.equal(out[1].size, 3);
    assert.equal(out[2].stat, null);
    assert.equal(calls, 2, 'a repeated path is stat-ed once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
