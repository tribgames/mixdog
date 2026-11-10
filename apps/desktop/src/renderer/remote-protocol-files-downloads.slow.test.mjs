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
  const match = child.stdout.match(/file-downloads replay .*: \d+ calls compared, \d+ held calls, \d+ handle counts, (\d+) asset ids sent past the adapter, 0 unexpected, not run on this system: (.*)/);
  assert.ok(match, child.stdout.slice(-2000));
  // The ids Node's table refuses (`a b`, empty, 129 characters) also reach the core straight, which must refuse them as Node did.
  assert.equal(Number(match[1]), 3, 'every refused asset id of the recording was sent past the adapter');
  // Where a scenario was recorded for this system none is left out; elsewhere exactly the scenarios recorded on Windows alone are.
  // The attachment world needs a stored turn the spawned core cannot make (see WORLD_GAPS of the replay).
  assert.deepEqual(JSON.parse(match[2]), process.platform === 'win32' ? ['attachments'] : ['attachments', 'windows path names']);
});

test('a replay whose setup fails before the core starts leaves no work folder', async () => {
  const { readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { replayDownloads } = await import('../../../../benchmarks/rust-core/recorders/lib/file-downloads-replay.mjs');
  const folders = () => readdirSync(tmpdir()).filter((name) => name.startsWith('downloads-replay-'));
  const before = folders();
  await assert.rejects(replayDownloads({ exe: BIN, recording: { scenarios: [] }, failSetup: true }), /the setup failed on purpose after making (.+)/);
  assert.deepEqual(folders(), before, 'the work folder is removed when the setup throws');
});

