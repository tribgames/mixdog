// When the automatic cookie import runs: once shortly after start (or opt-in)
// if Chrome is not running, and once per Chrome exit (an event, never polled);
// never while Chrome lives, one run at a time, only for the one bound profile,
// only once a key is saved for it, and not again after "needs one manual
// import". Fake timers, a fake Chrome-exit watch and a fake importer.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CookieAutoImporter,
  CookieAutoImportStateStore,
  START_DELAY_MS,
  watchChromeLock,
} from './profile-import-auto.ts';

const HOUR = 60 * 60_000;

/** One-shot timers that only move when the test says so. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const entries = new Map();
  return {
    timers: {
      setTimeout: (run, ms) => {
        const id = nextId++;
        entries.set(id, { run, due: now + ms });
        return id;
      },
      clearTimeout: (id) => entries.delete(id),
    },
    pending: () => entries.size,
    /** Advance time, running due timers in order; each run's async work settles before the next. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...entries.entries()].filter(([, entry]) => entry.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [id, entry] = due;
        now = entry.due;
        entries.delete(id);
        entry.run();
        await settle();
      }
      now = end;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function memoryState(initial = {}) {
  let state = initial;
  return {
    read: async () => ({ ...state }),
    update: async (patch) => {
      state = { ...state, ...patch };
      for (const key of Object.keys(state)) if (state[key] === undefined || state[key] === false) delete state[key];
    },
    peek: () => state,
  };
}

/** A key is saved and the bound profile ('Default' unless said otherwise) was imported with it. */
function setup({ saved = { enabled: false, profileId: '' }, chromeRunning = false, runOutcome, ready = ['Default', 'Profile 1', 'Profile 2'] } = {}) {
  const clock = manualTimers();
  const state = memoryState({ readyProfiles: ready });
  const calls = { run: [], settingsWrites: [], forgets: 0, errors: [], chromeChecks: 0, watches: 0, unwatches: 0 };
  const world = { chromeRunning, keySaved: true, keyAvailable: true, exit: null };
  let persisted = saved;
  const importer = new CookieAutoImporter({
    settings: {
      read: async () => persisted,
      write: async (next) => {
        calls.settingsWrites.push(next);
        persisted = next;
        return next;
      },
    },
    state,
    run: async (profileId) => {
      calls.run.push(profileId);
      return runOutcome ? await runOutcome(profileId) : { state: 'imported', count: 1 };
    },
    chromeRunning: async () => {
      calls.chromeChecks += 1;
      if (world.chromeRunning instanceof Error) throw world.chromeRunning;
      return world.chromeRunning;
    },
    watchChromeExit: (onExit, onStopped) => {
      calls.watches += 1;
      world.exit = onExit;
      world.stopped = onStopped;
      return () => {
        calls.unwatches += 1;
        world.exit = null;
      };
    },
    keyStatus: async () => ({ available: world.keyAvailable, saved: world.keySaved }),
    forgetKey: async () => {
      calls.forgets += 1;
      world.keySaved = false;
    },
    timers: clock.timers,
    onError: (error) => calls.errors.push(error),
  });
  /** Chrome exits: its lock file is gone. */
  const chromeExits = async () => {
    world.chromeRunning = false;
    world.exit?.();
    await settle();
  };
  return { importer, clock, state, calls, world, chromeExits };
}

const ON = { enabled: true, profileId: 'Default' };

test('turned off: nothing is scheduled or watched and nothing runs', async () => {
  const { importer, clock, calls } = setup();
  await importer.start();
  await settle();
  assert.equal(clock.pending(), 0);
  assert.equal(calls.watches, 0);
  await clock.advance(3 * HOUR);
  assert.deepEqual(calls.run, []);
  assert.equal((await importer.status()).enabled, false);
});

test('before a key is saved no run, process check or watch exists, however long it takes', async () => {
  for (const saved of [
    { enabled: true, profileId: '' },
    { enabled: true, profileId: 'Default' },
  ]) {
    const { importer, clock, calls, world, chromeExits } = setup({ saved, chromeRunning: true });
    world.keySaved = false;
    await importer.start();
    await clock.advance(START_DELAY_MS + 5 * HOUR);
    await chromeExits();
    assert.deepEqual(calls.run, [], 'no importer run');
    assert.equal(calls.chromeChecks, 0, 'no process check');
    assert.equal(calls.watches, 0, 'no watch');
    const status = await importer.status();
    assert.equal(status.needsManualImport, false, 'no "needs one manual import" yet');
    assert.equal(status.lastError, undefined);
  }
});

