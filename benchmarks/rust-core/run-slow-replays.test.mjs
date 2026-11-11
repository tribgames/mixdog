// The runner ends what a test started and nothing else, and settles a run by its deadline whatever the ending did.
//   node --test benchmarks/rust-core/run-slow-replays.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runTest } from './run-slow-replays.mjs';
import { suspendProcess } from './recorders/lib/suspend-process.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'slow-replay-runner-'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('what a test left running is ended and fails the run; a process that only names its folder is not touched', { timeout: 120_000 }, async () => {
  const dir = folder();
  const kidFile = join(dir, 'kid.pid');
  // Not started by the test: it names the test's folder and the runner's own file.
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', dir, kidFile], { stdio: 'ignore', windowsHide: true });
  try {
    // The test starts a detached process that stays (outside the job Node keeps for its children) and exits.
    const leaves = `const kid = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', detached: true, windowsHide: true }); require('fs').writeFileSync(${JSON.stringify(kidFile)}, String(kid.pid)); kid.unref();`;
    const result = await runTest({ name: 'leaves', log: join(dir, 'leaves.log'), command: process.execPath, args: ['-e', leaves], cwd: dir, env: process.env, answerMs: 5_000 });
    assert.deepEqual(result.problems, ['left running: 1 process(es), ended with its job']);
    const kid = Number(readFileSync(kidFile, 'utf8'));
    assert.ok(!alive(kid), `the process the test left (pid ${kid}) still runs`);
    assert.ok(alive(decoy.pid), `the decoy (pid ${decoy.pid}) was ended`);
  } finally {
    decoy.kill();
  }
});

test('the deadline settles the run within its ending\'s own deadline when the job\'s guard stops answering', { timeout: 120_000 }, async () => {
  const dir = folder();
  const answerMs = 3_000;
  let gone = null;
  let started = null;
  const result = await runTest({
    name: 'hangs',
    log: join(dir, 'hangs.log'),
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1e9)'],
    cwd: dir,
    env: process.env,
    deadlineMs: 2_000,
    answerMs,
    started: ({ job, child }) => {
      gone = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
      suspendProcess(job.pid);
      started = Date.now();
    },
  });
  const took = Date.now() - started;
  assert.equal(result.problems[0], 'deadline of 2 s');
  assert.match(result.problems.join('\n'), /ending its job: /);
  // The test's deadline, then the ending's: no more (timers fire a little late, never early; the margin is for that).
  assert.ok(took <= 2_000 + 4 * answerMs + 1_000, `the run settled after ${took} ms`);
  // The guard was ended by force, which closed the job: the test ends with it.
  let timer;
  await Promise.race([gone, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('the test still runs 10 s after its job was closed')), 10_000)))]).finally(() => clearTimeout(timer));
});
