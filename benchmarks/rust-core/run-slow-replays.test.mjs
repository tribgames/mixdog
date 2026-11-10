// The runner's own failures fail a run: a process listing it could not make, and a deadline whose ending of the test failed.
//   node --test benchmarks/rust-core/run-slow-replays.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runTest } from './run-slow-replays.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'slow-replay-runner-'));

test('a listing of what a test left running that fails fails the run', { timeout: 60_000 }, async () => {
  const dir = folder();
  const result = await runTest({ name: 'quick', dir, log: join(dir, 'quick.log'), command: process.execPath, args: ['-e', ''], cwd: dir, env: process.env, powershell: join(dir, 'no-such-powershell.exe') });
  assert.match(result.problems.join('\n'), /the listing of the processes left in .+ failed/);
});

test('the deadline settles the run as failed when ending the test fails', { timeout: 60_000 }, async () => {
  const dir = folder();
  const result = await runTest({ name: 'hangs', dir, log: join(dir, 'hangs.log'), command: process.execPath, args: ['-e', 'setInterval(() => {}, 1e9)'], cwd: dir, env: process.env, deadlineMs: 2_000, taskkill: join(dir, 'no-such-taskkill.exe') });
  try {
    assert.equal(result.problems[0], 'deadline of 2 s');
    assert.match(result.problems[1], /^ending the test \(pid \d+\) failed: /);
  } finally {
    process.kill(result.pid);
  }
});
