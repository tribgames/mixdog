import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LANES, commandOf, runChild, selectedTests } from './k1-lanes.mjs';

// Runs `cargo test -- --list`, so it compiles each lane's test binaries (set CARGO_TARGET_DIR to reuse a build).
test('every lane filter selects at least one test', { timeout: 3_600_000 }, async () => {
  for (const [name, lane] of Object.entries(LANES)) {
    for (const filter of lane.filters.length ? lane.filters : [null]) {
      assert.ok((await selectedTests(name, filter)).length > 0, `${name}: filter ${filter ?? '(all)'} selects no test`);
    }
  }
});

test('a filter that matches nothing selects nothing', { timeout: 3_600_000 }, async () => {
  assert.deepEqual(await selectedTests('advisory-lock', 'no_such_test_name_anywhere'), []);
});

test('a lane is one cargo run per filter on its package', () => {
  assert.deepEqual(commandOf('advisory-lock', 'cargo nextest run', 'x'), { program: 'cargo', args: ['nextest', 'run', '-p', 'mixdog-tools', '--locked', 'x'] });
  assert.deepEqual(commandOf('provider-contract').args, ['test', '-p', 'mixdog-ai', '--locked']);
});

// The command line itself: the patch-release job runs `k1-lanes.mjs patch-bytes`, which once ran every lane.
const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url)), '--dry-run', ...args], { encoding: 'utf8', timeout: 60_000 });
// `filter(Boolean)` drops only the empty line after the last newline; the Set folds a lane's several filters (one output line each) into the lane.
const lanesOf = (stdout) => [...new Set(stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')[0]))];

test('a named lane runs that lane only, whatever its position and with or without --runner', () => {
  assert.deepEqual(lanesOf(cli('patch-bytes').stdout), ['patch-bytes']);
  assert.deepEqual(lanesOf(cli('compact', 'patch-bytes').stdout), ['compact', 'patch-bytes']);
  assert.deepEqual(lanesOf(cli('--runner', 'cargo nextest run', 'compact').stdout), ['compact']);
  assert.deepEqual(lanesOf(cli('compact', '--runner', 'cargo nextest run', 'patch-bytes').stdout), ['compact', 'patch-bytes']);
  assert.match(cli('--runner', 'cargo nextest run', 'compact').stdout, /\tcargo nextest run -p mixdog-agent --locked compact_fresh\n/);
});

test('no lane named runs every lane, and an unknown lane or option fails', () => {
  assert.deepEqual(lanesOf(cli().stdout), Object.keys(LANES));
  const unknown = cli('no-such-lane');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown lane no-such-lane/);
  assert.notEqual(cli('--bogus').status, 0);
  assert.notEqual(cli('--runner').status, 0);
});

test('a lane that never finishes is ended at its deadline, with its whole process tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k1-lanes-test-'));
  try {
    // The child's setInterval is not a wait of the test: it is the hung process itself, and the test returns at runChild's 1500 ms deadline.
    const script = join(dir, 'hang.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    await assert.rejects(runChild('node', [script], { cwd: dir, deadlineMs: 1500 }), /did not finish within 1500ms and was ended/);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), 'the hung child is gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished child answers its status and output', async () => {
  const done = await runChild('node', ['--version'], { deadlineMs: 30_000 });
  assert.equal(done.status, 0);
  assert.match(done.stdout, /^v\d+/);
});

test('lanes are validated before --list runs: an unknown lane fails there too', () => {
  const run = cli('--list', 'no-such-lane');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unknown lane no-such-lane/);
  assert.equal(spawnSync(process.execPath, [fileURLToPath(new URL('./k1-lanes.mjs', import.meta.url)), '--list', 'compact'], { encoding: 'utf8', timeout: 60_000 }).status, 0);
});
