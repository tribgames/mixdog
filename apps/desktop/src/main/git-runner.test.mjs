import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runProcessOffThread } from '../../../../src/runtime/shared/process-runner.mjs';
import { run, runWithInput, runWithStatus, setGitProcessRunner, streamNulRecords } from './git-runner.ts';

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
