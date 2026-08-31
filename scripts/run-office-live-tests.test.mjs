import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const runner = fileURLToPath(new URL('./run-office-live-tests.mjs', import.meta.url));

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

  const run = (path) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [runner, path], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
  };
  const passed = run(passing);
  const failed = run(failing);

  assert.equal(passed.status, 0, passed.stdout || passed.stderr);
  assert.equal(failed.status, 1, failed.stdout || failed.stderr);
  assert.match(failed.stdout, /not ok 1 - synthetic fail/);
});
