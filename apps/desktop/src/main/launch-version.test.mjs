import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LAUNCH_VERSION_FILE, recordLaunchVersion } from './launch-version.ts';

async function withProfile(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-launch-version-'));
  try {
    await run(join(dir, LAUNCH_VERSION_FILE));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a first launch without the installer flag is not an update, and records the version', () =>
  withProfile(async (file) => {
    assert.equal(await recordLaunchVersion(file, '1.1.1', []), false);
    assert.equal(await readFile(file, 'utf8'), '1.1.1');
    assert.equal(await recordLaunchVersion(file, '1.1.1', []), false, 'a relaunch of the same version');
  }));

test('the NSIS relaunch after 1.1.0 -> 1.1.1 is an update even with no earlier record', () =>
  withProfile(async (file) => {
    assert.equal(await recordLaunchVersion(file, '1.1.1', ['Mixdog.exe', '--updated']), true);
    assert.equal(await readFile(file, 'utf8'), '1.1.1');
  }));

test('a recorded earlier version marks the launch as an update without the installer flag', () =>
  withProfile(async (file) => {
    await writeFile(file, '1.1.1\n');
    assert.equal(await recordLaunchVersion(file, '1.1.2', []), true);
    assert.equal(await readFile(file, 'utf8'), '1.1.2');
    assert.equal(await recordLaunchVersion(file, '1.1.2', []), false);
  }));
