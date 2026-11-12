// Node's recordings of the desktop's session reads, replayed on the built `mixdogd` through the product's own protocol client
// (packages/protocol-client) over the core's real WebSocket listener. Each script compares what the desktop shows with the recording
// itself and exits 1 on any difference (benchmarks/rust-core/recorders/replay-*.mjs):
// - session-reentry-cases: an evicted session delivers new prompts and replies (reopen first or not), a delayed stored reply cannot
//   overwrite a newly materialized turn, no second read while the opening read is in flight, a held read shows its answer, a refused
//   read reaches the caller as the core's own error;
// - session-host-cold-refresh-cases: six open sessions, one rewritten by another client, shows the written one and no other;
// - session-lane-backlog-cases: a client whose stream is backed up still gets every frame, in order.
// The scripts start `mixdogd serve` themselves (lib/core-session.mjs `startCore`, a hidden window, the whole process tree ended on
// every path by the tree helper); this file hands them the binary and gives each run one deadline.
// Needs a built mixdogd (MIXDOGD_BIN) and the tree helper, which the rust-core job has after its build steps. Without them the
// tests FAIL: a skip would read as a pass.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const bin = process.env.MIXDOGD_BIN;
const RUN_LIMIT_MS = 240_000;

function replay(script) {
  assert.ok(bin, 'MIXDOGD_BIN is not set: the lane that runs this file (release-gate.yml, rust-core job) builds mixdogd and sets it');
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [`benchmarks/rust-core/recorders/${script}`, '--mixdogd', resolve(root, bin)],
      { cwd: root, windowsHide: true, timeout: RUN_LIMIT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? fail(new Error(`${script} found a difference from the recording (or did not end within ${RUN_LIMIT_MS} ms):\n${stdout}\n${stderr}`)) : done(stdout)),
    );
  });
}

test('an evicted session, a delayed stored reply and the reads show what Node showed', { timeout: RUN_LIMIT_MS + 5_000 }, async () => {
  await replay('replay-session-reentry.mjs');
});

test('the cold refresh shows a written session and no other, as Node showed', { timeout: RUN_LIMIT_MS + 5_000 }, async () => {
  await replay('replay-session-host-cold-refresh.mjs');
});

test('a backed-up stream still delivers every frame, as Node showed', { timeout: RUN_LIMIT_MS + 5_000 }, async () => {
  await replay('replay-session-lane-backlog.mjs');
});
