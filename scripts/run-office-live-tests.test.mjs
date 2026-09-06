import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildLiveTestPlan, liveProfiles } from './office-live-test-plan.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const runner = fileURLToPath(new URL('./run-office-live-tests.mjs', import.meta.url));

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runRunner(args) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: projectRoot,
    env: childEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('Office live test wrapper propagates TAP failures through its exit code', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-office-live-wrapper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const passing = join(directory, 'passing.mjs');
  const failing = join(directory, 'failing.mjs');
  await writeFile(
    passing,
    'import test from "node:test"; test("synthetic pass", () => {});\n',
    'utf8',
  );
  await writeFile(
    failing,
    'import assert from "node:assert/strict"; import test from "node:test"; test("synthetic fail", () => assert.fail("expected"));\n',
    'utf8',
  );

  const passed = runRunner([passing]);
  const failed = runRunner([failing]);

  assert.equal(passed.status, 0, passed.stdout || passed.stderr);
  assert.equal(failed.status, 1, failed.stdout || failed.stderr);
  assert.match(failed.stdout, /not ok 1 - synthetic fail/);
});

test('live profiles execute only their feature and retain all nine compatibility cases', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-office-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'profiles.mjs');
  const profiles = liveProfiles.filter((profile) => profile !== 'all');
  const kinds = ['docm', 'dotm', 'dotx', 'xltx', 'xltm', 'xlsm', 'pptm', 'potx', 'potm'];
  await writeFile(fixture, `
import test from 'node:test';
for (const feature of ${JSON.stringify(profiles)}) {
  test('[' + feature + '] fixture', async (t) => {
    console.log('EXECUTED:' + feature);
    if (feature === 'compat') {
      for (const kind of ${JSON.stringify(kinds)}) {
        await t.test(kind, () => console.log('KIND:' + kind));
      }
    }
  });
}
`);
  for (const profile of liveProfiles) {
    const plan = buildLiveTestPlan([profile], fixture);
    const result = spawnSync(process.execPath, plan.args, {
      env: childEnv(), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const executed = [...result.stdout.matchAll(/EXECUTED:(\w+)/gu)].map((match) => match[1]);
    assert.deepEqual(executed, profile === 'all' ? profiles : [profile]);
    const checkedKinds = [...result.stdout.matchAll(/KIND:(\w+)/gu)].map((match) => match[1]);
    assert.deepEqual(checkedKinds, ['all', 'compat'].includes(profile) ? kinds : []);
  }
});

test('live runner requires a scope, rejects invalid filters, and fails empty selections', async (t) => {
  for (const args of [[], ['--help']]) {
    const help = runRunner(args);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /실행 범위를 지정/);
    assert.doesNotMatch(help.stdout, /TAP version/);
  }
  for (const args of [['unknown'], ['author', 'extra'], ['fixture.mjs', '[']]) {
    const invalid = runRunner(args);
    assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(invalid.stdout, /TAP version/);
  }
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-office-filter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'filter.mjs');
  await writeFile(fixture, 'import test from "node:test"; test("chosen", () => {});');
  assert.equal(runRunner([fixture, '^chosen$']).status, 0);
  const missing = runRunner([fixture, '^absent$']);
  assert.notEqual(missing.status, 0, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /실행할 테스트가 없습니다/);
});

test('live runner forwards stdout and stderr before the test completes', { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-office-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'stream.mjs');
  const acknowledgement = join(directory, 'continue');
  await writeFile(fixture, `
import test from 'node:test';
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
test('streaming fixture', async () => {
  const watcher = watch(dirname(process.env.OFFICE_TEST_ACK));
  try {
    const changed = once(watcher, 'change');
    console.log('STDOUT_READY');
    console.error('STDERR_READY');
    await changed;
    console.log('ACKNOWLEDGED');
  } finally { watcher.close(); }
});
`);
  const child = spawn(process.execPath, [runner, fixture], {
    cwd: projectRoot,
    env: childEnv({ OFFICE_TEST_ACK: acknowledgement }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let acknowledged = false;
  let writeError;
  const acknowledge = (chunk) => {
    output += chunk;
    if (!acknowledged && output.includes('STDOUT_READY') && output.includes('STDERR_READY')) {
      acknowledged = true;
      // The fixture cannot finish until both markers reach the caller.
      void writeFile(acknowledgement, 'continue').catch((error) => {
        writeError = error;
        child.kill();
      });
    }
  };
  child.stdout.setEncoding('utf8').on('data', acknowledge);
  child.stderr.setEncoding('utf8').on('data', acknowledge);
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.ifError(writeError);
  assert.equal(status, 0, output);
  assert.equal(acknowledged, true);
  assert.match(output, /ACKNOWLEDGED/);
});
