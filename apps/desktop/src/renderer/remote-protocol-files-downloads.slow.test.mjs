// The phone's five download calls, every call of Node's recording (native/core/fixtures/file-downloads, b6f10295a) sent through the router
// and the files adapter over a paired phone's relay connection to a real mixdogd, each reply compared whole and in order with Node's frame.
// The replay prints every difference and exits non-zero on any; the core binary is MIXDOGD_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const recorder = fileURLToPath(new URL('../../../../benchmarks/rust-core/recorders/record-file-downloads.mjs', import.meta.url));
const BIN = process.env.MIXDOGD_BIN || 'D:\\mixdog-build\\pool\\w25-target\\debug\\mixdogd.exe';

test('the files adapter replays every call of the downloads recording over a real core', () => {
  const child = spawnSync(process.execPath, [...process.execArgv, recorder, '--replay', BIN], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  assert.equal(child.status, 0, `replay failed (${child.status}):\n${child.stdout.slice(-6000)}\n${child.stderr.slice(-2000)}`);
  const match = child.stdout.match(/file-downloads replay .*: \d+ calls compared, \d+ held calls, \d+ handle counts, 0 unexpected, not run on this system: (.*)/);
  assert.ok(match, child.stdout.slice(-2000));
  // Where a scenario was recorded for this system none is left out; elsewhere exactly the scenarios recorded on Windows alone are.`n  assert.deepEqual(JSON.parse(match[1]), process.platform === 'win32' ? [] : ['windows path names']);
});

