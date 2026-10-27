import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneStaleTempDirs, removeTempDirSync, STALE_TEMP_MS } from './stale-temp.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-stale-temp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function dirAged(root, name, ageMs) {
  const dir = join(root, name);
  await mkdir(join(dir, 'nested'), { recursive: true });
  await writeFile(join(dir, 'nested', 'file'), 'x');
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
}

test('the sweep removes stale dirs of the given prefixes and nothing else', async (t) => {
  const root = await tempRoot(t);
  await dirAged(root, 'mixdog-a-old', STALE_TEMP_MS + DAY_MS);
  await dirAged(root, 'mixdog-b-old', STALE_TEMP_MS + DAY_MS);
  await dirAged(root, 'mixdog-a-fresh', DAY_MS);
  await dirAged(root, 'unrelated-old', STALE_TEMP_MS + DAY_MS);
  pruneStaleTempDirs(['mixdog-a-', 'mixdog-b-'], { root });
  assert.deepEqual((await readdir(root)).sort(), ['mixdog-a-fresh', 'unrelated-old']);
});

test('removing a dir reports whether it is gone and accepts one that is already missing', async (t) => {
  const root = await tempRoot(t);
  const dir = await dirAged(root, 'victim', 0);
  assert.equal(removeTempDirSync(dir), true);
  assert.equal(existsSync(dir), false);
  assert.equal(removeTempDirSync(dir), true);
});

for (const [label, module, prefix] of [
  ['isolated-test-env', './isolated-test-env.mjs', 'mixdog-test-profile-'],
  ['test-data-dir', '../test-data-dir.mjs', 'mixdog-test-data-'],
]) {
  test(`${label} sweeps stale leftovers at start and removes its own dir at exit`, async (t) => {
    const root = await tempRoot(t);
    await dirAged(root, `${prefix}stale`, STALE_TEMP_MS + DAY_MS);
    await dirAged(root, `${prefix}fresh`, DAY_MS);
    const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
    delete env.MIXDOG_TEST_DATA_DIR_OWNED;
    const probe = `await import(${JSON.stringify(new URL(module, import.meta.url).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(root), [`${prefix}fresh`]);
  });
}
