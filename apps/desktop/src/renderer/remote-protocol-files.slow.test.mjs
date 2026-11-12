// The phone's files, editor and project-list adapter against a real mixdogd, every answer compared whole with what Node (b6f10295a) gave
// (apps/mobile/fixtures/phone-files/golden.json, recorded by benchmarks/rust-core/recorders/record-phone-files.mjs): the loopback scenario
// and the relay scenario (a paired phone behind a relay, held to the registered projects, with one-file permissions). The replay prints
// every difference and exits non-zero on any; the core binary is MIXDOGD_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const recorder = fileURLToPath(new URL('../../../../benchmarks/rust-core/recorders/record-phone-files.mjs', import.meta.url));
const BIN = process.env.MIXDOGD_BIN || 'D:\\mixdog-build\\pool\\w5-target\\debug\\mixdogd.exe';

// The runner's spawn ledger (--import scripts/lib/test-spawn-ledger.mjs) fails a script that exits through process.exit before its top-level
// evaluation settles, which is how the recorder ends its replay; the child needs the TypeScript loaders, not that guard.
const loaders = process.execArgv.flatMap((arg, at, all) => (/test-spawn-ledger/.test(arg) || /test-spawn-ledger/.test(all[at - 1] ?? '') || (arg === '--import' && /test-spawn-ledger/.test(all[at + 1] ?? '')) ? [] : [arg]));

test('phone files adapter replays the Node recording over a real core', () => {
  const child = spawnSync(process.execPath, [...loaders, recorder, '--replay', BIN], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(child.status, 0, `replay failed (${child.status}):\n${child.stdout.slice(-3000)}\n${child.stderr.slice(-2000)}`);
  assert.match(child.stdout, /phone-files main replay .*: \d+ compared, 0 unexpected/);
  assert.match(child.stdout, /phone-files relay replay .*: \d+ compared, 0 unexpected/);
});
