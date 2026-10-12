import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { peekWhatsNew } from '../renderer/settings/whats-new.ts';
import { acknowledgeAnnouncement, LAUNCH_VERSION_FILE, recordLaunchVersion } from './launch-version.ts';

const unexpectedFailure = (error) => assert.fail(`unexpected write failure: ${error}`);
const launch = (file, version, argv = []) => recordLaunchVersion(file, version, argv, unexpectedFailure);
const record = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function withProfile(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-launch-version-'));
  try {
    await run(join(dir, LAUNCH_VERSION_FILE), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a first launch without the installer flag is not an update, and records the version', () =>
  withProfile(async (file) => {
    assert.equal(await launch(file, '1.1.1'), false);
    assert.deepEqual(await record(file), { lastLaunched: '1.1.1' });
    assert.equal(await launch(file, '1.1.1'), false, 'a relaunch of the same version');
  }));

test('the NSIS relaunch after 1.1.0 -> 1.1.1 is an update even with no earlier record', () =>
  withProfile(async (file) => {
    assert.equal(await launch(file, '1.1.1', ['Mixdog.exe', '--updated']), true);
    assert.deepEqual(await record(file), { lastLaunched: '1.1.1', pendingAnnouncement: '1.1.1' });
  }));

test('an update launch that fails to show the notice still announces on the next ordinary launch', () =>
  withProfile(async (file) => {
    await writeFile(file, '1.1.0\n'); // the first, bare form of the record
    // Launch 1: the update; localStorage was lost and the notice never renders.
    const storage = new Map();
    const local = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    assert.equal(await launch(file, '1.1.1'), true);
    assert.equal(peekWhatsNew(local, '1.1.1', true), 'pending');
    // Launch 2: no flag, same version, nothing acknowledged yet.
    assert.equal(await launch(file, '1.1.1'), true, 'still pending');
    assert.equal(peekWhatsNew(local, '1.1.1', true), 'pending');
    assert.equal(storage.size, 0, 'not mistaken for a fresh install');
  }));

test('acknowledging the shown notice retires the pending announcement', () =>
  withProfile(async (file) => {
    assert.equal(await launch(file, '1.2.1', ['--updated']), true);
    await acknowledgeAnnouncement(file, '1.2.0', unexpectedFailure);
    assert.equal((await record(file)).pendingAnnouncement, '1.2.1', 'another version cannot retire it');
    await acknowledgeAnnouncement(file, '1.2.1', unexpectedFailure);
    assert.deepEqual(await record(file), { lastLaunched: '1.2.1' });
    assert.equal(await launch(file, '1.2.1'), false);
  }));

test('only a strictly newer version is an update; a downgrade announces nothing', () =>
  withProfile(async (file) => {
    await launch(file, '1.1.2', ['--updated']);
    assert.equal(await launch(file, '1.1.1', ['--updated']), false, 'downgrade, even when the installer says updated');
    assert.deepEqual(await record(file), { lastLaunched: '1.1.1' }, 'the newer pending notice is dropped');
    assert.equal(await launch(file, '1.1.10'), true, 'numeric, not lexical, comparison');
    await writeFile(file, JSON.stringify({ lastLaunched: '1.2.0' }));
    assert.equal(await launch(file, '1.2.0-beta.1'), false, 'a prerelease of the same version is older');
  }));

test('a downgrade announces nothing in main or the renderer, and keeps the newer seen mark', () =>
  withProfile(async (file) => {
    const storage = new Map([['mixdog.desktop.whats-new-seen-version', '1.3.0']]);
    const local = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    await writeFile(file, JSON.stringify({ lastLaunched: '1.3.0' }));
    const afterUpdate = await launch(file, '1.2.9', ['--updated']);
    assert.equal(afterUpdate, false);
    assert.equal(peekWhatsNew(local, '1.2.9', afterUpdate), 'downgrade');
    assert.equal(storage.get('mixdog.desktop.whats-new-seen-version'), '1.3.0');
    // Back on 1.3.0: it was already announced, so nothing repeats.
    const reUpgrade = await launch(file, '1.3.0');
    assert.equal(reUpgrade, true, 'main sees an update');
    assert.equal(peekWhatsNew(local, '1.3.0', reUpgrade), 'current', 'the kept mark says it was shown');
  }));

test('a record that cannot be written is reported and the launch goes on', () =>
  withProfile(async (_file, dir) => {
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, '');
    const failures = [];
    const unwritable = join(blocker, LAUNCH_VERSION_FILE);
    assert.equal(
      await recordLaunchVersion(unwritable, '1.1.1', ['--updated'], (error) => failures.push(error)),
      true,
      'this launch still announces'
    );
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof Error);
  }));