test('an import time without a saved key does not open the gate', async () => {
  // A manual import can succeed while saving its key fails: lastImportAt is set, no key exists.
  const { importer, clock, calls, world, state, chromeExits } = setup({ saved: ON, ready: [] });
  world.keySaved = false;
  await state.update({ lastImportAt: 1, lastCount: 3 });
  await importer.start();
  await clock.advance(START_DELAY_MS + HOUR);
  await chromeExits();
  assert.deepEqual(calls.run, []);
  assert.equal(calls.chromeChecks, 0);
  assert.equal(calls.watches, 0);
  const status = await importer.status();
  assert.equal(status.needsManualImport, false, 'silent, not "Needs one manual import"');
  assert.equal(status.lastError, undefined);
});

test('a saved key alone does not open the gate for a profile that was never imported with it', async () => {
  const { importer, clock, calls } = setup({ saved: { enabled: true, profileId: 'Profile 2' }, ready: ['Default'] });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.deepEqual(calls.run, []);
  assert.equal(calls.watches, 0);
});

test('with no profile bound yet nothing runs; the first manual import binds its profile, enabled stays as it was', async () => {
  const { importer, clock, calls } = setup({ saved: { enabled: true, profileId: '' }, ready: ['Work', 'Personal'] });
  await importer.start();
  await clock.advance(START_DELAY_MS + HOUR);
  assert.deepEqual(calls.run, [], 'no target, no run');
  assert.equal(calls.chromeChecks, 0);

  await importer.manualImportDone('Work');
  assert.deepEqual(calls.settingsWrites, [{ enabled: true, profileId: 'Work' }]);
  assert.equal((await importer.status()).profileId, 'Work');
  assert.equal(calls.watches, 1);

  // Profiles are renamed or reordered, another one is imported by hand: the target stays.
  await importer.manualImportDone('Personal');
  assert.equal(calls.settingsWrites.length, 1);
  assert.equal((await importer.status()).profileId, 'Work');
  await clock.advance(0);
  await importer.configure({ enabled: true, profileId: 'Work' });
  await clock.advance(0);
  assert.deepEqual(calls.run, ['Work']);
});

test('a manual import does not turn automatic import on', async () => {
  const { importer, calls } = setup({ saved: { enabled: false, profileId: '' } });
  await importer.start();
  await importer.manualImportDone('Default');
  assert.deepEqual(calls.settingsWrites, [{ enabled: false, profileId: 'Default' }]);
  assert.equal(calls.watches, 0, 'off: no watch');
});

test('a profile chosen in settings wins over a manual import of another', async () => {
  const { importer, calls } = setup({ saved: { enabled: true, profileId: 'Profile 1' } });
  await importer.start();
  await importer.manualImportDone('Default');
  assert.deepEqual(calls.settingsWrites, []);
  assert.equal((await importer.status()).profileId, 'Profile 1');
});

test('at app start it runs once, after the start delay, when Chrome is not running', async () => {
  const { importer, clock, calls } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS - 1);
  assert.deepEqual(calls.run, [], 'the app gets to finish starting first');
  await clock.advance(1);
  assert.deepEqual(calls.run, ['Default']);
  assert.equal(clock.pending(), 0, 'no timer is left behind');
});

test('hours pass with no Chrome exit: no run and no process check beyond the single one at start', async () => {
  const { importer, clock, calls } = setup({ saved: ON, chromeRunning: true });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.chromeChecks, 1);
  await clock.advance(48 * HOUR);
  assert.deepEqual(calls.run, []);
  assert.equal(calls.chromeChecks, 1, 'nothing checks the process list again');
  assert.deepEqual(calls.errors, []);
  assert.equal((await importer.status()).lastError, undefined, 'skipping is quiet');

  const closed = setup({ saved: ON });
  await closed.importer.start();
  await closed.clock.advance(START_DELAY_MS + 48 * HOUR);
  assert.equal(closed.calls.run.length, 1, 'the start run only: no hourly re-import');
  assert.equal(closed.calls.chromeChecks, 1);
});

