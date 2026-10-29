// Runs scripts/gate-local.mjs from a stubbed checkout (every build and check
// command is a no-op; the test runner stand-in lists one file per lane and
// runs nothing), with its temp root pointed at a private directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

async function stubbedCheckout(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-gate-local-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts', 'lib'), { recursive: true });
  await mkdir(join(root, 'apps', 'desktop'), { recursive: true });
  await copyFile(join(here, 'gate-local.mjs'), join(root, 'scripts', 'gate-local.mjs'));
  for (const name of ['gate-scheduler.mjs', 'gate-timing-reporter.mjs', 'stale-temp.mjs'])
    await copyFile(join(here, 'lib', name), join(root, 'scripts', 'lib', name));
  for (const name of ['build-shipped-history', 'check-changelog-locales', 'check-model-recommendations'])
    await writeFile(join(root, 'scripts', `${name}.mjs`), '');
  // Stand-in for scripts/test.mjs: `--list` prints one file of the selected
  // lane in the real runner's `<lane> <file>` form, so every lane gets a
  // shard; running a shard passes without running anything.
  await writeFile(
    join(root, 'scripts', 'test.mjs'),
    [
      "const slow = process.argv.includes('slow');",
      "if (process.argv.includes('--list')) console.log(slow ? 'slow  stub.slow.test.mjs' : 'fast  stub.test.mjs');",
    ].join('\n')
  );
  const noop = 'node -e 0';
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        'build:spawn:test': noop,
        test: 'node scripts/test.mjs',
        'test:slow': 'node scripts/test.mjs --lane slow',
        'smoke:patch': noop,
      },
    })
  );
  await writeFile(
    join(root, 'apps', 'desktop', 'package.json'),
    JSON.stringify({
      scripts: {
        build: noop,
        test: 'node ../../scripts/test.mjs',
        'test:slow': 'node ../../scripts/test.mjs --lane slow',
        'test:daemon:e2e': noop,
      },
    })
  );
  return root;
}

function runGate(root, tempRoot) {
  // The stub checkout is no git work tree, and no enclosing one may stand in
  // for it: the gate then keeps no timing history anywhere.
  const env = {
    ...process.env,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    GIT_CEILING_DIRECTORIES: dirname(root),
  };
  delete env.MIXDOG_TEST_CONCURRENCY;
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'gate-local.mjs')], {
      cwd: root,
      env,
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

async function aged(dir, ageMs) {
  await mkdir(dir);
  await writeFile(join(dir, 'file'), 'x');
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
}

test('concurrent gate runs keep separate log dirs, and a start sweeps only stale gate dirs', async (t) => {
  const root = await stubbedCheckout(t);
  const tempRoot = await mkdtemp(join(tmpdir(), 'mixdog-gate-local-temp-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await aged(join(tempRoot, 'mixdog-gate-local-stale'), 4 * DAY_MS);
  await aged(join(tempRoot, 'mixdog-gate-resources-stale'), 4 * DAY_MS);
  await aged(join(tempRoot, 'mixdog-gate-local-fresh'), DAY_MS);

  const runs = await Promise.all([runGate(root, tempRoot), runGate(root, tempRoot)]);
  const logDirs = runs.map((run) => {
    assert.equal(run.code, 0, run.stdout);
    return /logs: (.+)$/m.exec(run.stdout)[1];
  });
  assert.notEqual(logDirs[0], logDirs[1]);
  for (const [index, run] of runs.entries()) {
    // Every summary line names a log inside this run's own directory, and it
    // exists: one per lane (four test lanes, shipped-history, desktop).
    const printed = [...run.stdout.matchAll(/^PASS {2}\S+ {2}\S+ \(.+?\) {2}(.+)$/gm)].map((match) => match[1]);
    assert.equal(printed.length, 6, run.stdout);
    const names = await readdir(logDirs[index]);
    assert.equal(names.length, 6);
    for (const path of printed)
      assert.ok(path.startsWith(logDirs[index]) && names.includes(path.split(/[\\/]/).at(-1)));
  }
  // Stale gate dirs are gone; the fresh one, both runs' log dirs remain, and
  // the per-run resources dirs were removed by their runs.
  assert.deepEqual(
    (await readdir(tempRoot)).filter((name) => name.startsWith('mixdog-gate-')).sort(),
    ['mixdog-gate-local-fresh', ...logDirs.map((dir) => dir.split(/[\\/]/).at(-1))].sort()
  );
});
