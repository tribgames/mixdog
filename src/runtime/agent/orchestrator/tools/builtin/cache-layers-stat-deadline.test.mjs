import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lstatPathsForMtime, statPathsForMtime } from './cache-layers.mjs';

// Real-timer references: the watchdog must still fire while mock timers are installed.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('statPathsForMtime: a hung stat resolves to a null-stat entry at the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = () => new Promise(() => {});
  let settled = false;
  const pending = statPathsForMtime(['never.txt'], process.cwd(), 4, { deadlineMs: 50, _statImpl: hung }).then(
    (entries) => {
      settled = true;
      return entries;
    }
  );
  await turn();
  t.mock.timers.tick(49);
  await turn();
  assert.equal(settled, false, 'still pending one millisecond before the deadline');
  t.mock.timers.tick(1);
  let watchdog;
  const [entry] = await Promise.race([
    pending,
    new Promise((_, reject) => {
      watchdog = realSetTimeout(() => reject(new Error('not resolved at the deadline')), 3_000);
    }),
  ]).finally(() => realClearTimeout(watchdog));
  assert.equal(entry.stat, null);
  assert.equal(entry.size, 0);
  assert.equal(entry.mtimeMs, 0);
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
