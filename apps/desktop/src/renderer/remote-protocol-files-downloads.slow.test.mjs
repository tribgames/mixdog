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
  assert.match(child.stdout, /file-downloads replay .*: \d+ calls compared, \d+ held calls and \d+ handle counts proved by the workspace crate's transfer::replay, 0 unexpected/);
});