test('Chrome running at start, then exiting, gives one run', async () => {
  const { importer, clock, calls, chromeExits } = setup({ saved: ON, chromeRunning: true });
  await importer.start();
  await clock.advance(START_DELAY_MS + 3 * HOUR);
  assert.deepEqual(calls.run, []);
  await chromeExits();
  assert.deepEqual(calls.run, ['Default']);
  await clock.advance(10 * HOUR);
  assert.equal(calls.run.length, 1);
});

test('one Chrome-exit event gives one run; each restart and exit gives one more', async () => {
  const { importer, clock, calls, world, chromeExits } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.run.length, 1, 'start run');
  world.chromeRunning = true; // Chrome launched
  await chromeExits();
  assert.equal(calls.run.length, 2, 'one exit, one run');
  await clock.advance(5 * HOUR);
  assert.equal(calls.run.length, 2);
  world.chromeRunning = true; // restarted
  await chromeExits();
  assert.equal(calls.run.length, 3);
  assert.equal(calls.watches, 1, 'one watch serves every exit');
});

test('an exit while Chrome is already running again (restart) does not run', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  world.chromeRunning = true;
  world.exit();
  await settle();
  assert.equal(calls.run.length, 1);
});

test('the watch is set up when the first manual import saves the key, without a restart', async () => {
  const { importer, clock, calls, world, state, chromeExits } = setup({
    saved: { enabled: true, profileId: '' },
    ready: [],
    chromeRunning: true,
  });
  world.keySaved = false;
  await importer.start();
  await clock.advance(START_DELAY_MS + HOUR);
  assert.equal(calls.watches, 0);
  // The manual import saves the key and records the profile as ready, then tells the importer.
  world.keySaved = true;
  await state.update({ readyProfiles: ['Work'] });
  await importer.manualImportDone('Work');
  assert.equal(calls.watches, 1);
  assert.equal(calls.chromeChecks, 0);
  await chromeExits();
  assert.deepEqual(calls.run, ['Work']);
});

test('an unreadable Chrome check is "cannot tell": no run, no error', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  world.chromeRunning = new Error('stat failed');
  await importer.start();
  await clock.advance(START_DELAY_MS);
  world.exit?.();
  await settle();
  assert.deepEqual(calls.run, []);
  assert.deepEqual(calls.errors, []);
});

test('a run whose Chrome check is still pending follows the setting as it is when the check ends', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  let chromeChecked;
  world.chromeRunning = new Promise((resolve) => {
    chromeChecked = resolve;
  });
  await clock.advance(START_DELAY_MS);
  await importer.configure({ enabled: false, profileId: 'Default' });
  chromeChecked(false);
  await settle();
  assert.deepEqual(calls.run, [], 'turned off while Chrome was checked: no import');

  world.chromeRunning = new Promise((resolve) => {
    chromeChecked = resolve;
  });
  await importer.configure(ON);
  await clock.advance(0);
  await importer.configure({ enabled: true, profileId: 'Profile 1' });
  chromeChecked(false);
  await settle();
  assert.deepEqual(calls.run, ['Profile 1'], 'switched while Chrome was checked: the new profile');
});

test('runs never overlap: an exit during a run joins it', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { importer, clock, calls, world } = setup({
    saved: ON,
    runOutcome: async () => {
      await gate;
      return { state: 'imported', count: 1 };
    },
  });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal((await importer.status()).running, true);
  world.exit();
  await settle();
  assert.equal(calls.run.length, 1, 'not alongside the running one');
  release();
  await settle();
  assert.equal(calls.run.length, 2, 'the exit is not lost: one more run follows');
  assert.equal((await importer.status()).running, false);
});

