import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startCore, within } from './lib/core-session.mjs';
import { pidsOfExecutable, waitGone } from './lib/process-probe.mjs';

test('within fails with what did not finish, and passes a value that did', async () => {
  assert.equal(await within(Promise.resolve(7), 1000, 'x'), 7);
  await assert.rejects(within(new Promise(() => {}), 20, 'the thing'), /the thing did not finish within 20 ms/);
});

// Needs a built mixdogd (MIXDOGD_BIN), which the rust-core job has after its build step. Without it the tests FAIL: a skip
// would read as a pass in the lane. MIXDOG_TESTS_WITHOUT_CORE=1 is the explicit local opt-out; no lane sets it.
const bin = process.env.MIXDOGD_BIN;
const optOut = process.env.MIXDOG_TESTS_WITHOUT_CORE === '1' && 'MIXDOG_TESTS_WITHOUT_CORE=1: no mixdogd built';
const needBin = () => assert.ok(bin, 'MIXDOGD_BIN is not set: the lane that runs this file (release-gate.yml, rust-core job) builds mixdogd and sets it');

test('a stop that misses its deadline ends the child it started and throws the failure', { skip: optOut }, async () => {
  needBin();
  const root = mkdtempSync(join(tmpdir(), 'mixdog-core-session-test-'));
  const core = await startCore({ bin, root, config: {}, readyTimeoutMs: 60_000 });
  try {
    const members = await pidsOfExecutable(core.exe);
    assert.ok(members.length > 0, 'the running core is found by its staged executable');
    // 1 ms cannot cover the stop request and the exit: the failure path must kill the child and say so.
    await assert.rejects(core.stop({ timeoutMs: 1 }), /stopping the core failed/);
    for (const pid of members) await waitGone(pid);
  } finally {
    // A killed core's executable can stay locked for a moment on Windows; the directory is scratch.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error(`cleanup of ${root}: ${error.message}`);
    }
  }
});

test('a clean stop answers the exit of the core', { skip: optOut }, async () => {
  needBin();
  const root = mkdtempSync(join(tmpdir(), 'mixdog-core-session-test-'));
  const core = await startCore({ bin, root, config: {}, readyTimeoutMs: 60_000 });
  try {
    const members = await pidsOfExecutable(core.exe);
    assert.ok(members.length > 0, 'the running core is found by its staged executable');
    const exit = await core.stop();
    assert.ok('code' in exit && 'signal' in exit);
    for (const pid of members) await waitGone(pid);
  } finally {
    // A killed core's executable can stay locked for a moment on Windows; the directory is scratch.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error(`cleanup of ${root}: ${error.message}`);
    }
  }
});
