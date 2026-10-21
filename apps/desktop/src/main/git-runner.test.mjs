import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runProcessOffThread } from '../../../../src/runtime/shared/process-runner.mjs';
import {
  GIT_READ_TIMEOUT_MS,
  isGitTimeout,
  run,
  runRead,
  runWithInput,
  runWithStatus,
  setGitProcessRunner,
  streamNulRecords,
} from './git-runner.ts';
import { gitReview } from './git-history.ts';
import { gitStatus } from './git-status.ts';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b c.txt'), 'b\n');
  return root;
}

/** Largest gap between 5 ms ticks while `run()` is awaited. */
async function maxLoopGap(run) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await run();
    return Math.max(max, performance.now() - last);
  } finally {
    clearInterval(timer);
  }
}

test('with the daemon runner set, every git child starts off-thread with the same results', async (t) => {
  const root = repo(t);
  const commands = [];
  setGitProcessRunner((command, args, options) => {
    commands.push({ command, args, env: options.env });
    return runProcessOffThread(command, args, options);
  });
  t.after(() => setGitProcessRunner(null));

  assert.equal((await run(root, ['rev-parse', '--is-inside-work-tree'])).trim(), 'true');
  const records = [];
  await streamNulRecords(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], (record) =>
    records.push(record)
  );
  assert.deepEqual(records.sort(), ['? a.txt', '? b c.txt']);
  // `config --get` answers 1 for "not set": the exit code is kept, not thrown.
  const unset = await runWithStatus(root, ['config', '--get', 'mixdog.test-unset']);
  assert.equal(unset.code, 1);
  assert.equal(unset.stdout, '');
  assert.equal((await runWithInput(root, ['hash-object', '--stdin'], 'a\n')).trim().length, 40);
  await assert.rejects(run(root, ['rev-parse', '--verify', 'no-such-ref']), /no-such-ref|Needed a single revision/);
  await assert.rejects(
    streamNulRecords(root, ['no-such-command'], () => {}),
    /no-such-command|not a git command/
  );
  assert.ok(commands.length >= 6 && commands.every((call) => call.command === 'git'));
  assert.equal(commands[0].env.GIT_TERMINAL_PROMPT, '0', 'the scrubbed git environment travels with each child');
});

test('reads carry the read deadline; writes stay unbounded', async (t) => {
  const timeouts = [];
  setGitProcessRunner(async (_command, _args, options) => {
    timeouts.push(options.timeoutMs);
    return { code: 0, stdout: '', stderr: '' };
  });
  t.after(() => setGitProcessRunner(null));
  await runRead(tmpdir(), ['status']);
  await run(tmpdir(), ['commit']);
  assert.deepEqual(timeouts, [GIT_READ_TIMEOUT_MS, 0]);
});

// A git child that never answers (here an alias that sleeps) must not hold
// its caller: in-thread and off-thread alike it is cut off at the deadline.
for (const offThread of [false, true]) {
  test(`a hung git read is cut off at its deadline (${offThread ? 'off-thread' : 'in-thread'})`, async (t) => {
    if (offThread) {
      setGitProcessRunner(runProcessOffThread);
      t.after(() => setGitProcessRunner(null));
    }
    const started = Date.now();
    await assert.rejects(
      streamNulRecords(tmpdir(), ['-c', 'alias.hang=!sleep 5', 'hang'], () => {}, { timeoutMs: 300 }),
      /timed out/
    );
    assert.ok(Date.now() - started < 3_000, 'the read settled at its deadline, not when the child ended');
  });
}

test('a timed-out read fails status and review instead of answering "no changes"', async (t) => {
  const root = repo(t);
  const children = [];
  setGitProcessRunner((command, args, options) => {
    if (args.includes('status')) {
      return Promise.reject(Object.assign(new Error('git status timed out after 60000ms'), { code: 'ETIMEDOUT' }));
    }
    const child = runProcessOffThread(command, args, options);
    children.push(child);
    return child;
  });
  t.after(() => setGitProcessRunner(null));
  await assert.rejects(gitStatus(root), /timed out/);
  await assert.rejects(gitReview(root, 'uncommitted'), /timed out/);
  // The reads started beside the scan still run in the repository; let them
  // finish before it is removed.
  await Promise.allSettled(children);
});

test('a git deadline carries EGITTIMEOUT, never the ETIMEDOUT the session transport reads as a dead daemon', async (t) => {
  setGitProcessRunner(() =>
    Promise.reject(
      Object.assign(new Error('git rev-parse --verify HEAD timed out after 60000ms'), { code: 'ETIMEDOUT' })
    )
  );
  t.after(() => setGitProcessRunner(null));
  const root = tmpdir();
  await assert.rejects(runRead(root, ['rev-parse', '--verify', 'HEAD']), { code: 'EGITTIMEOUT' });
  await assert.rejects(
    streamNulRecords(root, ['ls-files', '-z'], () => {}, { timeoutMs: 1 }),
    { code: 'EGITTIMEOUT' }
  );
  assert.equal(isGitTimeout(Object.assign(new Error('x'), { code: 'EGITTIMEOUT' })), true);
  assert.equal(isGitTimeout(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
});

test('a burst of off-thread git children never holds the event loop for a spawn', async (t) => {
  const root = repo(t);
  setGitProcessRunner(runProcessOffThread);
  t.after(() => setGitProcessRunner(null));
  await run(root, ['rev-parse', 'HEAD']).catch(() => {}); // warm the worker
  const gap = await maxLoopGap(() =>
    Promise.all(Array.from({ length: 16 }, () => run(root, ['status', '--porcelain=v2', '-z'])))
  );
  // In-thread, each CreateProcess blocks the loop (tens of ms idle, seconds
  // under load); off-thread none does.
  assert.ok(gap < 250, `16 concurrent git children held the loop ${Math.round(gap)}ms`);
});