test('legacy state without a bound, imported profile shows no warning or error', async () => {
  // A state file from an earlier build: "needs one manual import" with no ready profile recorded.
  for (const saved of [
    { enabled: true, profileId: '' },
    { enabled: true, profileId: 'Default' },
  ]) {
    const { importer, state, world } = setup({ saved, ready: [] });
    world.keySaved = false;
    await state.update({ needsManualImport: true, lastError: 'old failure', lastImportAt: 7, lastCount: 2 });
    await importer.start();
    const status = await importer.status();
    assert.equal(status.needsManualImport, false);
    assert.equal(status.lastError, undefined);
  }
  // Once the profile did work, the same flags are real and shown.
  const { importer, state } = setup({ saved: ON });
  await state.update({ needsManualImport: true, lastError: 'real failure' });
  await importer.start();
  const status = await importer.status();
  assert.equal(status.needsManualImport, true);
  assert.equal(status.lastError, 'real failure');
});

test('legacy state with only an import time shows no status line until a ready import', async () => {
  const { importer, state, world } = setup({ saved: ON, ready: [] });
  world.keySaved = false;
  await state.update({ lastImportAt: 1_700_000_000_000, lastCount: 9 });
  await importer.start();
  const quiet = await importer.status();
  assert.equal(quiet.lastImportAt, undefined);
  assert.equal(quiet.lastCount, undefined);
  await state.update({ readyProfiles: ['Default'] });
  world.keySaved = true;
  const shown = await importer.status();
  assert.equal(shown.lastImportAt, 1_700_000_000_000);
  assert.equal(shown.lastCount, 9);
});

test('one watcher error leaves one registration and no live watcher, reported once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lockfile');
  writeFileSync(lock, '');
  const fake = fakeFolderWatch();
  let stopped = 0;
  const stop = watchChromeLock(lock, () => {}, () => (stopped += 1), fake.watchFn);
  fake.made[0].fail();
  fake.made[0].fail();
  assert.equal(fake.made.length, 1, 'nothing is re-armed from an error');
  assert.equal(fake.live().length, 0);
  assert.equal(stopped, 1);
  stop();
  assert.equal(stopped, 1, 'a stop requested afterwards is not reported');
});

test('a parent (recovery) watcher error also stops for good', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'User Data');
  mkdirSync(folder);
  const lock = join(folder, 'lockfile');
  writeFileSync(lock, '');
  const fake = fakeFolderWatch();
  let stopped = 0;
  watchChromeLock(lock, () => {}, () => (stopped += 1), fake.watchFn);
  rmSync(folder, { recursive: true });
  fake.live()[0].listener('rename', folder);
  const parent = fake.live().find((w) => w.path === dir);
  assert.ok(parent);
  parent.fail();
  mkdirSync(folder); // the folder returns, but nobody is told
  assert.equal(fake.live().length, 0);
  assert.equal(fake.made.length, 2);
  assert.equal(stopped, 1);
});

test('repeated identical events followed by errors never register more than once per arm', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lockfile');
  writeFileSync(lock, '');
  const fake = fakeFolderWatch();
  watchChromeLock(lock, () => {}, undefined, fake.watchFn);
  for (let i = 0; i < 5; i += 1) fake.made[0].listener('change', 'Local State');
  for (let i = 0; i < 5; i += 1) fake.made[0].fail();
  assert.equal(fake.made.length, 1);
  assert.equal(fake.live().length, 0);
});

test('after a watcher error, a successful manual import creates exactly one live watcher', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.watches, 1);
  world.stopped(); // the watcher died on its own
  world.exit = null;
  await importer.manualImportDone('Default');
  assert.equal(calls.watches, 2);
  assert.equal(calls.unwatches, 0, 'the dead one is not closed twice');
  await importer.manualImportDone('Default');
  assert.equal(calls.watches, 2, 'a live one is not duplicated');
  importer.stop();
  assert.equal(calls.unwatches, 1);
});

test('a late "stopped" from an old watcher does not clear a newer one', async () => {
  const { importer, calls, world } = setup({ saved: ON });
  await importer.start();
  await settle();
  const oldStopped = world.stopped;
  await importer.configure({ enabled: false, profileId: 'Default' });
  await importer.configure(ON);
  await settle();
  assert.equal(calls.watches, 2);
  oldStopped();
  await importer.manualImportDone('Default');
  assert.equal(calls.watches, 2, 'the newer watcher is still the live one');
});

