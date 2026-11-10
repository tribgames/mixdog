// The phone's settings, updater, notification and feedback adapter against a real mixdogd, every case compared whole with what Node
// (b6f10295a) gave (apps/mobile/fixtures/phone-settings/golden.json, recorded by benchmarks/rust-core/recorders/record-phone-settings.mjs):
// the frame, the PC window's requests, the events the phone heard, the feedback posts and the state. The core binary is MIXDOGD_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const recorder = fileURLToPath(new URL('../../../../benchmarks/rust-core/recorders/record-phone-settings.mjs', import.meta.url));
const BIN = process.env.MIXDOGD_BIN || 'D:\\mixdog-build\\pool\\w3-target\\debug\\mixdogd.exe';

// The recorder is a script that ends with `process.exit` inside its top-level evaluation, which the runner's spawn ledger fails as
// dropped tests; it is not a test file, so it runs without the ledger.
const execArgv = process.execArgv.filter((arg, index, all) => !arg.includes('test-spawn-ledger') && !all[index + 1]?.includes('test-spawn-ledger'));

test('phone settings adapter replays the Node recording over a real core', () => {
  const child = spawnSync(process.execPath, [...execArgv, recorder, '--replay', BIN], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(child.status, 0, `replay failed (${child.status}):\n${child.stdout.slice(-3000)}\n${child.stderr.slice(-2000)}`);
  assert.match(child.stdout, /phone-settings replay .*: \d+ cases compared, 0 differ/);
});