test('after "needs one manual import" exits do not run until that is cleared', async () => {
  const { importer, clock, calls, state, chromeExits } = setup({
    saved: ON,
    runOutcome: async () => {
      await state.update({ needsManualImport: true });
      return { state: 'needs-manual-import' };
    },
  });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.run.length, 1);
  assert.equal((await importer.status()).needsManualImport, true);
  await chromeExits();
  assert.equal(calls.run.length, 1, 'no further attempts, so no repeated work');
  await state.update({ needsManualImport: false });
  await chromeExits();
  assert.equal(calls.run.length, 2);
});

test('turning it on persists the setting and runs at once; a failure in a run is reported, not thrown', async () => {
  const { importer, clock, calls, state } = setup({
    runOutcome: async () => {
      throw new Error('boom');
    },
  });
  await importer.start();
  await state.update({ needsManualImport: true });
  const status = await importer.configure(ON);
  assert.deepEqual(calls.settingsWrites, [ON]);
  assert.equal(status.enabled, true);
  assert.equal(status.needsManualImport, false, 'opting in again retries from scratch');
  await clock.advance(0);
  assert.deepEqual(calls.run, ['Default']);
  assert.equal(calls.errors.length, 1);
});

test('turning it off or switching profile re-arms; off leaves no timer and no watch', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.deepEqual(calls.run, ['Default']);
  await importer.configure({ enabled: false, profileId: 'Default' });
  assert.equal(clock.pending(), 0);
  assert.equal(world.exit, null, 'the watch is closed');
  await clock.advance(3 * HOUR);
  assert.equal(calls.run.length, 1);
  await importer.configure({ enabled: true, profileId: 'Profile 2' });
  await clock.advance(0);
  assert.deepEqual(calls.run, ['Default', 'Profile 2']);
  assert.ok(world.exit, 'watching again');
});

test('stopping cancels the start deadline and the watch', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  await settle();
  assert.equal(clock.pending(), 1);
  assert.ok(world.exit);
  importer.stop();
  assert.equal(clock.pending(), 0);
  assert.equal(world.exit, null);
  await clock.advance(5 * HOUR);
  assert.deepEqual(calls.run, []);
});

test('forgetting the key closes the watch and asks for one manual import only if automatic import is on and a key existed', async () => {
  const on = setup({ saved: ON });
  await on.importer.start();
  await settle();
  assert.ok(on.world.exit);
  const afterForget = await on.importer.forgetKey();
  assert.equal(on.calls.forgets, 1);
  assert.equal(afterForget.keySaved, false);
  assert.equal(afterForget.needsManualImport, true);
  assert.equal(on.world.exit, null);

  const off = setup();
  await off.importer.start();
  assert.equal((await off.importer.forgetKey()).needsManualImport, false);

  const none = setup({ saved: ON });
  none.world.keySaved = false;
  await none.importer.start();
  assert.equal((await none.importer.forgetKey()).needsManualImport, false);
});

test('the status shows the setting, the key, the last import and the last error', async () => {
  const { importer, state, world } = setup({ saved: ON });
  await importer.start();
  await state.update({ lastImportAt: 1_700_000_000_000, lastCount: 42, lastError: 'Chrome data decryption failed.' });
  world.keyAvailable = false;
  assert.deepEqual(await importer.status(), {
    enabled: true,
    profileId: 'Default',
    keySaved: true,
    keyStorageAvailable: false,
    running: false,
    lastImportAt: 1_700_000_000_000,
    lastCount: 42,
    lastError: 'Chrome data decryption failed.',
    needsManualImport: false,
  });
});

test('the state file keeps only the status fields and the ready profiles, and survives a bad file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-auto-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new CookieAutoImportStateStore(join(dir, 'state.json'));
  assert.deepEqual(await store.read(), {});
  await store.update({ lastImportAt: 5, lastCount: 3, needsManualImport: true });
  await store.update({ needsManualImport: false, lastError: 'x' });
  await store.markReady('Work');
  await store.markReady('Work');
  await store.markReady('Personal');
  assert.deepEqual(await store.read(), {
    lastImportAt: 5,
    lastCount: 3,
    lastError: 'x',
    readyProfiles: ['Work', 'Personal'],
  });
  await store.clear();
  assert.deepEqual(await store.read(), {});
});

test('watchChromeLock reports the lock file being removed, once, and nothing else in the folder', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lockfile');
  let exits = 0;
  const stop = watchChromeLock(lock, () => {
    exits += 1;
  });
  t.after(() => stop?.());
  assert.ok(stop);
  writeFileSync(lock, ''); // Chrome launched
  writeFileSync(join(dir, 'Local State'), '{}');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(exits, 0);
  rmSync(lock); // Chrome exited
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(exits, 1);
  rmSync(join(dir, 'Local State'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(exits, 1);
  assert.equal(watchChromeLock(join(dir, 'missing', 'lockfile'), () => {}), undefined);
});

test('on the real file system, deleting and recreating the watched folder keeps the next exit detectable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'User Data');
  mkdirSync(folder);
  const lock = join(folder, 'lockfile');
  writeFileSync(lock, '');
  let exits = 0;
  const stop = watchChromeLock(lock, () => {
    exits += 1;
  });
  t.after(() => stop?.());
  const pause = () => new Promise((resolve) => setTimeout(resolve, 400));
  rmSync(folder, { recursive: true });
  await pause();
  assert.equal(exits, 1, 'the folder vanishing with the lock held is an exit');
  mkdirSync(folder);
  writeFileSync(lock, '');
  await pause();
  rmSync(lock);
  await pause();
  assert.equal(exits, 2, 'the recreated folder is watched again');
});

/** A folder watcher the test drives: events, errors, and every watch ever made. */
function fakeFolderWatch() {
  const made = [];
  const watchFn = (path, _options, listener) => {
    const handlers = {};
    const watcher = {
      path,
      listener,
      closed: false,
      on: (event, handler) => {
        handlers[event] = handler;
        return watcher;
      },
      close: () => {
        watcher.closed = true;
      },
      fail: () => handlers.error?.(new Error('EPERM')),
    };
    if (!existsSync(path)) throw new Error('ENOENT');
    made.push(watcher);
    return watcher;
  };
  return { watchFn, made, live: () => made.filter((w) => !w.closed) };
}

test('a removal notification without a file name still reports the exit, once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lockfile');
  writeFileSync(lock, '');
  const fake = fakeFolderWatch();
  let exits = 0;
  watchChromeLock(lock, () => (exits += 1), undefined, fake.watchFn);
  const [watcher] = fake.made;
  watcher.listener('change', null); // unrelated, lock still there
  assert.equal(exits, 0);
  rmSync(lock);
  watcher.listener('rename', null);
  watcher.listener('rename', null);
  assert.equal(exits, 1, 'an unnamed removal counts, a repeat does not');
  watcher.listener('rename', 'Local State');
  assert.equal(exits, 1);
  writeFileSync(lock, ''); // Chrome again
  watcher.listener('rename', null);
  rmSync(lock);
  watcher.listener('rename', 'LOCKFILE');
  assert.equal(exits, 2);
});

test('a deleted watched folder is awaited through its parent and re-attached when it returns; unrelated errors never re-arm', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'User Data');
  mkdirSync(folder);
  const lock = join(folder, 'lockfile');
  writeFileSync(lock, '');
  const fake = fakeFolderWatch();
  let exits = 0;
  const stop = watchChromeLock(lock, () => (exits += 1), undefined, fake.watchFn);

  rmSync(lock);
  fake.live()[0].listener('rename', 'lockfile');
  assert.equal(exits, 1);
  writeFileSync(lock, '');
  fake.live()[0].listener('rename', 'lockfile');

  // The folder itself is deleted while Chrome ran (Windows names the event with the folder's path):
  // that is an exit, and the parent is watched.
  rmSync(folder, { recursive: true });
  fake.live()[0].listener('rename', folder);
  assert.equal(exits, 2);
  const parent = fake.live().find((w) => w.path === dir);
  assert.ok(parent, 'the parent waits for the folder to come back');
  mkdirSync(folder);
  writeFileSync(lock, ''); // Chrome relaunched into the recreated folder
  parent.listener('rename', 'User Data');
  assert.equal(parent.closed, true);
  const reattached = fake.live().find((w) => w.path === folder);
  assert.ok(reattached, 'the folder is watched again');
  rmSync(lock);
  reattached.listener('rename', 'lockfile');
  assert.equal(exits, 3, 'the next exit is seen');
  stop();
  assert.equal(fake.live().length, 0);
});

